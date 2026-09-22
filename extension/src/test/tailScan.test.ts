import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findTailStart } from '../tailScan';

const marker = '"type":"user.message"';

function line(type: string, payload = ''): string {
	return JSON.stringify({ type, data: { content: payload }, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n';
}

describe('findTailStart', () => {
	let root: string;
	let file: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-tail-'));
		file = path.join(root, 'log.jsonl');
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function write(content: string): Promise<number> {
		await fs.writeFile(file, content);
		return (await fs.stat(file)).size;
	}

	it('returns the start of the second-last turn-opening line', async () => {
		const head = line('session.start') + line('user.message', 'one') + line('assistant.message', 'a'.repeat(100));
		const second = line('user.message', 'two') + line('assistant.message', 'b');
		const third = line('user.message', 'three');
		const size = await write(head + second + third);
		assert.equal(await findTailStart(file, size, { marker }), Buffer.byteLength(head));
		assert.equal(await findTailStart(file, size, { marker, turnsBack: 1 }), Buffer.byteLength(head + second));
		assert.equal(await findTailStart(file, size, { marker, turnsBack: 3 }), Buffer.byteLength(line('session.start')));
	});

	it('returns 0 when the file has fewer turns than requested or is small', async () => {
		const size = await write(line('session.start') + line('user.message', 'only'));
		assert.equal(await findTailStart(file, size, { marker }), 0);
		assert.equal(await findTailStart(file, 0, { marker }), 0);
		await write('');
		assert.equal(await findTailStart(file, 0, { marker }), 0);
	});

	it('finds markers that straddle block boundaries and lines without a trailing newline', async () => {
		const filler = line('assistant.message', 'x'.repeat(50));
		let content = line('session.start');
		for (let index = 0; index < 40; index++) {
			content += line('user.message', `turn ${index}`) + filler + filler;
		}
		const lastStart = Buffer.byteLength(content);
		content += JSON.stringify({ type: 'user.message', data: { content: 'unterminated' } });
		const size = await write(content);
		for (const blockBytes of [7, 64, 100, 333, 4096]) {
			assert.equal(await findTailStart(file, size, { marker, turnsBack: 1, blockBytes }), lastStart, `block ${blockBytes}`);
			const expected = content.lastIndexOf(line('user.message', 'turn 39'));
			assert.equal(await findTailStart(file, size, { marker, turnsBack: 2, blockBytes }), Buffer.byteLength(content.slice(0, expected)), `block ${blockBytes} second`);
		}
	});

	it('stops at the look-back limit and returns the earliest complete line inside it', async () => {
		const big = line('assistant.message', 'y'.repeat(2000));
		const content = line('user.message', 'old') + big + big + big + big;
		const size = await write(content);
		const start = await findTailStart(file, size, { marker, maximumLookbackBytes: Buffer.byteLength(big) * 2 + 10, blockBytes: 512 });
		assert.ok(start > 0 && start < size);
		const text = (await fs.readFile(file, 'utf8')).slice(start);
		assert.ok(text.startsWith('{"type":"assistant.message"'), 'starts at a line boundary');
	});

	it('does not match the marker deep inside a line', async () => {
		const decoy = JSON.stringify({ type: 'assistant.message', data: { content: 'z'.repeat(300) + marker } }) + '\n';
		const content = line('user.message', 'real') + decoy + decoy;
		const size = await write(content);
		assert.equal(await findTailStart(file, size, { marker, turnsBack: 1 }), 0);
	});
});
