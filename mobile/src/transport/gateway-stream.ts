import * as Network from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';
import type { GatewaySnapshot, HostProfile } from './types';
import { fetchGatewaySnapshot, GatewayHttpError, parseGatewaySnapshot } from './gateway-client';
import { authHeaders } from './pairing';
import { applyPatch, isPatch } from './state-delta';

export type StreamStatus = 'connecting' | 'live' | 'offline' | 'unpaired';

type StreamHandlers = {
  onSnapshot: (snapshot: GatewaySnapshot) => void;
  onStatus?: (status: StreamStatus) => void;
};

/** Reconnect delays after consecutive failures; the last value repeats. A little jitter avoids thundering herds. */
const reconnectDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** The gateway comments the stream every 15 s; silence beyond this means the socket died without telling us. */
const staleAfterMs = 45_000;

// React Native's XMLHttpRequest retains the full response text for the life of
// the request. On a long-lived SSE stream that text grows without bound (every
// frame and heartbeat is appended), and each `onreadystatechange` then pays an
// O(n) cost to slice the fresh tail. Left unchecked this degrades into O(n^2)
// work and the UI grows progressively laggier the longer a screen stays open.
// Every connection starts with a complete snapshot, so we can safely drop the
// connection once the buffer crosses this cap and immediately reconnect; no
// data is lost. With v2 patches the buffer grows far slower than it used to.
const responseTextResetBytes = 256 * 1024;

/**
 * Subscribes to the gateway's Server-Sent Events stream (`/api/events?v=2`).
 *
 * React Native has no native `EventSource`, so this consumes the stream through
 * `XMLHttpRequest`, which exposes the response text as it arrives. The gateway
 * sends one `snapshot` frame and then compact `patch` frames that are applied to
 * the previous state (see `state-delta.ts`); older gateways answer with full
 * `state` frames, which are accepted as-is. A patch that cannot be applied means
 * the stream is out of sync, and the fix is simply to reconnect for a snapshot.
 *
 * Connection loss is survived without user action: reconnects back off
 * exponentially, a silent socket is detected through the gateway's keepalives,
 * and a network change or the app returning to the foreground retries at once.
 * Before each retry the host is re-located, so a new IP, a different Wi-Fi, or
 * the computer's remote (tunnel) address are all picked up automatically.
 */
export function subscribeToGateway(host: HostProfile, handlers: StreamHandlers): () => void {
  let closed = false;
  let request: XMLHttpRequest | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnecting = false;
  let failures = 0;
  let processedLength = 0;
  let buffer = '';
  let recycling = false;
  // Raw (unparsed) gateway state the next patch applies to; undefined until a snapshot arrives.
  let base: unknown;

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (staleTimer) clearTimeout(staleTimer);
    reconnectTimer = undefined;
    staleTimer = undefined;
  };

  const armStaleTimer = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = undefined;
      if (!closed) recycle();
    }, staleAfterMs);
  };

  // Re-locate the host, push a fresh snapshot, then reopen the stream.
  const reconnectNow = () => {
    if (closed || reconnecting) return;
    reconnecting = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    handlers.onStatus?.('connecting');
    void fetchGatewaySnapshot(host)
      .then(snapshot => {
        if (!closed) handlers.onSnapshot(snapshot);
      })
      .catch(error => {
        if (error instanceof GatewayHttpError && error.status === 401) handlers.onStatus?.('unpaired');
      })
      .finally(() => {
        reconnecting = false;
        if (!closed) connect();
      });
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer || reconnecting) return;
    handlers.onStatus?.('connecting');
    const delay = reconnectDelaysMs[Math.min(failures, reconnectDelaysMs.length - 1)];
    failures++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      reconnectNow();
    }, delay + Math.random() * delay * 0.25);
  };

  // Tear down and immediately reopen the connection to release the accumulated
  // responseText. Skips the reconnect backoff since this is a healthy recycle.
  const recycle = () => {
    if (closed || recycling) return;
    recycling = true;
    try {
      request?.abort();
    } catch {
      // Already closed.
    }
    connect();
  };

  const handleChunk = (text: string) => {
    buffer += text;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = frame.split('\n');
      const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
      const dataLines = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      try {
        const payload: unknown = JSON.parse(dataLines.join('\n'));
        if (eventName === 'patch') {
          if (base === undefined || !isPatch(payload)) throw new Error('patch without a snapshot');
          base = applyPatch(base, payload);
        } else if (eventName === 'snapshot') {
          base = payload;
        } else if (eventName === 'state') {
          base = undefined;
        } else {
          continue;
        }
        const snapshot = parseGatewaySnapshot(eventName === 'state' ? payload : base);
        failures = 0;
        handlers.onStatus?.('live');
        handlers.onSnapshot(snapshot);
      } catch {
        // Out of sync or malformed: start over with a fresh snapshot.
        base = undefined;
        recycle();
        return;
      }
    }
  };

  const connect = () => {
    if (closed) return;
    processedLength = 0;
    buffer = '';
    base = undefined;
    recycling = false;
    handlers.onStatus?.('connecting');
    const xhr = new XMLHttpRequest();
    request = xhr;
    try {
      xhr.open('GET', new URL('/api/events?v=2', host.endpoint).toString());
      xhr.setRequestHeader('Accept', 'text/event-stream');
      for (const [name, value] of Object.entries(authHeaders(host))) xhr.setRequestHeader(name, value);
      xhr.onreadystatechange = () => {
        if (recycling || xhr !== request) return;
        if (xhr.readyState >= 3 && typeof xhr.responseText === 'string') {
          // Any byte, including a keepalive comment, proves the socket is alive.
          armStaleTimer();
          const fresh = xhr.responseText.slice(processedLength);
          processedLength = xhr.responseText.length;
          if (fresh) handleChunk(fresh);
          if (processedLength >= responseTextResetBytes) {
            recycle();
            return;
          }
        }
        if (xhr.readyState === 4 && !closed) {
          if (staleTimer) clearTimeout(staleTimer);
          staleTimer = undefined;
          if (xhr.status === 401) {
            handlers.onStatus?.('unpaired');
            failures = reconnectDelaysMs.length;
          }
          scheduleReconnect();
        }
      };
      xhr.onerror = () => { if (!closed) scheduleReconnect(); };
      xhr.send();
    } catch {
      scheduleReconnect();
    }
  };

  // A pending backoff wait is pointless once the network or the app's foreground state changes.
  const nudge = () => {
    if (closed || reconnecting || !reconnectTimer) return;
    failures = 0;
    reconnectNow();
  };
  const appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') nudge();
  });
  const networkSubscription = typeof Network.addNetworkStateListener === 'function'
    ? Network.addNetworkStateListener(state => {
      if (state.isConnected !== false) nudge();
    })
    : undefined;

  connect();

  return () => {
    closed = true;
    clearTimers();
    appStateSubscription.remove();
    networkSubscription?.remove();
    handlers.onStatus?.('offline');
    try {
      request?.abort();
    } catch {
      // The request may already be closed.
    }
  };
}
