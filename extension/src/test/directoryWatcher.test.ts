import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DirectoryEvent, DirectoryWatcher } from '../directoryWatcher';

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for watcher events.');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

describe('DirectoryWatcher', () => {
	let root: string;
	const watchers: DirectoryWatcher[] = [];

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-watch-'));
	});

	afterEach(async () => {
		for (const watcher of watchers.splice(0)) {
			watcher.dispose();
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	it('reports file names changed inside an existing directory', async () => {
		const events: DirectoryEvent[] = [];
		const watcher = new DirectoryWatcher(root, event => events.push(event));
		watchers.push(watcher);
		watcher.start();
		assert.equal(watcher.watching, root);

		await fs.writeFile(path.join(root, 'a.jsonl'), 'x\n');
		await waitFor(() => events.some(event => event.type === 'change' && event.name === 'a.jsonl'));
	});

	it('waits on the nearest existing ancestor until the directory appears, then reconciles', async () => {
		const target = path.join(root, 'GitHub.copilot-chat', 'transcripts');
		const events: DirectoryEvent[] = [];
		const watcher = new DirectoryWatcher(target, event => events.push(event));
		watchers.push(watcher);
		watcher.start();
		assert.equal(watcher.watching, root);

		await fs.mkdir(target, { recursive: true });
		await waitFor(() => watcher.watching === target);
		await waitFor(() => events.some(event => event.type === 'reconcile'));

		await fs.writeFile(path.join(target, 's.jsonl'), 'x\n');
		await waitFor(() => events.some(event => event.type === 'change' && event.name === 's.jsonl'));
	});

	it('re-attaches after the directory is removed and recreated', async () => {
		const target = path.join(root, 'chatSessions');
		await fs.mkdir(target);
		const events: DirectoryEvent[] = [];
		const watcher = new DirectoryWatcher(target, event => events.push(event), { retryDelayMs: 50 });
		watchers.push(watcher);
		watcher.start();
		assert.equal(watcher.watching, target);

		await fs.rm(target, { recursive: true, force: true });
		await new Promise(resolve => setTimeout(resolve, 200));
		await fs.mkdir(target);
		await waitFor(() => watcher.watching === target, 6_000);
		await fs.writeFile(path.join(target, 'again.jsonl'), 'x\n');
		await waitFor(() => events.some(event => event.type === 'change' && event.name === 'again.jsonl'), 6_000);
	});

	it('stops delivering events after dispose', async () => {
		const events: DirectoryEvent[] = [];
		const watcher = new DirectoryWatcher(root, event => events.push(event));
		watcher.start();
		watcher.dispose();
		await fs.writeFile(path.join(root, 'late.jsonl'), 'x\n');
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(events, []);
		assert.equal(watcher.watching, undefined);
	});
});
