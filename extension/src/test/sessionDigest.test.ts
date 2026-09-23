import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SessionDigest } from '../sessionDigest';
import { syncSessionDigest } from '../sessionDigestBuilder';
import { syncDigestForSession } from '../sessionDigestClient';
import { normalizeTranscript, parseMutationLogSnapshot } from '../transcript';

type Entry = Record<string, unknown>;

const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001';

function request(index: number, text: string, extra: Entry = {}): Entry {
	return {
		requestId: `request-${index}`,
		timestamp: 1_700_000_000_000 + index * 1000,
		message: { text, parts: [] },
		modelId: index % 2 === 0 ? 'copilot/gpt-5' : 'copilot/claude',
		response: [],
		...extra,
	};
}

function tool(callId: string, complete: boolean, confirmed?: boolean): Entry {
	return {
		kind: 'toolInvocationSerialized',
		toolCallId: callId,
		toolId: 'run_in_terminal',
		invocationMessage: `Running ${callId}`,
		pastTenseMessage: `Ran ${callId}`,
		isComplete: complete,
		...(confirmed === undefined ? {} : { isConfirmed: confirmed }),
	};
}

function initial(requests: Entry[], extra: Entry = {}): Entry {
	// Key order mirrors VS Code's schema sort: primitives, then arrays, then objects (inputState last).
	return {
		kind: 0,
		v: {
			version: 3,
			creationDate: 1_700_000_000_000,
			customTitle: 'Custom title',
			sessionId,
			...extra,
			requests,
			pendingRequests: [],
			inputState: { selectedModel: { identifier: 'copilot/gpt-5', metadata: { name: 'GPT-5' } }, permissionLevel: 'default' },
		},
	};
}

const set = (k: (string | number)[], v: unknown): Entry => ({ kind: 1, k, v });
const push = (k: (string | number)[], v?: unknown[], i?: number): Entry => ({ kind: 2, k, ...(v ? { v } : {}), ...(i !== undefined ? { i } : {}) });
const del = (k: (string | number)[]): Entry => ({ kind: 3, k });

function realisticLog(): Entry[] {
	return [
		initial([
			request(0, 'first question', { response: [{ value: 'first answer' }], modelState: { value: 1, completedAt: 1 } }),
			request(1, 'second question', { response: [{ value: 'second answer' }, tool('call-a', true)], modelState: { value: 1, completedAt: 2 } }),
		]),
		set(['inputState', 'selectedModel'], { identifier: 'copilot/claude', metadata: { name: 'Claude' } }),
		push(['requests'], [request(2, 'third question')]),
		push(['requests', 2, 'response'], [{ value: 'thinking about' }]),
		push(['requests', 2, 'response'], [{ value: 'thinking about it more' }, tool('call-b', false, undefined)], 0),
		push(['requests', 2, 'response'], [tool('call-b', true), { value: 'done.' }], 1),
		set(['requests', 2, 'modelState'], { value: 1, completedAt: 3 }),
		set(['requests', 2, 'completionTokens'], 42),
		set(['hasPendingEdits'], false),
		set(['customTitle'], 'Renamed title'),
		set(['inputState', 'permissionLevel'], 'autoApprove'),
		del(['inputState', 'attachments']),
	];
}

