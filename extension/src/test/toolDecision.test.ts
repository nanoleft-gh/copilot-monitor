import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveSessionState, ToolDecisionRequest } from '../protocol';
import { applyExportSnapshot, ExportSnapshot, isActivePendingTool } from '../toolDecision';
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