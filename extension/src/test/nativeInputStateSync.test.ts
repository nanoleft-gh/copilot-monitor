import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NativeInputStateSync, NativeInputStateTimerScheduler, NativeInputStateWatcher } from '../nativeInputStateSync';

class ManualScheduler implements NativeInputStateTimerScheduler {
	private now = 0;
	private nextId = 1;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	advance(delayMs: number): void {
		const target = this.now + delayMs;
		while (true) {
			const next = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!next) {
				break;
			}
			this.tasks.delete(next[0]);
			this.now = next[1].at;
			next[1].callback();
		}
		this.now = target;
	}
}

class FakeWatcher implements NativeInputStateWatcher {
	disposed = false;
	dispose(): void { this.disposed = true; }
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('NativeInputStateSync', () => {
	it('debounces watcher bursts into one refresh', async () => {
		const scheduler = new ManualScheduler();
		let onChange = () => {};
		let refreshes = 0;
		const sync = new NativeInputStateSync({
			scheduler,
			refresh: async () => { refreshes++; },
			createWatcher: change => { onChange = change; return new FakeWatcher(); },
		});
		sync.start();
		scheduler.advance(0);
		await flushPromises();
		assert.equal(refreshes, 1);

		onChange();
		scheduler.advance(50);
		onChange();
		scheduler.advance(74);
		assert.equal(refreshes, 1);
		scheduler.advance(1);
		await flushPromises();
		assert.equal(refreshes, 2);
		sync.dispose();
	});

	it('never overlaps reads and coalesces events during a read', async () => {
		const scheduler = new ManualScheduler();
		let onChange = () => {};
		let resolveRead = () => {};
		let running = 0;
		let maximumRunning = 0;
		let refreshes = 0;
		const sync = new NativeInputStateSync({
			scheduler,
			refresh: () => {
				refreshes++;
				running++;
				maximumRunning = Math.max(maximumRunning, running);
				return new Promise<void>(resolve => { resolveRead = () => { running--; resolve(); }; });
			},
			createWatcher: change => { onChange = change; return new FakeWatcher(); },
		});
		sync.start();
		scheduler.advance(0);
		onChange();
		onChange();
		resolveRead();
		await flushPromises();
		scheduler.advance(75);
		assert.equal(refreshes, 2);
		assert.equal(maximumRunning, 1);
		resolveRead();
		await flushPromises();
		sync.dispose();
	});

	it('never polls while watched and only polls slowly when watching fails', async () => {
		const scheduler = new ManualScheduler();
		let refreshes = 0;
		const watched = new NativeInputStateSync({
			scheduler,
			refresh: async () => { refreshes++; },
			createWatcher: () => new FakeWatcher(),
		});
		watched.start();
		scheduler.advance(0);
		await flushPromises();
		scheduler.advance(10 * 60_000);
		await flushPromises();
		assert.equal(refreshes, 1);
		watched.dispose();

		const fallbackScheduler = new ManualScheduler();
		let fallbackRefreshes = 0;
		const fallback = new NativeInputStateSync({
			scheduler: fallbackScheduler,
			refresh: async () => { fallbackRefreshes++; },
			createWatcher: () => { throw new Error('unavailable'); },
		});
		fallback.start();
		fallbackScheduler.advance(0);
		await flushPromises();
		fallbackScheduler.advance(29_999);
		assert.equal(fallbackRefreshes, 1);
		fallbackScheduler.advance(1);
		await flushPromises();
		assert.equal(fallbackRefreshes, 2);
		fallback.dispose();
	});

	it('stop() releases the watcher and start() attaches again', async () => {
		const scheduler = new ManualScheduler();
		const watchers: FakeWatcher[] = [];
		let refreshes = 0;
		const sync = new NativeInputStateSync({
			scheduler,
			refresh: async () => { refreshes++; },
			createWatcher: () => { const watcher = new FakeWatcher(); watchers.push(watcher); return watcher; },
		});
		sync.start();
		scheduler.advance(0);
		await flushPromises();
		sync.stop();
		assert.equal(watchers[0].disposed, true);
		sync.start();
		scheduler.advance(0);
		await flushPromises();
		assert.equal(watchers.length, 2);
		assert.equal(refreshes, 2);
		sync.dispose();
	});

	it('falls back after watcher errors and recovers on retry', async () => {
		const scheduler = new ManualScheduler();
		const firstWatcher = new FakeWatcher();
		let onError = () => {};
		let watcherAttempts = 0;
		let refreshes = 0;
		const sync = new NativeInputStateSync({
			scheduler,
			refresh: async () => { refreshes++; },
			createWatcher: (_change, error) => {
				onError = error;
				watcherAttempts++;
				return watcherAttempts === 1 ? firstWatcher : new FakeWatcher();
			},
		});
		sync.start();
		scheduler.advance(0);
		await flushPromises();
		onError();
		assert.equal(firstWatcher.disposed, true);
		// Watcher retry after 5 s; the slow fallback poll runs once at 30 s and then stops
		// because the watcher is back.
		scheduler.advance(4_999);
		assert.equal(watcherAttempts, 1);
		scheduler.advance(1);
		assert.equal(watcherAttempts, 2);
		scheduler.advance(24_999);
		assert.equal(refreshes, 1);
		scheduler.advance(1);
		await flushPromises();
		assert.equal(refreshes, 2);
		scheduler.advance(120_000);
		await flushPromises();
		assert.equal(refreshes, 2);
		sync.dispose();
	});

	it('stops pending work when disposed', async () => {
		const scheduler = new ManualScheduler();
		const watcher = new FakeWatcher();
		let onChange = () => {};
		let refreshes = 0;
		const sync = new NativeInputStateSync({
			scheduler,
			refresh: async () => { refreshes++; },
			createWatcher: change => { onChange = change; return watcher; },
		});
		sync.start();
		scheduler.advance(0);
		await flushPromises();
		onChange();
		sync.dispose();
		scheduler.advance(2_000);
		await flushPromises();
		assert.equal(refreshes, 1);
		assert.equal(watcher.disposed, true);
	});
});