function serialize(entries: Entry[]): string {
	return entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

function oracle(entries: Entry[]) {
	// Rows travel through JSON, which drops undefined fields; compare like with like.
	return JSON.parse(JSON.stringify(normalizeTranscript(parseMutationLogSnapshot(serialize(entries)).state))) as ReturnType<typeof normalizeTranscript>;
}

/** Deterministic pseudo-random generator for property-style tests. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function randomLog(seed: number, turns: number): Entry[] {
	const next = rng(seed);
	const entries: Entry[] = [initial([])];
	let count = 0;
	for (let turn = 0; turn < turns; turn++) {
		const index = count++;
		entries.push(push(['requests'], [request(index, `question ${index} ${'x'.repeat(Math.floor(next() * 200))}`)]));
		const parts = 1 + Math.floor(next() * 4);
		for (let part = 0; part < parts; part++) {
			const roll = next();
			if (roll < 0.4) {
				entries.push(push(['requests', index, 'response'], [{ value: `answer ${index}.${part} ${'y'.repeat(Math.floor(next() * 500))}` }]));
			} else if (roll < 0.7) {
				entries.push(push(['requests', index, 'response'], [tool(`call-${index}-${part}`, false)]));
				entries.push(push(['requests', index, 'response'], [tool(`call-${index}-${part}`, true), { value: 'after tool' }], part));
			} else {
				entries.push(push(['requests', index, 'response'], [{ kind: 'thinking', value: `thinking ${index}`, generatedTitle: 'Plan' }]));
			}
		}
		entries.push(set(['requests', index, 'modelState'], { value: next() < 0.9 ? 1 : 2, completedAt: 100 + index }));
		if (next() < 0.15 && count > 1) {
			// The user edits an earlier request: everything after it is replaced.
			const editAt = Math.floor(next() * (count - 1));
			entries.push(push(['requests'], [request(editAt, `edited ${editAt}`, { modelState: { value: 1, completedAt: 5 } })], editAt));
			count = editAt + 1;
		}
		if (next() < 0.1) {
			entries.push(set(['customTitle'], `Title ${turn}`));
		}
	}
	return entries;
}

describe('SessionDigest', () => {
	let root: string;
	let digest: SessionDigest;
	let logPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-digest-'));
		digest = new SessionDigest(path.join(root, 'history.db'));
		logPath = path.join(root, `${sessionId}.jsonl`);
	});

	afterEach(async () => {
		digest.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function sync(options: { smallLineBytes?: number } = {}) {
		return syncSessionDigest({ digest, sessionId, filePath: logPath, ...options });
	}

	function stored() {
		const row = digest.session(sessionId)!;
		return { row, turns: digest.turns(sessionId, 0, row.requestCount) };
	}

	it('matches a full replay of a realistic log, whether lines are parsed whole or streamed', async () => {
		const entries = realisticLog();
		await fs.writeFile(logPath, serialize(entries));
		const expected = oracle(entries);
		for (const smallLineBytes of [undefined, 0]) {
			digest.removeSession(sessionId);
			const result = await sync({ smallLineBytes });
			assert.equal(result.status, 'rebuilt');
			const { row, turns } = stored();
			assert.equal(row.requestCount, expected.turns.length);
			assert.equal(row.customTitle, 'Renamed title');
			assert.equal(row.sessionUuid, sessionId);
			assert.equal(row.inputState.permissionLevel, 'autoApprove');
			assert.deepEqual((row.inputState.selectedModel as Entry).identifier, 'copilot/claude');
			assert.equal(digest.lastModelId(sessionId), 'copilot/gpt-5');
			assert.deepEqual(turns, expected.turns, `smallLineBytes=${smallLineBytes}`);
			assert.equal(digest.requestIndex(sessionId, 'request-2'), 2);
		}
	});

	it('extends incrementally and produces the same rows as a rebuild', async () => {
		const entries = realisticLog();
		await fs.writeFile(logPath, serialize(entries.slice(0, 3)));
		assert.equal((await sync()).status, 'rebuilt');
		assert.equal(stored().row.requestCount, 3);
		assert.equal(stored().turns[2].status, 'working');

		await fs.appendFile(logPath, serialize(entries.slice(3, 7)));
		const extended = await sync();
		assert.equal(extended.status, 'extended');
		assert.equal(stored().turns[2].status, 'completed');
		assert.equal(stored().turns[2].assistantText, 'thinking about it more\n\ndone.');

		await fs.appendFile(logPath, serialize(entries.slice(7)));
		await sync();
		assert.equal((await sync()).status, 'unchanged');
		const incremental = stored();
		digest.removeSession(sessionId);
		await sync();
		const rebuilt = stored();
		assert.deepEqual(incremental.turns, rebuilt.turns);
		assert.equal(incremental.row.customTitle, rebuilt.row.customTitle);
		assert.deepEqual(incremental.row.inputState, rebuilt.row.inputState);
	});

	it('leaves a trailing partial line for the next sync', async () => {
		const entries = realisticLog();
		const full = serialize(entries.slice(0, 3));
		const partialTail = JSON.stringify(entries[3]);
		await fs.writeFile(logPath, full + partialTail.slice(0, 20));
		await sync();
		assert.equal(stored().row.requestCount, 3);
		assert.equal(stored().row.cursor.indexedOffset, Buffer.byteLength(full));
		await fs.appendFile(logPath, partialTail.slice(20) + '\n');
		assert.equal((await sync()).status, 'extended');
		assert.equal(stored().turns[2].assistantText, 'thinking about');
	});

	it('detects a compaction rewrite and rebuilds even when the file grew and its head is unchanged', async () => {
		const entries = realisticLog();
		await fs.writeFile(logPath, serialize(entries));
		await sync();
		const before = stored().row;
		// VS Code rewrites the whole file as one Initial entry; the first bytes stay identical.
		const compacted = initial(oracleRequests(entries), { customTitle: 'Renamed title' });
		const padded = { ...compacted, v: { ...(compacted.v as Entry), responderUsername: 'GitHub Copilot'.repeat(200) } };
		await fs.writeFile(logPath, serialize([padded, push(['requests'], [request(3, 'fourth')])]));
		const result = await sync();
		assert.equal(result.status, 'rebuilt');
		const { row, turns } = stored();
		assert.equal(row.generation, before.generation + 1);
		assert.equal(row.requestCount, 4);
		assert.equal(turns[3].userText, 'fourth');
		assert.deepEqual(turns.slice(0, 3), oracle(entries).turns);
	});

	it('streams a huge single-line Initial entry with bounded strings and correct request order', async () => {
		const big = 'z'.repeat(300 * 1024);
		const requests = Array.from({ length: 25 }, (_, index) => request(index, `q${index}`, {
			response: [{ value: `answer ${index} ${big}` }, tool(`c${index}`, true)],
			modelState: { value: 1, completedAt: index },
		}));
		const entries = [initial(requests), set(['requests', 24, 'response', 0, 'value'], 'short final answer')];
		await fs.writeFile(logPath, serialize(entries));
		const result = await sync({ smallLineBytes: 1024 });
		assert.equal(result.status, 'rebuilt');
		const { row, turns } = stored();
		assert.equal(row.requestCount, 25);
		assert.equal(row.customTitle, 'Custom title');
		assert.equal(row.inputState.permissionLevel, 'default', 'inputState is captured even though it serialises after requests');
		assert.deepEqual(turns.map(turn => turn.userText), requests.map((_, index) => `q${index}`));
		assert.ok(turns[0].assistantText.length <= 64 * 1024 + 1);
		assert.ok(turns[0].assistantText.endsWith('…'));
		assert.equal(turns[24].assistantText, 'short final answer');
		assert.deepEqual(turns[3].activities.map(activity => activity.status), ['completed']);
	});

	it('reads a Push index from the end of a streamed line', async () => {
		const entries = [initial([request(0, 'a'), request(1, 'b'), request(2, 'c')])];
		await fs.writeFile(logPath, serialize(entries));
		await sync();
		const bigEdit = push(['requests'], [request(1, `edited ${'w'.repeat(2048)}`)], 1);
		await fs.appendFile(logPath, serialize([bigEdit]));
		await sync({ smallLineBytes: 512 });
		const { row, turns } = stored();
		assert.equal(row.requestCount, 2);
		assert.ok(turns[1].userText.startsWith('edited'));
	});

	it('agrees with the oracle on randomly generated logs, incrementally and from scratch', async () => {
		for (const seed of [1, 7, 42, 1234]) {
			const entries = randomLog(seed, 30);
			const expected = oracle(entries);
			await fs.rm(logPath, { force: true });
			digest.removeSession(sessionId);
			let written = 0;
			while (written < entries.length) {
				const next = Math.min(entries.length, written + 1 + Math.floor(seed % 5));
				await fs.appendFile(logPath, serialize(entries.slice(written, next)));
				written = next;
				await sync({ smallLineBytes: seed % 2 === 0 ? 0 : undefined });
			}
			const incremental = stored();
			assert.equal(incremental.row.requestCount, expected.turns.length, `seed ${seed}`);
			assert.deepEqual(incremental.turns, expected.turns, `seed ${seed} incremental`);
			digest.removeSession(sessionId);
			await sync();
			assert.deepEqual(stored().turns, expected.turns, `seed ${seed} rebuild`);
		}
	});

	it('trims raw JSON of old sealed requests and falls back to a rebuild if one is mutated later', async () => {
		const requests = Array.from({ length: 24 }, (_, index) => request(index, `q${index}`, { response: [{ value: `a${index}` }], modelState: { value: 1, completedAt: index } }));
		await fs.writeFile(logPath, serialize([initial(requests)]));
		await sync();
		assert.equal(digest.rawRequest(sessionId, 0), undefined, 'old sealed raw is trimmed');
		assert.ok(digest.rawRequest(sessionId, 23), 'newest raw is kept');
		const entries = [initial(requests), set(['requests', 0, 'response', 0, 'value'], 'rewritten first answer')];
		await fs.appendFile(logPath, serialize(entries.slice(1)));
		const result = await sync();
		assert.equal(result.status, 'rebuilt');
		assert.equal(stored().turns[0].assistantText, 'rewritten first answer');
		assert.deepEqual(stored().turns, oracle(entries).turns);
	});

	it('removes the digest when the log disappears and reports oversized logs without reading them', async () => {
		await fs.writeFile(logPath, serialize([initial([request(0, 'a')])]));
		await sync();
		assert.equal(digest.pruneMissing(() => true), 0);
		assert.equal(digest.pruneMissing(filePath => filePath !== logPath), 1, 'deleted chats are pruned without a sync');
		assert.equal(digest.session(sessionId), undefined);
		await sync();
		await fs.rm(logPath);
		assert.equal((await sync()).status, 'gone');
		assert.equal(digest.session(sessionId), undefined);
		await fs.writeFile(logPath, serialize([initial([request(0, 'a')])]));
		assert.equal((await syncSessionDigest({ digest, sessionId, filePath: logPath, maximumFileBytes: 10 })).status, 'oversized');
	});

	it('runs a rebuild in a worker thread against the same database', async () => {
		const entries = realisticLog();
		await fs.writeFile(logPath, serialize(entries));
		const result = await syncDigestForSession(digest, sessionId, logPath, { mode: 'worker' });
		assert.equal(result.status, 'rebuilt');
		assert.equal(result.requestCount, 3);
		assert.deepEqual(stored().turns, oracle(entries).turns);
		await fs.appendFile(logPath, serialize([push(['requests'], [request(3, 'fourth')])]));
		const extended = await syncDigestForSession(digest, sessionId, logPath);
		assert.equal(extended.status, 'extended');
		assert.equal(stored().row.requestCount, 4);
	});
});

function oracleRequests(entries: Entry[]): Entry[] {
	const state = parseMutationLogSnapshot(serialize(entries)).state;
	return (state.requests as Entry[]).map(request => ({ ...request }));
}
