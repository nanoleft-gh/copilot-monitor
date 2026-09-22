import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, it } from 'node:test';
import { applyPatch, Patch } from '../stateDelta';
import { StateStreamHub, ViewerSummary, WatchTarget } from '../stateStream';

interface Frame { event: string; id?: string; data: unknown }

/** Duck-typed ServerResponse that records frames and can simulate backpressure. */
class FakeResponse extends EventEmitter {
	readonly frames: Frame[] = [];
	writable = true;
	ended = false;

	writeHead(): this { return this; }
	flushHeaders(): void { /* no-op */ }
	end(): void { this.ended = true; }

	write(chunk: string): boolean {
		for (const raw of chunk.split('\n\n').filter(Boolean)) {
			if (raw.startsWith(':')) {
				continue;
			}
			const lines = raw.split('\n');
			this.frames.push({
				event: lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message',
				id: lines.find(line => line.startsWith('id: '))?.slice(4),
				data: JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6)),
			});
		}
		return this.writable;
	}

	/** Replays received frames the way a client would, returning the reconstructed state. */
	reconstruct(): unknown {
		let state: unknown;
		for (const frame of this.frames) {
			if (frame.event === 'snapshot' || frame.event === 'state') {
				state = frame.data;
			} else if (frame.event === 'patch') {
				state = applyPatch(state, frame.data as Patch);
			}
		}
		return state;
	}
}

function openClient(hub: StateStreamHub<unknown>, protocol: 1 | 2, countsAsViewer = true, watch?: WatchTarget[]) {
	const request = new EventEmitter();
	const response = new FakeResponse();
	hub.open(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse, { protocol, countsAsViewer, ...(watch ? { watch } : {}) });
	return { request, response, close: () => request.emit('close') };
}

describe('StateStreamHub', () => {
	it('detects changes even when the backend mutates its state object in place', () => {
		const state = { version: 1, turns: [{ id: 'a', text: 'x' }] };
		const hub = new StateStreamHub<unknown>(() => state);
		const { response } = openClient(hub, 2);
		assert.equal(response.frames[0].event, 'snapshot');

		state.turns[0].text += 'y'; // same array, same object
		hub.broadcast(state);
		assert.equal(response.frames.length, 2);
		assert.equal(response.frames[1].event, 'patch');
		assert.deepEqual(response.reconstruct(), state);

		hub.broadcast(state); // nothing changed → nothing sent
		assert.equal(response.frames.length, 2);
	});

	it('shares one patch between clients at the same generation and sends full states to v1 clients', () => {
		let state: unknown = { version: 1, items: [{ id: '1', n: 0 }] };
		const hub = new StateStreamHub<unknown>(() => state);
		const a = openClient(hub, 2);
		const b = openClient(hub, 2);
		const legacy = openClient(hub, 1);
		state = { version: 1, items: [{ id: '1', n: 1 }, { id: '2', n: 0 }] };
		hub.broadcast(state);
		assert.deepEqual(a.response.frames[1], b.response.frames[1]);
		assert.equal(a.response.frames[1].id, '2');
		assert.equal(legacy.response.frames[1].event, 'state');
		assert.deepEqual(legacy.response.frames[1].data, state);
		assert.deepEqual(a.response.reconstruct(), state);
	});

	it('coalesces while a socket is waiting for drain and sends one catch-up patch', () => {
		let state: unknown = { version: 1, text: 'a', list: [{ id: 'x', v: 1 }] };
		const hub = new StateStreamHub<unknown>(() => state);
		const slow = openClient(hub, 2);
		const fast = openClient(hub, 2);

		slow.response.writable = false;
		state = { version: 1, text: 'ab', list: [{ id: 'x', v: 1 }] };
		hub.broadcast(state); // written (write returns false → now waiting for drain)
		state = { version: 1, text: 'abc', list: [{ id: 'x', v: 2 }] };
		hub.broadcast(state); // skipped for slow
		state = { version: 1, text: 'abcd', list: [{ id: 'x', v: 2 }, { id: 'y', v: 0 }] };
		hub.broadcast(state); // skipped for slow
		assert.equal(slow.response.frames.length, 2);
		assert.equal(fast.response.frames.length, 4);

		slow.response.writable = true;
		slow.response.emit('drain');
		assert.equal(slow.response.frames.length, 3, 'one catch-up frame for two missed generations');
		assert.deepEqual(slow.response.reconstruct(), state);
		assert.deepEqual(fast.response.reconstruct(), state);
	});

	it('reports viewer counts only for viewer streams and stops diffing when nobody listens', () => {
		const counts: number[] = [];
		let state: unknown = { version: 1, n: 0 };
		const hub = new StateStreamHub<unknown>(() => state, { onDidChangeViewers: viewers => counts.push(viewers.count) });
		const relay = openClient(hub, 2, false);
		assert.deepEqual(counts, []);
		const viewer = openClient(hub, 1, true);
		assert.deepEqual(counts, [1]);
		viewer.close();
		assert.deepEqual(counts, [1, 0]);
		relay.close();
		assert.equal(hub.size, 0);

		state = { version: 1, n: 1 };
		hub.broadcast(state); // no listeners: no generation kept
		const late = openClient(hub, 2, false);
		assert.equal(late.response.frames[0].event, 'snapshot');
		assert.deepEqual(late.response.frames[0].data, state);
		hub.closeAll();
		assert.equal(late.response.ended, true);
	});

	it('unions watch targets across viewers and drops them the moment a stream closes', () => {
		const seen: ViewerSummary[] = [];
		const hub = new StateStreamHub<unknown>(() => ({ version: 1 }), { onDidChangeViewers: viewers => seen.push(viewers) });
		const phone = openClient(hub, 2, true, [{ windowId: 'w1', sessionResource: 'chat://a' }]);
		const dashboard = openClient(hub, 2, true, [{ windowId: 'w2', sessionResource: 'chat://b' }, { windowId: 'w1', sessionResource: 'chat://a' }]);
		assert.deepEqual(seen.at(-1), { count: 2, watched: [{ windowId: 'w1', sessionResource: 'chat://a' }, { windowId: 'w2', sessionResource: 'chat://b' }] });
		phone.close();
		assert.deepEqual(seen.at(-1)?.watched, [{ windowId: 'w2', sessionResource: 'chat://b' }, { windowId: 'w1', sessionResource: 'chat://a' }]);
		dashboard.close();
		assert.deepEqual(seen.at(-1), { count: 0, watched: [] });
	});

	it('parses watch query values with and without a window id', () => {
		assert.deepEqual(StateStreamHub.watchFromQuery(['w1|vscode-chat://x/abc', 'vscode-chat://y/def', '']), [
			{ windowId: 'w1', sessionResource: 'vscode-chat://x/abc' },
			{ sessionResource: 'vscode-chat://y/def' },
		]);
		assert.equal(StateStreamHub.watchFromQuery(Array.from({ length: 20 }, (_, index) => `w|s${index}`)).length, 8, 'bounded');
	});
});
