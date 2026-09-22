import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { readActiveWindowDescriptors, WindowRegistry } from '../windowRegistry';

describe('WindowRegistry', () => {
	it('registers, discovers, and removes one owned descriptor', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		const registry = new WindowRegistry(root, 'window-1');
		try {
			await registry.start({
				hostId: 'host-1',
				productName: 'Visual Studio Code',
				productVersion: '1.128.0',
				localPort: 32123,
				workspaceName: 'Workspace One',
				workspaceFolders: ['C:\\code\\one'],
				startedAt: 100,
				pid: 1234,
			});
			const active = await readActiveWindowDescriptors(root);
			assert.equal(active.length, 1);
			assert.equal(active[0].windowId, 'window-1');
			assert.equal(active[0].version, 2);
			assert.equal(active[0].hostId, 'host-1');
			assert.equal(active[0].productName, 'Visual Studio Code');
			assert.equal(active[0].localPort, 32123);
			await registry.stop();
			assert.deepEqual(await readActiveWindowDescriptors(root), []);
		} finally {
			await registry.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('removes stale descriptors without hiding active windows', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		try {
			await fs.writeFile(path.join(root, 'stale.json'), JSON.stringify({
				version: 1,
				windowId: 'stale',
				localPort: 30001,
				workspaceName: 'Old',
				workspaceFolders: [],
				startedAt: 1,
				heartbeatAt: 100,
				pid: 1,
			}));
			await fs.writeFile(path.join(root, 'active.json'), JSON.stringify({
				version: 1,
				windowId: 'active',
				localPort: 30002,
				workspaceName: 'Current',
				workspaceFolders: [],
				startedAt: 2,
				heartbeatAt: 950,
				pid: 2,
			}));
			const active = await readActiveWindowDescriptors(root, 1_000, 200);
			assert.deepEqual(active.map(descriptor => descriptor.windowId), ['active']);
			await assert.rejects(fs.stat(path.join(root, 'stale.json')));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('does not recreate a descriptor when stopped during queued heartbeats', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		const registry = new WindowRegistry(root, 'window-queued');
		try {
			await registry.start({
				hostId: 'host-1',
				productName: 'Visual Studio Code - Insiders',
				productVersion: '1.130.0-insider',
				localPort: 32124,
				workspaceName: 'Queued',
				workspaceFolders: [],
				startedAt: 100,
				pid: 1234,
			});
			const writer = registry as unknown as { writeHeartbeat(): Promise<void> };
			const writes = Array.from({ length: 20 }, () => writer.writeHeartbeat());
			await registry.stop();
			await Promise.all(writes);
			assert.deepEqual(await readActiveWindowDescriptors(root), []);
			await assert.rejects(fs.stat(path.join(root, 'window-queued.json')));
		} finally {
			await registry.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('prunes stale malformed descriptors and abandoned temporary writes', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		try {
			const malformed = path.join(root, 'broken.json');
			const temporary = path.join(root, 'window.json.123.tmp');
			await fs.writeFile(malformed, Buffer.alloc(64));
			await fs.writeFile(temporary, '{}');
			await fs.utimes(malformed, 1, 1);
			await fs.utimes(temporary, 1, 1);
			assert.deepEqual(await readActiveWindowDescriptors(root, 10_000, 1_000), []);
			await assert.rejects(fs.stat(malformed));
			await assert.rejects(fs.stat(temporary));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});