import type { GatewaySnapshot, HostProfile } from './types';
import { parseGatewaySnapshot } from './gateway-client';

type StreamHandlers = {
  onSnapshot: (snapshot: GatewaySnapshot) => void;
  onStatus?: (status: 'connecting' | 'live' | 'offline') => void;
};

const reconnectDelayMs = 1_500;

// React Native's XMLHttpRequest retains the full response text for the life of
// the request. On a long-lived SSE stream that text grows without bound (every
// state snapshot and heartbeat is appended), and each `onreadystatechange` then
// pays an O(n) cost to slice the fresh tail. Left unchecked this degrades into
// O(n^2) work and the UI grows progressively laggier the longer a screen stays
// open. Because every `state` frame is a complete snapshot, we can safely drop
// the connection once the buffer crosses this cap and immediately reconnect;
// the gateway re-sends current state on connect, so no data is lost.
const responseTextResetBytes = 256 * 1024;

/**
 * Subscribes to the gateway's Server-Sent Events stream (`/api/events`).
 *
 * React Native has no native `EventSource`, so this consumes the stream through
 * `XMLHttpRequest`, which exposes the response text as it arrives. Each `state`
 * event carries a full gateway snapshot, giving the UI real-time updates instead
 * of the previous 2s polling loop.
 */
export function subscribeToGateway(host: HostProfile, handlers: StreamHandlers): () => void {
  let closed = false;
  let request: XMLHttpRequest | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let processedLength = 0;
  let buffer = '';
  let recycling = false;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    handlers.onStatus?.('connecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
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
      const dataLines = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      try {
        const snapshot = parseGatewaySnapshot(JSON.parse(dataLines.join('\n')));
        handlers.onStatus?.('live');
        handlers.onSnapshot(snapshot);
      } catch {
        // Ignore heartbeats and malformed frames.
      }
    }
  };

  const connect = () => {
    if (closed) return;
    processedLength = 0;
    buffer = '';
    recycling = false;
    handlers.onStatus?.('connecting');
    const xhr = new XMLHttpRequest();
    request = xhr;
    try {
      xhr.open('GET', new URL('/api/events', host.endpoint).toString());
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
