import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveSessionState } from '../protocol';
import { findMatchingSession } from '../sessionMatcher';
import type { Transcript, TranscriptTurn } from '../transcript';

function turn(id: string, userText = id): TranscriptTurn {
	return {
		id,
		editable: true,
		timestamp: 1,
		userText,
		thinking: '',
		thinkingTitle: '',
		assistantText: '',
		activities: [],
		blocks: [],
		status: 'completed',
	};
}

function session(resource: string, ids: string[]): ActiveSessionState {
	return {
		resource,
		sessionId: resource,
		title: resource,
		status: 'idle',
		revision: '',
		turns: ids.map(id => turn(id)),
		permissionLevel: 'default',
	};
}

function transcript(ids: string[]): Transcript {
	return {
		sessionId: '',
		title: 'Export',
		status: 'working',
		turns: ids.map(id => turn(id)),
	};
}

describe('findMatchingSession', () => {
	it('does not assign an unrelated export to a preferred-looking session', () => {
		const greeting = session('General greeting', ['g1', 'g2']);
		const hi = session('hi', ['h1', 'h2']);
		assert.equal(findMatchingSession([greeting, hi], transcript(['x1'])), undefined);
	});

	it('matches the session whose latest request continues in the export', () => {
		const greeting = session('General greeting', ['g1', 'g2']);
		const hi = session('hi', ['h1', 'h2']);
		assert.equal(findMatchingSession([greeting, hi], transcript(['h1', 'h2', 'h3'])), hi);
	});

	it('chooses the longest matching fork history', () => {
		const parent = session('parent', ['shared-1']);
		const child = session('child', ['shared-1', 'child-2']);
		assert.equal(findMatchingSession([parent, child], transcript(['shared-1', 'child-2', 'child-3'])), child);
	});

	it('rejects equal-overlap histories as ambiguous', () => {
		const first = session('first', ['shared-1']);
		const second = session('second', ['shared-1']);
		assert.equal(findMatchingSession([first, second], transcript(['shared-1', 'next'])), undefined);
	});
});