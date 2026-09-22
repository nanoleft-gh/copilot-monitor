import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseSessionIndex, readSessionIndex, sessionIndexStorageKey } from '../sessionIndex';

const sampleIndex = {
	version: 1,
	entries: {
		'6263c2e4-6509-4e9a-a206-4dd43f52d712': {
			sessionId: '6263c2e4-6509-4e9a-a206-4dd43f52d712',
			title: 'Older chat',
			lastMessageDate: 1782593166151,
			timing: { created: 1781527270820, lastRequestStarted: 1782593166151, lastRequestEnded: 1782593226111 },
			initialLocation: 'panel',
			hasPendingEdits: true,
			isEmpty: false,
			isExternal: false,
			lastResponseState: 1,
			permissionLevel: 'default',
		},
		'd957ca4c-6d19-4e42-a48d-2ca83a68d33a': {
			sessionId: 'd957ca4c-6d19-4e42-a48d-2ca83a68d33a',
			title: 'Research on edge detection',
			lastMessageDate: 1782800196255,
			timing: { created: 1782800092076, lastRequestStarted: 1782800196255, lastRequestEnded: 1782800451516 },
			lastResponseState: 2,
			permissionLevel: 'autopilot',
		},
		'broken': { title: 'missing id' },
	},
};

describe('sessionIndex', () => {
	let root: string;
	let databasePath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-index-'));
		databasePath = path.join(root, 'state.vscdb');
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function writeDatabase(value: string | undefined): void {
		const database = new DatabaseSync(databasePath);
		try {
			database.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
			database.exec('DELETE FROM ItemTable');
			if (value !== undefined) {
				database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(sessionIndexStorageKey, value);
			}
			database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('workbench.panel.chat', '{}');
		} finally {
			database.close();
		}
	}

	it('reads and normalises entries, newest first, dropping invalid ones', () => {
		writeDatabase(JSON.stringify(sampleIndex));
		const snapshot = readSessionIndex(databasePath);
		assert.ok(snapshot);
		assert.deepEqual(snapshot.entries.map(entry => entry.sessionId), [
			'd957ca4c-6d19-4e42-a48d-2ca83a68d33a',
			'6263c2e4-6509-4e9a-a206-4dd43f52d712',
		]);
		const [newest, older] = snapshot.entries;
		assert.equal(newest.title, 'Research on edge detection');
		assert.equal(newest.lastResponseState, 'cancelled');
		assert.equal(newest.permissionLevel, 'autopilot');
		assert.equal(newest.hasPendingEdits, false);
		assert.equal(newest.lastRequestEnded, 1782800451516);
		assert.equal(older.lastResponseState, 'complete');
		assert.equal(older.hasPendingEdits, true);
		assert.equal(older.created, 1781527270820);
	});

	it('produces a stable revision that changes only when the stored value changes', () => {
		writeDatabase(JSON.stringify(sampleIndex));
		const first = readSessionIndex(databasePath)!;
		const second = readSessionIndex(databasePath)!;
		assert.equal(first.revision, second.revision);
		writeDatabase(JSON.stringify({ ...sampleIndex, entries: { ...sampleIndex.entries, extra: { sessionId: 'x', title: 'X', lastMessageDate: 1 } } }));
		assert.notEqual(readSessionIndex(databasePath)!.revision, first.revision);
	});

	it('returns undefined when the database, table, key, or JSON is unusable', () => {
		assert.equal(readSessionIndex(path.join(root, 'missing.vscdb')), undefined);
		writeDatabase(undefined);
		assert.equal(readSessionIndex(databasePath), undefined);
		writeDatabase('{not json');
		assert.equal(readSessionIndex(databasePath), undefined);
		assert.equal(parseSessionIndex(JSON.stringify({ version: 2, entries: {} })), undefined);
		assert.equal(parseSessionIndex(JSON.stringify({ version: 1, entries: [] })), undefined);
	});

	it('does not leave the database locked after reading', () => {
		writeDatabase(JSON.stringify(sampleIndex));
		readSessionIndex(databasePath);
		writeDatabase(JSON.stringify({ version: 1, entries: {} }));
		assert.deepEqual(readSessionIndex(databasePath)?.entries, []);
	});
});
