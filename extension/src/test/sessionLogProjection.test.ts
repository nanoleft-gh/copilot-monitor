import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionLogProjection } from '../sessionLogProjection';
import { normalizeTranscript, parseMutationLogSnapshot } from '../transcript';

type Entry = Record<string, unknown>;

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
	return {
		kind: 0,
		v: {
			version: 3,
			sessionId: 'session-1',
			creationDate: 1_700_000_000_000,
			customTitle: 'Custom title',
			inputState: { selectedModel: { identifier: 'copilot/gpt-5', metadata: { name: 'GPT-5' } }, permissionLevel: 'default' },
			requests,
			...extra,
		},
	};
}

const set = (k: (string | number)[], v: unknown): Entry => ({ kind: 1, k, v });
const push = (k: (string | number)[], v?: unknown[], i?: number): Entry => ({ kind: 2, k, ...(v ? { v } : {}), ...(i !== undefined ? { i } : {}) });
const del = (k: (string | number)[]): Entry => ({ kind: 3, k });

/** A realistic log: two existing requests, a new request streamed in, tail rewrites, status changes. */
function realisticLog(): Entry[] {
	return [
		initial([
			request(0, 'first question', { response: [{ value: 'first answer' }], modelState: { value: 1, completedAt: 1 } }),
			request(1, 'second question', { response: [{ value: 'second answer' }, tool('call-a', true)], modelState: { value: 1, completedAt: 2 } }),
		]),
		set(['inputState', 'selectedModel'], { identifier: 'copilot/claude', metadata: { name: 'Claude' } }),
		push(['requests'], [request(2, 'third question')]),
		push(['requests', 2, 'response'], [{ value: 'thinking about' }]),
		// Streaming: the markdown part grew, so VS Code rewrites the tail from index 0.
		push(['requests', 2, 'response'], [{ value: 'thinking about it more' }, tool('call-b', false, undefined)], 0),
		// Tool completes: rewrite from index 1.
		push(['requests', 2, 'response'], [tool('call-b', true), { value: 'done.' }], 1),
		set(['requests', 2, 'modelState'], { value: 1, completedAt: 3 }),
		set(['requests', 2, 'completionTokens'], 42),
		set(['hasPendingEdits'], false),
		set(['customTitle'], 'Renamed title'),
		set(['inputState', 'permissionLevel'], 'autoApprove'),
	];
}

function replayAll(entries: Entry[]) {
	const projection = new SessionLogProjection();
	for (const entry of entries) {
		projection.applyLine(JSON.stringify(entry));
	}
	return projection;
}

function oracle(entries: Entry[]) {
	const content = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
	return normalizeTranscript(parseMutationLogSnapshot(content).state);
}

