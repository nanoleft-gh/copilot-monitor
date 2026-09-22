import type * as http from 'node:http';
import { applyPatch, diffValue, Patch } from './stateDelta';

/**
 * Server-Sent Events fan-out for state snapshots.
 *
 * Protocol 1 sends the whole state as `event: state` on every change (the original wire
 * format). Protocol 2 sends one `event: snapshot` when the stream opens and afterwards only
 * `event: patch` deltas relative to the last frame that client received (see `stateDelta.ts`).
 *
 * The hub keeps its own **independent copy** of the latest state (a *generation*), advanced by
 * applying the very patch it sends. Backends are therefore free to mutate their state objects
 * in place — the diff always compares against what clients really hold, never against aliased
 * live objects. Every client at the newest generation shares one patch string and one state
 * copy; a client that fell behind while its socket was waiting for `drain` gets a single
 * catch-up patch computed from the generation it last received (deltas compose).
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

interface Generation {
	readonly number: number;
	/** Independent copy of the state (never aliases backend objects). */
	readonly state: unknown;
	/** Patch that turns the previous generation into this one, serialized. */
	readonly patchFromPrevious: string | undefined;
	/** Lazily computed full serialization for snapshots and protocol-1 frames. */
	serialized?: string;
}

class Client implements StreamClient {
	waitingForDrain = false;
	/** Set while waiting for drain and a newer generation exists. */
	pending = false;
	received: Generation | undefined;
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
	private latest: Generation | undefined;

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
			this.advance(this.getState());
			this.send(client);
		}
		if (options.countsAsViewer) {
			this.notifyViewers();
		}
		return client;
	}

	broadcast(state: TState): void {
		let hasStateClients = false;
		for (const client of this.clients) {
			if (client.options.protocol !== 'none') {
				hasStateClients = true;
				break;
			}
		}
		if (!hasStateClients) {
			// Nobody is listening: do not diff; the next stream starts from a fresh snapshot.
			this.latest = undefined;
			return;
		}
		if (!this.advance(state)) {
			return;
		}
		for (const client of this.clients) {
			if (client.options.protocol !== 'none') {
				this.send(client);
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
		this.latest = undefined;
		if (hadViewers) {
			this.notifyViewers();
		}
	}

	/** Records `state` as a new generation. Returns false when it equals the latest one. */
	private advance(state: TState): boolean {
		if (!this.latest) {
			const serialized = JSON.stringify(state);
			this.latest = { number: 1, state: JSON.parse(serialized) as unknown, patchFromPrevious: undefined, serialized };
			return true;
		}
		const patch = diffValue(this.latest.state, state);
		if (!patch) {
			return false;
		}
		const serialized = JSON.stringify(patch);
		this.latest = {
			number: this.latest.number + 1,
			state: applyPatch(this.latest.state, JSON.parse(serialized) as Patch),
			patchFromPrevious: serialized,
		};
		return true;
	}

	private send(client: Client): void {
		const latest = this.latest;
		if (!latest || client.received === latest) {
			return;
		}
		if (client.waitingForDrain) {
			client.pending = true;
			return;
		}
		const frame = this.frameFor(client, latest);
		client.received = latest;
		if (client.response.write(frame)) {
			return;
		}
		client.waitingForDrain = true;
		client.response.once('drain', () => {
			if (!this.clients.has(client)) {
				return;
			}
			client.waitingForDrain = false;
			if (client.pending) {
				client.pending = false;
				this.send(client);
			}
		});
	}

	private frameFor(client: Client, latest: Generation): string {
		if (client.options.protocol === 1) {
			return `event: state\ndata: ${this.serialize(latest)}\n\n`;
		}
		client.sequence++;
		const received = client.received;
		if (!received) {
			return `event: snapshot\nid: ${client.sequence}\ndata: ${this.serialize(latest)}\n\n`;
		}
		const patch = received.number === latest.number - 1 && latest.patchFromPrevious !== undefined
			? latest.patchFromPrevious
			// Fell behind by more than one generation: one catch-up patch from what it last received.
			: JSON.stringify(diffValue(received.state, latest.state) ?? ['=', latest.state]);
		return `event: patch\nid: ${client.sequence}\ndata: ${patch}\n\n`;
	}

	private serialize(generation: Generation): string {
		generation.serialized ??= JSON.stringify(generation.state);
		return generation.serialized;
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
