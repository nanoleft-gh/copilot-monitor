import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveSessionState, ToolDecisionRequest } from '../protocol';
import { isActivePendingTool } from '../toolDecision';
import type { TranscriptActivity, TranscriptTurn } from '../transcript';

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

function turn(id: string, activities: TranscriptActivity[]): TranscriptTurn {
	return {
		id,
		editable: true,
		timestamp: 1,
		userText: id,
		thinking: '',
		thinkingTitle: '',
		assistantText: '',
		activities,
		blocks: [],
		status: 'working',
	};
}