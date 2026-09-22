import type * as http from 'node:http';
import { diffValue } from './stateDelta';

/**
 * Server-Sent Events fan-out for state snapshots.
 *
 * Protocol 1 sends the whole state as `event: state` on every change (the original wire
 * format). Protocol 2 sends one `event: snapshot` when the stream opens and afterwards only
 * `event: patch` deltas relative to the last frame that client received (see `stateDelta.ts`).
 *
 * Backpressure: while a socket is waiting for `drain`, further states are not queued; the
 * newest one is remembered and, once writable again, a single frame bridges the gap (for
 * protocol 2 the patch is computed against the last frame actually sent, so deltas compose).
 *
 * The keepalive timer exists only while at least one stream is open.
 */

export type StreamProtocol = 1 | 2 | 'none';

export interface StreamClientOptions {
	readonly protocol: StreamProtocol;
	/** Whether this stream represents a person looking at the data (drives viewer gating). */
	readonly countsAsViewer: boolean;
}

export interface StreamClient {
	readonly options: StreamClientOptions;
	/** Writes a raw SSE frame (used for protocol-specific hello messages). */
	write(frame: string): void;
}

export interface StateStreamHubOptions {
	readonly keepaliveIntervalMs?: number;
	readonly onDidChangeViewerCount?: (count: number) => void;
}

class Client implements StreamClient {
	waitingForDrain = false;
	pending: unknown;
	lastSent: unknown;
	sequence = 0;

	constructor(
		readonly response: http.ServerResponse,
		readonly options: StreamClientOptions,
	) {}

	write(frame: string): void {
		this.response.write(frame);
	}
}

export class StateStreamHub<TState> {
	private readonly clients = new Set<Client>();
	private keepaliveTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly getState: () => TState,
		private readonly options: StateStreamHubOptions = {},
	) {}

	get size(): number {
		return this.clients.size;
	}

	get viewerCount(): number {
		let count = 0;
		for (const client of this.clients) {
			if (client.options.countsAsViewer) {
				count++;
			}
		}
		return count;
	}

	/** Parses `?v=` into a protocol; unknown values fall back to protocol 1. */
	static protocolFromQuery(value: string | null): 1 | 2 {
		return value === '2' ? 2 : 1;
	}

	open(request: http.IncomingMessage, response: http.ServerResponse, options: StreamClientOptions): StreamClient {
		response.writeHead(200, {
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'Content-Type': 'text/event-stream; charset=utf-8',
			'X-Accel-Buffering': 'no',
		});
		response.flushHeaders();
		const client = new Client(response, options);
		this.clients.add(client);
		this.syncKeepalive();
		request.on('close', () => {
			if (this.clients.delete(client)) {
				this.syncKeepalive();
				if (options.countsAsViewer) {
					this.notifyViewers();
				}
			}
		});
		if (options.protocol !== 'none') {
			this.send(client, this.getState());
		}
		if (options.countsAsViewer) {
			this.notifyViewers();
		}
		return client;
	}

	broadcast(state: TState): void {
		const cache = new Map<unknown, string>();
		for (const client of this.clients) {
			if (client.options.protocol !== 'none') {
				this.send(client, state, cache);
			}
		}
	}

	closeAll(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
		const hadViewers = this.viewerCount > 0;
		for (const client of this.clients) {
			client.response.end();
		}
		this.clients.clear();
		if (hadViewers) {
			this.notifyViewers();
		}
	}

	private send(client: Client, state: TState, cache?: Map<unknown, string>): void {
		if (client.waitingForDrain) {
			client.pending = state;
			return;
		}
		const frame = this.frameFor(client, state, cache);
		if (frame === undefined) {
			return;
		}
		client.lastSent = state;
		if (client.response.write(frame)) {
			return;
		}
		client.waitingForDrain = true;
		client.response.once('drain', () => {
			if (!this.clients.has(client)) {
				return;
			}
			client.waitingForDrain = false;
			const pending = client.pending as TState | undefined;
			client.pending = undefined;
			if (pending !== undefined) {
				this.send(client, pending);
			}
		});
	}

	/**
	 * Returns the SSE frame that brings `client` from its last frame to `state`, or `undefined`
	 * when there is nothing to send. `cache` memoises serialisations shared by clients that are
	 * at the same base state within one broadcast.
	 */
	private frameFor(client: Client, state: TState, cache?: Map<unknown, string>): string | undefined {
		if (client.options.protocol === 1) {
			const cached = cache?.get(v1Key);
			const serialized = cached ?? JSON.stringify(state);
			cache?.set(v1Key, serialized);
			return `event: state\ndata: ${serialized}\n\n`;
		}
		client.sequence++;
		if (client.lastSent === undefined) {
			const cached = cache?.get(snapshotKey);
			const serialized = cached ?? JSON.stringify(state);
			cache?.set(snapshotKey, serialized);
			return `event: snapshot\nid: ${client.sequence}\ndata: ${serialized}\n\n`;
		}
		let serialized = cache?.get(client.lastSent);
		if (serialized === undefined) {
			const patch = diffValue(client.lastSent, state);
			serialized = patch ? JSON.stringify(patch) : '';
			cache?.set(client.lastSent, serialized);
		}
		if (serialized === '') {
			client.sequence--;
			return undefined;
		}
		return `event: patch\nid: ${client.sequence}\ndata: ${serialized}\n\n`;
	}

	private syncKeepalive(): void {
		if (this.clients.size === 0) {
			if (this.keepaliveTimer) {
				clearInterval(this.keepaliveTimer);
				this.keepaliveTimer = undefined;
			}
			return;
		}
		if (this.keepaliveTimer) {
			return;
		}
		this.keepaliveTimer = setInterval(() => {
			for (const client of this.clients) {
				if (!client.waitingForDrain) {
					client.response.write(': keepalive\n\n');
				}
			}
		}, this.options.keepaliveIntervalMs ?? 15_000);
		this.keepaliveTimer.unref();
	}

	private notifyViewers(): void {
		this.options.onDidChangeViewerCount?.(this.viewerCount);
	}
}

const v1Key = Symbol('v1');
const snapshotKey = Symbol('snapshot');