describe('SessionLogProjection', () => {
	it('matches a full replay of the same log', () => {
		const entries = realisticLog();
		const projection = replayAll(entries);
		const expected = oracle(entries);
		const snapshot = projection.snapshot;
		assert.equal(snapshot.turnCount, expected.turns.length);
		assert.equal(snapshot.title, 'Renamed title');
		assert.equal(snapshot.status, expected.status);
		assert.equal(snapshot.permissionLevel, 'autoApprove');
		assert.equal(snapshot.model?.selectedModelId, 'copilot/claude');
		assert.equal(snapshot.model?.lastUsedModelId, 'copilot/gpt-5');
		assert.deepEqual(projection.turns(0, 10), expected.turns);
	});

	it('rewrites response tails and truncates request arrays exactly like VS Code', () => {
		const entries = realisticLog();
		const projection = replayAll(entries);
		assert.equal(projection.turns(2, 3)[0].assistantText, 'thinking about it more\n\ndone.');
		assert.deepEqual(projection.turns(2, 3)[0].activities.map(activity => activity.status), ['completed']);

		// User edited request 1: everything from index 1 is replaced.
		const edit = push(['requests'], [request(1, 'second question, edited')], 1);
		projection.applyLine(JSON.stringify(edit));
		assert.equal(projection.snapshot.turnCount, 2);
		assert.equal(projection.turns(1, 2)[0].userText, 'second question, edited');
		assert.equal(projection.snapshot.status, 'working');
		assert.deepEqual(projection.turns(0, 5), oracle([...entries, edit]).turns);
	});

	it('exposes a waiting tool confirmation on the newest turn', () => {
		const entries = [
			initial([request(0, 'run it')]),
			push(['requests', 0, 'response'], [{
				...tool('call-x', false, undefined),
				toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, confirmation: { title: 'Run?' } },
			}]),
		];
		const projection = replayAll(entries);
		const activity = projection.tail(1).turns[0].activities[0];
		assert.equal(activity.status, 'waiting');
		assert.equal(activity.canApprove, true);
		assert.equal(activity.command, 'npm test');
	});

	it('handles Delete entries and missing containers without throwing', () => {
		const projection = replayAll([
			initial([request(0, 'q')]),
			del(['customTitle']),
			set(['requests', 0, 'result', 'errorDetails'], { message: 'boom', code: 'error' }),
			set(['inputState', 'attachments', 0, 'name'], 'file.ts'),
		]);
		assert.equal(projection.snapshot.title, undefined);
		assert.equal(projection.tail(1).turns[0].status, 'failed');
		assert.equal(projection.tail(1).turns[0].error, 'boom');
	});

	it('compacts old requests, keeps exact raw state for the newest ones, and pages history', () => {
		const long = 'x'.repeat(5000);
		const requests = Array.from({ length: 6 }, (_, index) => request(index, `question ${index}`, {
			response: [{ value: long }],
			modelState: { value: 1 },
		}));
		const projection = new SessionLogProjection({ retainedRawTurns: 2, compactedAssistantTextChars: 100 });
		projection.applyLine(JSON.stringify(initial(requests)));

		const page = projection.turns(0, 4);
		assert.equal(page.length, 4);
		assert.ok(page.every(turn => turn.assistantText.length === 101 && turn.assistantText.endsWith('…')));
		const tail = projection.tail(2);
		assert.equal(tail.start, 4);
		assert.ok(tail.turns.every(turn => turn.assistantText.length === 5000));

		// Streaming into a retained request stays exact.
		projection.applyLine(JSON.stringify(push(['requests', 5, 'response'], [{ value: 'more' }])));
		assert.equal(projection.tail(1).turns[0].assistantText, `${long}\n\nmore`);
		assert.equal(projection.snapshot.needsFullReload, false);

		// A visible mutation on a compacted request cannot be applied exactly.
		projection.applyLine(JSON.stringify(set(['requests', 0, 'modelState'], { value: 2 })));
		assert.equal(projection.snapshot.needsFullReload, true);
	});

	it('ignores invisible mutations on compacted requests', () => {
		const projection = new SessionLogProjection({ retainedRawTurns: 1 });
		projection.applyLine(JSON.stringify(initial([request(0, 'a'), request(1, 'b')])));
		const changed = projection.applyLine(JSON.stringify(set(['requests', 0, 'vote'], 'up')));
		assert.equal(changed, false);
		assert.equal(projection.snapshot.needsFullReload, false);
	});

	it('tracks later mutations even when the initial entry was skipped as oversized', () => {
		const projection = new SessionLogProjection();
		projection.markInitialSkipped();
		assert.equal(projection.snapshot.oversized, true);
		projection.applyLine(JSON.stringify(set(['customTitle'], 'Huge chat')));
		projection.applyLine(JSON.stringify(push(['requests', 57, 'response'], [{ value: 'late answer' }])));
		projection.applyLine(JSON.stringify(set(['requests', 57, 'modelState'], { value: 1 })));
		assert.equal(projection.snapshot.title, 'Huge chat');
		assert.equal(projection.snapshot.turnCount, 58);
		assert.equal(projection.tail(1).turns[0].assistantText, 'late answer');
		assert.equal(projection.snapshot.status, 'idle');
	});

	it('rejects mutations before an initial entry and malformed lines', () => {
		const projection = new SessionLogProjection();
		assert.throws(() => projection.applyLine(JSON.stringify(set(['customTitle'], 'x'))));
		assert.throws(() => projection.applyLine('{"kind":1,'));
	});

	it('reset() drops everything so a new generation starts clean', () => {
		const projection = replayAll(realisticLog());
		projection.reset();
		assert.equal(projection.snapshot.initialised, false);
		assert.equal(projection.snapshot.turnCount, 0);
		assert.equal(projection.snapshot.title, undefined);
	});
});
