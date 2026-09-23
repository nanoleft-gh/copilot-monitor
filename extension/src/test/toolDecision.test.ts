import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveSessionState, ToolDecisionRequest } from '../protocol';
import { applyExportSnapshot, ExportSnapshot, exportMatchesSession, isActivePendingTool } from '../toolDecision';
import { pendingConfirmationToolIds, TranscriptActivity, TranscriptTurn } from '../transcript';

const pending: TranscriptActivity = {
	id: 'call-pending',
	label: 'Running command',
	status: 'waiting',
	canApprove: true,
};

describe('isActivePendingTool', () => {
	it('accepts only the first pending tool in the last response of the exact session', () => {
		const sessions = [session('session-1', [turn('request-old', [pending]), turn('request-current', [pending])])];
		assert.equal(isActivePendingTool(sessions, decision()), true);
	});

	it('rejects a running tool nobody confirmed is waiting', () => {
		const sessions = [session('session-1', [turn('request-current', [{ ...pending, status: 'running', canApprove: undefined }])])];
		assert.equal(isActivePendingTool(sessions, decision()), false);
	});

	it('rejects stale request, wrong session, completed tool, and second pending tool', () => {
		const sessions = [session('session-1', [turn('request-current', [
			pending,
			{ ...pending, id: 'call-second' },
		])])];
		assert.equal(isActivePendingTool(sessions, { ...decision(), requestId: 'request-old' }), false);
		assert.equal(isActivePendingTool(sessions, { ...decision(), sessionResource: 'session-2' }), false);
		assert.equal(isActivePendingTool(sessions, { ...decision(), toolCallId: 'call-second' }), false);
		assert.equal(isActivePendingTool([
			session('session-1', [turn('request-current', [{ ...pending, status: 'completed', canApprove: false }])]),
		], decision()), false);
	});
});

describe('pendingConfirmationToolIds', () => {
	it('reports only invocations the renderer has not confirmed and that have no result', () => {
		const request = {
			response: [
				{ value: 'text' },
				{ kind: 'toolInvocationSerialized', toolCallId: 'waiting', toolId: 'grep_search', isComplete: true },
				{ kind: 'toolInvocationSerialized', toolCallId: 'auto', toolId: 'grep_search', isComplete: true, isConfirmed: { type: 1 } },
				{ kind: 'toolInvocationSerialized', toolCallId: 'done', toolId: 'read_file', isComplete: true, resultDetails: {} },
				{ kind: 'toolInvocationSerialized', toolCallId: 'term-wait', toolId: 'run_in_terminal', toolSpecificData: { kind: 'terminal', confirmation: {} } },
				{ kind: 'toolInvocationSerialized', toolCallId: 'term-run', toolId: 'run_in_terminal', toolSpecificData: { kind: 'terminal', terminalCommandState: {} } },
			],
		};
		assert.deepEqual(pendingConfirmationToolIds(request), ['waiting', 'term-wait']);
	});
});

describe('applyExportSnapshot', () => {
	const snapshot = (pendingToolIds: string[], turnId = 'request-current'): ExportSnapshot => ({
		resource: 'session-1', turnId, pendingToolIds, model: undefined, capturedAt: 7,
	});
	const running: TranscriptActivity = { id: 'call-pending__vscode-3', label: 'Run', status: 'running', toolId: 'run_in_terminal' };

	it('marks only the confirmed-pending tool as approvable and keeps live content', () => {
		const live = session('session-1', [turn('request-current', [running, { ...running, id: 'call-other' }], 'streamed text')]);
		const result = applyExportSnapshot(live, snapshot(['call-pending']));
		const last = result.turns.at(-1)!;
		assert.deepEqual(last.activities.map(activity => [activity.id, activity.status, activity.canApprove]), [
			['call-pending__vscode-3', 'waiting', true],
			['call-other', 'running', undefined],
		]);
		assert.equal(last.assistantText, 'streamed text');
		assert.equal(result.revision, 'test+x7');
	});

	it('lets later live progress through: new text and tools are never replaced by the export', () => {
		const verdict = snapshot(['call-pending']);
		const later = session('session-1', [turn('request-current', [{ ...running, status: 'completed' }, { ...running, id: 'call-next' }], 'much more text')]);
		const result = applyExportSnapshot(later, verdict);
		assert.equal(result, later, 'the pending tool finished, so nothing is overlaid');
		assert.equal(result.turns.at(-1)!.activities.length, 2);
	});

	it('does not apply to a different or finished turn, or when nothing was pending', () => {
		const live = session('session-1', [turn('request-current', [running])]);
		assert.equal(applyExportSnapshot(live, snapshot([])), live);
		assert.equal(applyExportSnapshot(live, snapshot(['call-pending'], 'request-old')), live);
		const finished = session('session-1', [{ ...turn('request-current', [running]), status: 'completed' }]);
		assert.equal(applyExportSnapshot(finished, snapshot(['call-pending'])), finished);
		const liveOnly = session('session-1', [{ ...turn('live:1:0', [running]), editable: false }]);
		assert.equal(applyExportSnapshot(liveOnly, snapshot(['call-pending'])).turns[0].activities[0].canApprove, true, 'live-only turn ids are synthetic');
	});

	it('clears a stale approval once VS Code no longer holds the tool', () => {
		const shown = applyExportSnapshot(session('session-1', [turn('request-current', [running])]), snapshot(['call-pending']));
		assert.equal(shown.turns[0].activities[0].canApprove, true);
		const files = session('session-1', [turn('request-current', [running])]);
		const after = applyExportSnapshot(files, snapshot([]));
		assert.equal(after.turns[0].activities[0].canApprove, undefined, 'the next verdict replaces the previous one');
	});
});

