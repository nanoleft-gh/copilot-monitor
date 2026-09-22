import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { readStableUtf8 } from '../boundedFileRead';

describe('readStableUtf8', () => {
	it('reads a stable file completely', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-read-'));
		const filePath = path.join(root, 'session.jsonl');
		try {
			await fs.writeFile(filePath, 'original');
			const result = await readStableUtf8(filePath, await fs.stat(filePath));
			assert.equal(result.content, 'original');
			assert.equal(result.stable, true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('never reads bytes appended after the approved stat', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-read-'));
		const filePath = path.join(root, 'session.jsonl');
		try {
			await fs.writeFile(filePath, 'approved');
			const approvedStat = await fs.stat(filePath);
			await fs.appendFile(filePath, '-unbounded-growth');
			const result = await readStableUtf8(filePath, approvedStat);
			assert.equal(result.content, 'approved');
			assert.equal(result.stable, false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});