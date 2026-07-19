import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getOrCreateHostIdentity, getSharedStateDirectory } from '../hostIdentity';

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
});