describe('applyExportSnapshot preview', () => {
	const tool: TranscriptActivity = { id: 'call-1', label: 'Read file', status: 'running', toolId: 'read_file' };
	const withPreview = (preview: TranscriptTurn, pendingToolIds: string[] = []): ExportSnapshot => ({
		resource: 'session-1', turnId: 'request-current', pendingToolIds, model: undefined, capturedAt: 9, preview,
	});

	it('shows streaming text and thinking the files do not have yet, with tool status from the files', () => {
		const live = session('session-1', [turn('request-current', [tool], 'Hello')]);
		const preview: TranscriptTurn = {
			...turn('request-current', [], 'Hello, streaming world'),
			thinking: 'thinking more',
			activities: [{ ...tool, status: 'completed' }, { id: 'call-2', label: 'Search', status: 'completed' }],
			blocks: [
				{ kind: 'thinking', text: 'thinking more', title: '' },
				{ kind: 'activity', activity: { ...tool, status: 'completed' } },
				{ kind: 'text', text: 'Hello, streaming world' },
				{ kind: 'activity', activity: { id: 'call-2', label: 'Search', status: 'completed' } },
			],
		};
		const result = applyExportSnapshot(live, withPreview(preview));
		const last = result.turns.at(-1)!;
		assert.equal(last.assistantText, 'Hello, streaming world');
		assert.equal(last.thinking, 'thinking more');
		assert.deepEqual(last.blocks.map(block => block.kind), ['thinking', 'activity', 'text', 'activity']);
		assert.deepEqual(last.activities.map(activity => [activity.id, activity.status]), [
			['call-1', 'running'],
			['call-2', 'running'],
		], 'the export claims both complete; the files and block order say otherwise');
		assert.equal(last.status, 'working');
		assert.equal(result.revision, 'test+x9');
	});

	it('never holds back the files once they caught up', () => {
		const live = session('session-1', [turn('request-current', [tool], 'Hello, streaming world and more')]);
		const stale = turn('request-current', [], 'Hello, streaming');
		assert.equal(applyExportSnapshot(live, withPreview(stale)), live);
	});

	it('keeps tools only the files know and marks pending ones on the previewed turn', () => {
		const live = session('session-1', [turn('request-current', [tool, { id: 'call-3', label: 'Run', status: 'running' }], '')]);
		const preview = { ...turn('request-current', [], 'ahead'), blocks: [{ kind: 'text' as const, text: 'ahead' }] };
		const last = applyExportSnapshot(live, withPreview(preview, ['call-3'])).turns.at(-1)!;
		assert.deepEqual(last.activities.map(activity => [activity.id, activity.status, activity.canApprove]), [
			['call-1', 'running', undefined],
			['call-3', 'waiting', true],
		]);
		assert.equal(last.blocks.length, 3);
	});

	it('adopts a finished preview so the phone does not wait for the session log', () => {
		const live = session('session-1', [turn('request-current', [], 'Done')]);
		const finished = { ...turn('request-current', [], 'Done'), status: 'completed' as const, completedAt: 42 };
		const result = applyExportSnapshot(live, withPreview(finished));
		assert.equal(result.turns[0].status, 'completed');
		assert.equal(result.turns[0].completedAt, 42);
		assert.equal(result.status, 'idle');
	});

	it('ignores a preview of another turn', () => {
		const live = session('session-1', [turn('request-current', [], '')]);
		assert.equal(applyExportSnapshot(live, { ...withPreview(turn('request-other', [], 'text')), turnId: 'request-other' }), live);
	});
});

describe('exportMatchesSession', () => {
	it('requires every persisted request of the session to be in the export', () => {
		const watched = session('session-1', [turn('request-1', []), turn('request-2', []), { ...turn('live:1:0', []), editable: false }]);
		assert.equal(exportMatchesSession(['request-0', 'request-1', 'request-2', 'request-3'], watched), true);
		assert.equal(exportMatchesSession(['request-1'], watched), false);
		assert.equal(exportMatchesSession(['other-1', 'other-2'], watched), false);
		assert.equal(exportMatchesSession([], watched), false);
	});

	it('matches a chat with no persisted request yet only by its single prompt', () => {
		const fresh = session('session-1', [{ ...turn('live:1:0', []), userText: 'build it', editable: false }]);
		assert.equal(exportMatchesSession(['request-1'], fresh), false);
		assert.equal(exportMatchesSession(['request-1'], fresh, 'something else'), false);
		assert.equal(exportMatchesSession(['request-0', 'request-1'], fresh, 'build it'), false);
		assert.equal(exportMatchesSession(['request-1'], fresh, ' build it\n'), true);
	});
});

function decision(): ToolDecisionRequest {
	return {
		sessionResource: 'session-1',
		requestId: 'request-current',
		toolCallId: 'call-pending',
		decision: 'allow',
	};
}

function session(resource: string, turns: TranscriptTurn[]): ActiveSessionState {
	return {
		resource,
		sessionId: resource,
		title: resource,
		status: 'working',
		revision: 'test',
		turns,
		permissionLevel: 'default',
	};
}

function turn(id: string, activities: TranscriptActivity[], assistantText = ''): TranscriptTurn {
	return {
		id,
		editable: true,
		timestamp: 1,
		userText: id,
		thinking: '',
		thinkingTitle: '',
		assistantText,
		activities,
		blocks: activities.map(activity => ({ kind: 'activity' as const, activity })),
		status: 'working',
	};
}