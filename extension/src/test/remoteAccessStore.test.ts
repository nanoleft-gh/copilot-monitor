import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { readRemoteAccessPreferences, writeRemoteAccessPreferences } from '../remoteAccessStore';

describe('remote access preferences', () => {
	it('defaults to off, round-trips, and ignores corrupt files', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-remote-'));
		try {
			assert.deepEqual(await readRemoteAccessPreferences(directory), { version: 1, enabled: false });
			await writeRemoteAccessPreferences(directory, { version: 1, enabled: true, manualUrl: 'https://pc.tail.ts.net/' });
			assert.deepEqual(await readRemoteAccessPreferences(directory), { version: 1, enabled: true, manualUrl: 'https://pc.tail.ts.net/' });
			await writeRemoteAccessPreferences(directory, { version: 1, enabled: false });
			assert.deepEqual(await readRemoteAccessPreferences(directory), { version: 1, enabled: false });
			await fs.writeFile(path.join(directory, 'remote-access.json'), '{not json');
			assert.deepEqual(await readRemoteAccessPreferences(directory), { version: 1, enabled: false });
			assert.deepEqual(await fs.readdir(directory), ['remote-access.json'], 'no temp files left behind');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
