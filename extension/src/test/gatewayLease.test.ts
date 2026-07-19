import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { GatewayLeaseStore } from '../gatewayLease';

describe('GatewayLeaseStore', () => {
	it('allows one election owner and publishes an atomic lease', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-lease-'));
		const store = new GatewayLeaseStore(directory, 1_000);
		try {
			const [first, second] = await Promise.all([
				store.acquire('window-1', 100),
				store.acquire('window-2', 100),
			]);
			assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);
			const lock = first ?? second!;
			await store.publish({
				version: 1,
				hostId: 'host-1',
				nonce: 'nonce-1',
				ownerId: first ? 'window-1' : 'window-2',
				port: 43_121,
				heartbeatAt: 100,
			});
			assert.equal((await store.read(500))?.port, 43_121);
			assert.equal(await store.read(1_101), undefined);
			await lock.release();
			const replacement = await store.acquire('window-3', 1_101);
			assert.ok(replacement);
			await replacement.release();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('only removes the lease owned by the matching nonce', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-lease-'));
		const store = new GatewayLeaseStore(directory);
		try {
			await store.publish({
				version: 1, hostId: 'host-1', nonce: 'current', ownerId: 'window-1', port: 40_000, heartbeatAt: Date.now(),
			});
			await store.remove('stale');
			assert.equal((await store.read())?.nonce, 'current');
			await store.remove('current');
			assert.equal(await store.read(), undefined);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});