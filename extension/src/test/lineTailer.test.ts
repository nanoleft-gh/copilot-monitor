import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LineTailer, TailResetReason } from '../lineTailer';

interface Recorder {
	readonly lines: Array<{ lines: readonly string[]; generation: number }>;
	readonly resets: Array<{ reason: TailResetReason; generation: number }>;
	readonly skipped: Array<{ bytes: number; index: number }>;
	gone: number;
	flat(): string[];
}

function createRecorder(): Recorder {
	const recorder: Recorder = {
		lines: [],
		resets: [],
		skipped: [],
		gone: 0,
		flat: () => recorder.lines.flatMap(entry => entry.lines),
	};
	return recorder;
}

function createTailer(filePath: string, recorder: Recorder, options = {}): LineTailer {
	return new LineTailer(filePath, {
		onLines: (lines, generation) => recorder.lines.push({ lines, generation }),
		onReset: (reason, generation) => recorder.resets.push({ reason, generation }),
		onLineSkipped: (bytes, index) => recorder.skipped.push({ bytes, index }),
		onGone: () => recorder.gone++,
	}, options);
}

describe('LineTailer', () => {
	let root: string;
	let filePath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-tail-'));
		filePath = path.join(root, 'log.jsonl');
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('emits only complete lines and carries a partial line across pokes', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'one\ntwo\nthr');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['one', 'two']);

		await fs.appendFile(filePath, 'ee\nfour\n');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['one', 'two', 'three', 'four']);
		assert.equal(recorder.resets.length, 0);
		assert.equal(tailer.cursor.offset, (await fs.stat(filePath)).size);
	});

	it('reads a large backlog in chunks and preserves line boundaries', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { chunkBytes: 7 });
		const expected = Array.from({ length: 200 }, (_, index) => `line-${index}-${'x'.repeat(index % 13)}`);
		await fs.writeFile(filePath, expected.join('\n') + '\n');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), expected);
	});

	it('does not emit a line that has no terminating newline yet', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, '{"kind":0,"v":{"partial":true');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), []);
		await fs.appendFile(filePath, '}}\n');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['{"kind":0,"v":{"partial":true}}']);
	});

	it('resets when the file shrinks (truncation / compaction)', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\nb\nc\nd\ne\n');
		await tailer.poke();
		await fs.writeFile(filePath, 'X\n');
		await tailer.poke();
		assert.deepEqual(recorder.resets.map(reset => reset.reason), ['truncated']);
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['X']);
		assert.equal(recorder.lines.at(-1)?.generation, 2);
	});

	it('resets when the bytes before the cursor changed even though the file grew', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'alpha\nbeta\n');
		await tailer.poke();
		// Same length prefix, different content, then longer than before.
		await fs.writeFile(filePath, 'ALPHA\nBETA\ngamma\n');
		await tailer.poke();
		assert.deepEqual(recorder.resets.map(reset => reset.reason), ['rewritten']);
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['ALPHA', 'BETA', 'gamma']);
	});

	it('treats an identical prefix followed by more data as a plain append', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'alpha\nbeta\n');
		await tailer.poke();
		await fs.writeFile(filePath, 'alpha\nbeta\ngamma\n');
		await tailer.poke();
		assert.equal(recorder.resets.length, 0);
		assert.deepEqual(recorder.flat(), ['alpha', 'beta', 'gamma']);
	});

	it('resets when the file is replaced through rename (rotation)', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { resyncTailBytes: 1024 });
		await fs.writeFile(filePath, 'old-1\nold-2\n');
		await tailer.poke();
		const replacement = path.join(root, 'log.jsonl.tmp');
		await fs.writeFile(replacement, 'new-1\nnew-2\n');
		await fs.rename(replacement, filePath);
		await tailer.poke();
		assert.deepEqual(recorder.resets.map(reset => reset.reason), ['rotated']);
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['new-1', 'new-2']);
	});

	it('resumes near the end of a large rotated file at a line boundary', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { resyncTailBytes: 16 });
		await fs.writeFile(filePath, 'old\n');
		await tailer.poke();
		const replacement = path.join(root, 'log.jsonl.tmp');
		await fs.writeFile(replacement, 'first-long-line-that-is-skipped\nkept-1\nkept-2\n');
		await fs.rename(replacement, filePath);
		await tailer.poke();
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['kept-1', 'kept-2']);
	});

	it('reports a deleted file once and recovers when it reappears', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\n');
		await tailer.poke();
		await fs.rm(filePath);
		await tailer.poke();
		await tailer.poke();
		assert.equal(recorder.gone, 1);
		await fs.writeFile(filePath, 'b\n');
		await tailer.poke();
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['b']);
		assert.equal(recorder.lines.at(-1)?.generation, 2);
	});

	it('decodes multibyte UTF-8 split across read boundaries', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { chunkBytes: 5 });
		const text = 'héllo wörld — 日本語 🚀';
		await fs.writeFile(filePath, `${text}\n${text}\n`);
		await tailer.poke();
		assert.deepEqual(recorder.flat(), [text, text]);
	});

	it('tolerates CRLF line endings and blank lines', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\r\n\r\nb\r\n');
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['a', 'b']);
	});

	it('skips a line longer than the limit and reports it instead of buffering it', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { chunkBytes: 8, maximumLineBytes: 10 });
		await fs.writeFile(filePath, `${'x'.repeat(50)}\nshort\n`);
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['short']);
		assert.deepEqual(recorder.skipped, [{ bytes: 51, index: 0 }]);
	});

	it('starts near the end when the file is already oversized on first attach', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder, { skipToTailIfLargerThan: 32, resyncTailBytes: 12 });
		await fs.writeFile(filePath, `${'h'.repeat(40)}\nmid\nlast\n`);
		await tailer.poke();
		assert.deepEqual(recorder.resets.map(reset => reset.reason), ['oversized']);
		assert.deepEqual(recorder.flat(), ['mid', 'last']);
	});

	it('resync() restarts from the beginning in a new generation', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\nb\n');
		await tailer.poke();
		await tailer.resync();
		assert.deepEqual(recorder.resets.map(reset => reset.reason), ['desync']);
		assert.deepEqual(recorder.lines.map(entry => entry.generation), [1, 2]);
		assert.deepEqual(recorder.lines.at(-1)?.lines, ['a', 'b']);
	});

	it('coalesces concurrent pokes into at most one follow-up pass', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\n');
		const first = tailer.poke();
		await fs.appendFile(filePath, 'b\n');
		const second = tailer.poke();
		const third = tailer.poke();
		await Promise.all([first, second, third]);
		// Let the coalesced follow-up pass complete.
		await tailer.poke();
		assert.deepEqual(recorder.flat(), ['a', 'b']);
	});

	it('does nothing after dispose', async () => {
		const recorder = createRecorder();
		const tailer = createTailer(filePath, recorder);
		await fs.writeFile(filePath, 'a\n');
		tailer.dispose();
		await tailer.poke();
		assert.deepEqual(recorder.flat(), []);
	});
});
