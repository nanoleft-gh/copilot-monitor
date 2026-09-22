import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeLiveTurns } from '../liveMerge';
import type { LiveToolCall, LiveTurn } from '../liveTurns';
import type { TranscriptTurn } from '../transcript';

const base = 1_800_000_000_000;

function persisted(index: number, text: string, status: TranscriptTurn['status'], extra: Partial<TranscriptTurn> = {}): TranscriptTurn {
	return {
		id: `request-${index}`,
		editable: true,
		timestamp: base + index * 60_000,
		userText: text,
		thinking: '',
		thinkingTitle: '',
		assistantText: '',
		activities: [],
		blocks: [],
		status,
		...extra,
	};
}

function live(index: number, text: string, status: LiveTurn['status'], extra: Partial<LiveTurn> = {}): LiveTurn {
	return {
		index,
		userText: text,
		startedAt: base + index * 60_000 + 500,
		assistantText: '',
		thinking: '',
		rounds: 1,
		tools: [],
		status,
		textTruncated: false,
		...extra,
	};
}

function tool(id: string, name: string, status: LiveToolCall['status'], startedAt?: number): LiveToolCall {
	return { id, name, argsPreview: '', status, requestedAt: base, ...(startedAt !== undefined ? { startedAt } : {}) };
}

describe('mergeLiveTurns', () => {
	it('returns persisted turns untouched when there is no live data', () => {
		const turns = [persisted(0, 'a', 'completed'), persisted(1, 'b', 'working')];
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 2, live: [], now: base });
		assert.deepEqual(result.turns, turns);
		assert.equal(result.turnCount, 2);
		assert.equal(result.status, 'working');
		assert.equal(result.unpersistedTurns, 0);
	});

	it('appends live turns VS Code has not persisted yet', () => {
		const turns = [persisted(0, 'a', 'completed')];
		const newTurn = live(1, 'b', 'working', { assistantText: 'Working on b', thinking: 'hmm', tools: [tool('c1', 'read_file', 'completed', base)] });
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 1, live: [live(0, 'a', 'completed'), newTurn], now: base });
		assert.equal(result.turns.length, 2);
		assert.equal(result.turnCount, 2);
		assert.equal(result.unpersistedTurns, 1);
		const appended = result.turns[1];
		assert.equal(appended.editable, false);
		assert.equal(appended.userText, 'b');
		assert.equal(appended.status, 'working');
		assert.equal(appended.assistantText, 'Working on b');
		assert.deepEqual(appended.blocks.map(block => block.kind), ['thinking', 'activity', 'text']);
		assert.equal(appended.activities[0].status, 'completed');
		assert.equal(result.status, 'working');
	});

	it('overlays live progress onto a persisted turn that is still working', () => {
		const turns = [persisted(0, 'a', 'working', { assistantText: 'Partial', blocks: [{ kind: 'text', text: 'Partial' }] })];
		const liveTurn = live(0, 'a', 'working', {
			assistantText: 'Partial answer continues',
			tools: [tool('t1', 'run_in_terminal', 'running', base - 10_000)],
		});
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 1, live: [liveTurn], now: base });
		const merged = result.turns[0];
		assert.equal(merged.assistantText, 'Partial answer continues');
		assert.equal(merged.status, 'working');
		assert.deepEqual(merged.activities.map(activity => [activity.toolId, activity.status, activity.canApprove]), [['run_in_terminal', 'running', true]]);
		assert.deepEqual(merged.blocks.map(block => block.kind), ['text', 'activity', 'text']);
		assert.equal((merged.blocks[2] as { text: string }).text, 'answer continues');
	});

	it('marks a working persisted turn completed when the live source saw the final round', () => {
		const turns = [persisted(0, 'a', 'working')];
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 1, live: [live(0, 'a', 'completed', { completedAt: base + 5 })], now: base });
		assert.equal(result.turns[0].status, 'completed');
		assert.equal(result.turns[0].completedAt, base + 5);
		assert.equal(result.status, 'idle');
	});

	it('never overrides a sealed persisted turn', () => {
		const turns = [persisted(0, 'a', 'cancelled', { assistantText: 'final' })];
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 1, live: [live(0, 'a', 'working', { assistantText: 'much longer live text' })], now: base });
		assert.equal(result.turns[0].status, 'cancelled');
		assert.equal(result.turns[0].assistantText, 'final');
	});

	it('does not pair a new live turn with an old persisted turn that has the same text', () => {
		const turns = [persisted(0, 'continue', 'completed'), persisted(1, 'do more', 'completed')];
		const later = live(5, 'continue', 'working', { startedAt: base + 30 * 60_000 });
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 2, live: [later], now: base });
		assert.equal(result.turns.length, 3);
		assert.equal(result.turns[2].userText, 'continue');
		assert.equal(result.turns[2].status, 'working');
	});

	it('aligns a live source that only covers the newest turns', () => {
		const turns = [persisted(0, 'a', 'completed'), persisted(1, 'b', 'completed'), persisted(2, 'c', 'working')];
		const result = mergeLiveTurns({
			persisted: turns, persistedStart: 10, persistedCount: 13,
			live: [live(1, 'b', 'completed'), live(2, 'c', 'working', { assistantText: 'live c' })],
			now: base,
		});
		assert.equal(result.turns.length, 3);
		assert.equal(result.turns[2].assistantText, 'live c');
		assert.equal(result.historyStart, 10);
		assert.equal(result.turnCount, 13);
	});

	it('completes a persisted running activity when the live source saw it finish', () => {
		const running = { id: 'call_1__vscode-4', label: 'Running', status: 'running' as const, toolId: 'read_file' };
		const turns = [persisted(0, 'a', 'working', { activities: [running], blocks: [{ kind: 'activity', activity: running }] })];
		const result = mergeLiveTurns({ persisted: turns, persistedStart: 0, persistedCount: 1, live: [live(0, 'a', 'working', { tools: [tool('call_1', 'read_file', 'completed', base)] })], now: base });
		assert.equal(result.turns[0].activities.length, 1);
		assert.equal(result.turns[0].activities[0].status, 'completed');
		assert.equal((result.turns[0].blocks[0] as { activity: { status: string } }).activity.status, 'completed');
	});

	it('only offers approval for tools that have been outstanding for a while', () => {
		const fresh = live(0, 'a', 'working', { tools: [tool('t1', 'run_in_terminal', 'running', base - 500)] });
		const result = mergeLiveTurns({ persisted: [], persistedStart: 0, persistedCount: 0, live: [fresh], now: base });
		assert.equal(result.turns[0].activities[0].canApprove, undefined);
	});
});
