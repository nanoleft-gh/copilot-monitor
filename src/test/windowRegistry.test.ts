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
				localPort: 32123,
				workspaceName: 'Workspace One',
				workspaceFolders: ['C:\\code\\one'],
				startedAt: 100,
				pid: 1234,
			});
			const active = await readActiveWindowDescriptors(root);
			assert.equal(active.length, 1);
			assert.equal(active[0].windowId, 'window-1');
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
});