import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { readWindowDescriptors, removeWindowDescriptor, WindowRegistration, WindowRegistry } from '../windowRegistry';

const registration: WindowRegistration = {
	hostId: 'host-1',
	productName: 'Visual Studio Code',
	productVersion: '1.128.0',
	localPort: 32123,
	workspaceName: 'Workspace One',
	workspaceFolders: ['C:\\code\\one'],
	startedAt: 100,
	pid: 1234,
};

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.fail('condition was not met in time');
}

describe('WindowRegistry', () => {
	it('registers, discovers, and removes one owned descriptor', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		const registry = new WindowRegistry(root, 'window-1');
		try {
			await registry.start(registration);
			const active = await readWindowDescriptors(root);
			assert.equal(active.length, 1);
			assert.equal(active[0].windowId, 'window-1');
			assert.equal(active[0].version, 2);
			assert.equal(active[0].hostId, 'host-1');
			assert.equal(active[0].productName, 'Visual Studio Code');
			assert.equal(active[0].localPort, 32123);
			await registry.stop();
			assert.deepEqual(await readWindowDescriptors(root), []);
		} finally {
			await registry.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('does not age descriptors out: liveness is decided by connecting to the window', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		try {
			await fs.writeFile(path.join(root, 'old.json'), JSON.stringify({
				version: 1,
				windowId: 'old',
				localPort: 30001,
				workspaceName: 'Old',
				workspaceFolders: [],
				startedAt: 1,
				heartbeatAt: 100,
				pid: 1,
			}));
			await fs.writeFile(path.join(root, 'recent.json'), JSON.stringify({
				version: 2,
				windowId: 'recent',
				hostId: 'host-1',
				productName: 'Visual Studio Code',
				productVersion: '1.137.0',
				localPort: 30002,
				workspaceName: 'Current',
				workspaceFolders: [],
				startedAt: 2,
				heartbeatAt: 950,
				pid: 2,
			}));
			const descriptors = await readWindowDescriptors(root, 10_000_000);
			assert.deepEqual(descriptors.map(descriptor => descriptor.windowId), ['old', 'recent']);
			await removeWindowDescriptor(root, 'old');
			assert.deepEqual((await readWindowDescriptors(root)).map(descriptor => descriptor.windowId), ['recent']);
			await removeWindowDescriptor(root, 'missing');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('republishes its own descriptor when something deletes it, and not after stop', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		const registry = new WindowRegistry(root, 'window-healed');
		const descriptorPath = path.join(root, 'window-healed.json');
		try {
			await registry.start(registration);
			await fs.rm(descriptorPath);
			await waitFor(async () => fs.stat(descriptorPath).then(() => true, () => false));
			const healed = await readWindowDescriptors(root);
			assert.equal(healed.length, 1);
			assert.equal(healed[0].localPort, registration.localPort);

			await registry.stop();
			await new Promise(resolve => setTimeout(resolve, 250));
			await assert.rejects(fs.stat(descriptorPath));
			assert.deepEqual(await readWindowDescriptors(root), []);
		} finally {
			await registry.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('prunes old malformed descriptors and abandoned temporary writes but keeps fresh ones', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-registry-'));
		try {
			const malformed = path.join(root, 'broken.json');
			const temporary = path.join(root, 'window.json.123.tmp');
			const inFlight = path.join(root, 'window.json.456.tmp');
			await fs.writeFile(malformed, Buffer.alloc(64));
			await fs.writeFile(temporary, '{}');
			await fs.writeFile(inFlight, '{}');
			await fs.utimes(malformed, 1, 1);
			await fs.utimes(temporary, 1, 1);
			assert.deepEqual(await readWindowDescriptors(root), []);
			await assert.rejects(fs.stat(malformed));
			await assert.rejects(fs.stat(temporary));
			await fs.stat(inFlight);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
