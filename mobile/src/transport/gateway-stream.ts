import type { GatewaySnapshot, HostProfile } from './types';
import { fetchGatewaySnapshot, parseGatewaySnapshot } from './gateway-client';
import { applyPatch, isPatch } from './state-delta';

type StreamHandlers = {
  onSnapshot: (snapshot: GatewaySnapshot) => void;
  onStatus?: (status: 'connecting' | 'live' | 'offline') => void;
};

const reconnectDelayMs = 1_500;

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
 */
export function subscribeToGateway(host: HostProfile, handlers: StreamHandlers): () => void {
  let closed = false;
  let request: XMLHttpRequest | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let processedLength = 0;
  let buffer = '';
  let recycling = false;
  // Raw (unparsed) gateway state the next patch applies to; undefined until a snapshot arrives.
  let base: unknown;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    handlers.onStatus?.('connecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void fetchGatewaySnapshot(host)
        .then(snapshot => {
          if (!closed) handlers.onSnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!closed) connect();
        });
    }, reconnectDelayMs);
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
      xhr.onreadystatechange = () => {
        if (recycling || xhr !== request) return;
        if (xhr.readyState >= 3 && typeof xhr.responseText === 'string') {
          const fresh = xhr.responseText.slice(processedLength);
          processedLength = xhr.responseText.length;
          if (fresh) handleChunk(fresh);
          if (processedLength >= responseTextResetBytes) {
            recycle();
            return;
          }
        }
        if (xhr.readyState === 4 && !closed) {
          scheduleReconnect();
        }
      };
      xhr.onerror = () => { if (!closed) scheduleReconnect(); };
      xhr.send();
    } catch {
      scheduleReconnect();
    }
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    handlers.onStatus?.('offline');
    try {
      request?.abort();
    } catch {
      // The request may already be closed.
    }
  };
}
