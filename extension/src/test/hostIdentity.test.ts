import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getOrCreateHostIdentity, getOrCreatePairingSecret, getSharedStateDirectory, resetPairingSecret } from '../hostIdentity';

describe('host identity', () => {
	it('resolves platform-specific shared state directories', () => {
		assert.equal(
			getSharedStateDirectory('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\test'),
			path.join('C:\\Local', 'CopilotMonitor'),
		);
		assert.equal(
			getSharedStateDirectory('darwin', {}, '/Users/test'),
			path.join('/Users/test', 'Library', 'Application Support', 'CopilotMonitor'),
		);
		assert.equal(
			getSharedStateDirectory('linux', { XDG_STATE_HOME: '/state' }, '/home/test'),
			path.join('/state', 'copilot-monitor'),
		);
	});

	it('converges concurrent initializers on one persistent identity', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-host-'));
		try {
			const identities = await Promise.all(Array.from(
				{ length: 12 },
				() => getOrCreateHostIdentity(directory, 'Test Laptop'),
			));
			assert.equal(new Set(identities.map(identity => identity.hostId)).size, 1);
			assert.equal(identities[0].name, 'Test Laptop');
			assert.deepEqual(await getOrCreateHostIdentity(directory, 'Renamed Laptop'), identities[0]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('converges concurrent windows on one pairing secret and mints a fresh one after a reset', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-secret-'));
		try {
			const secrets = await Promise.all(Array.from({ length: 12 }, () => getOrCreatePairingSecret(directory)));
			assert.equal(new Set(secrets).size, 1);
			assert.match(secrets[0], /^[A-Za-z0-9_-]{43}$/);
			assert.equal(await getOrCreatePairingSecret(directory), secrets[0]);
			await resetPairingSecret(directory);
			await resetPairingSecret(directory);
			const rotated = await getOrCreatePairingSecret(directory);
			assert.notEqual(rotated, secrets[0]);
			// A corrupted file is treated as absent rather than trusted.
			await fs.writeFile(path.join(directory, 'pairing-secret'), 'short');
			await assert.rejects(getOrCreatePairingSecret(directory), /invalid/);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});