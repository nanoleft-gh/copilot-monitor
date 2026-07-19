import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveSessionState } from '../protocol';
import { SessionStateCache } from '../sessionStateCache';
import type { TranscriptTurn } from '../transcript';

function turn(id: string, timestamp: number, status: TranscriptTurn['status'] = 'completed'): TranscriptTurn {
	return {
		id,
		editable: true,
		timestamp,
		userText: id,
		thinking: '',
		thinkingTitle: '',
		assistantText: status === 'working' ? 'partial' : 'complete',
		activities: [],
		blocks: [],
		status,
	};
}

function session(resource: string, title: string, turns: TranscriptTurn[], revision: string): ActiveSessionState {
	return {
		resource,
		sessionId: resource,
		title,
		status: turns.some(candidate => candidate.status === 'working') ? 'working' : 'idle',
		revision,
		updatedAt: turns.at(-1)?.timestamp,
		turns,
		permissionLevel: 'default',
	};
}

describe('SessionStateCache', () => {
	it('cannot poison another persisted path with a hot export', () => {
		const cache = new SessionStateCache();
		const greeting = session('greeting-resource', 'General greeting', [turn('g1', 1)], 'g-disk');
		const hi = session('hi-resource', 'hi', [turn('h1', 2)], 'h-disk');
		cache.upsertPersisted('greeting.jsonl', greeting);
		cache.upsertPersisted('hi.jsonl', hi);

		cache.applyLive(session('hi-resource', 'wrong export title', [turn('h1', 2), turn('h2', 3, 'working')], 'h-live'));

		const visible = cache.getVisibleSessions();
		assert.deepEqual(new Set(visible.map(candidate => candidate.resource)), new Set(['greeting-resource', 'hi-resource']));
		assert.equal(visible.find(candidate => candidate.resource === 'greeting-resource')?.title, 'General greeting');
		assert.deepEqual(visible.find(candidate => candidate.resource === 'greeting-resource')?.turns.map(candidate => candidate.id), ['g1']);
		assert.equal(visible.find(candidate => candidate.resource === 'hi-resource')?.title, 'hi');
		assert.deepEqual(visible.find(candidate => candidate.resource === 'hi-resource')?.turns.map(candidate => candidate.id), ['h1', 'h2']);
	});

	it('deduplicates persisted paths that resolve to the same resource', () => {
		const cache = new SessionStateCache();
		cache.upsertPersisted('old.jsonl', session('same-resource', 'Old', [turn('r1', 1)], 'old'));
		cache.upsertPersisted('new.jsonl', session('same-resource', 'New', [turn('r1', 1), turn('r2', 2)], 'new'));
		assert.deepEqual(cache.getVisibleSessions().map(candidate => candidate.title), ['New']);
	});

	it('drops a live overlay when persisted state catches up', () => {
		const cache = new SessionStateCache();
		cache.upsertPersisted('hi.jsonl', session('hi-resource', 'hi', [turn('h1', 1)], 'disk-1'));
		cache.applyLive(session('hi-resource', 'ignored', [turn('h1', 1), turn('h2', 2, 'working')], 'live'));
		cache.upsertPersisted('hi.jsonl', session('hi-resource', 'hi', [turn('h1', 1), turn('h2', 2, 'completed')], 'disk-2'));
		assert.equal(cache.getVisibleSessions()[0].revision, 'disk-2');
		assert.equal(cache.getVisibleSessions()[0].status, 'idle');
	});

	it('keeps both sessions isolated through rapid alternating live updates', () => {
		const cache = new SessionStateCache();
		cache.upsertPersisted('greeting.jsonl', session('greeting-resource', 'General greeting', [turn('g1', 1)], 'g-disk'));
		cache.upsertPersisted('hi.jsonl', session('hi-resource', 'hi', [turn('h1', 2)], 'h-disk'));

		cache.applyLive(session('hi-resource', 'ignored', [turn('h1', 2), turn('h2', 3, 'working')], 'h-live-1'));
		cache.applyLive(session('greeting-resource', 'ignored', [turn('g1', 1), turn('g2', 4, 'working')], 'g-live'));
		cache.applyLive(session('hi-resource', 'ignored', [turn('h1', 2), turn('h2', 3), turn('h3', 5, 'working')], 'h-live-2'));

		const visible = cache.getVisibleSessions();
		assert.equal(visible.length, 2);
		assert.deepEqual(visible.find(candidate => candidate.resource === 'greeting-resource')?.turns.map(candidate => candidate.id), ['g1', 'g2']);
		assert.deepEqual(visible.find(candidate => candidate.resource === 'hi-resource')?.turns.map(candidate => candidate.id), ['h1', 'h2', 'h3']);
		assert.equal(visible.find(candidate => candidate.resource === 'greeting-resource')?.title, 'General greeting');
		assert.equal(visible.find(candidate => candidate.resource === 'hi-resource')?.title, 'hi');
	});

	it('updates the selected model only for the exact session resource', () => {
		const cache = new SessionStateCache();
		cache.upsertPersisted('first.jsonl', session('first-resource', 'First', [turn('f1', 1)], 'first'));
		cache.upsertPersisted('second.jsonl', session('second-resource', 'Second', [turn('s1', 2)], 'second'));
		cache.updateModel('second-resource', {
			selectedModelId: 'copilot/model-b',
			selectedModelName: 'Model B',
			configuration: {},
			configurationFields: [],
			configurationWritable: true,
		});

		assert.equal(cache.getVisibleSessions().find(candidate => candidate.resource === 'first-resource')?.model, undefined);
		assert.equal(cache.getVisibleSessions().find(candidate => candidate.resource === 'second-resource')?.model?.selectedModelId, 'copilot/model-b');
	});

	it('keeps persisted model and approval controls over a stale live transcript overlay', () => {
		const cache = new SessionStateCache();
		const persisted = {
			...session('chat-resource', 'Chat', [turn('r1', 1)], 'disk'),
			model: {
				selectedModelId: 'copilot/model-b',
				selectedModelName: 'Model B',
				configuration: { reasoningEffort: 'high' },
				configurationFields: [],
				configurationWritable: true,
			},
			permissionLevel: 'autopilot' as const,
		};
		const staleLive = {
			...session('chat-resource', 'ignored', [turn('r1', 1), turn('r2', 2, 'working')], 'live'),
			model: {
				selectedModelId: 'copilot/model-a',
				selectedModelName: 'Model A',
				configuration: { reasoningEffort: 'low' },
				configurationFields: [],
				configurationWritable: true,
			},
			permissionLevel: 'default' as const,
		};
		cache.upsertPersisted('chat.jsonl', persisted);
		cache.applyLive(staleLive);

		const visible = cache.getVisibleSessions()[0];
		assert.equal(visible.model?.selectedModelId, 'copilot/model-b');
		assert.equal(visible.model?.configuration.reasoningEffort, 'high');
		assert.equal(visible.permissionLevel, 'autopilot');
		assert.deepEqual(visible.turns.map(candidate => candidate.id), ['r1', 'r2']);
	});

	it('shows an empty transient chat until its persisted session appears', () => {
		const cache = new SessionStateCache();
		cache.upsertTransient(session('new-resource', 'New chat', [], 'transient'));
		assert.deepEqual(cache.getVisibleSessions().map(candidate => candidate.resource), ['new-resource']);
		cache.upsertPersisted('new.jsonl', session('new-resource', 'Persisted chat', [turn('n1', 2)], 'disk'));
		assert.deepEqual(cache.getVisibleSessions().map(candidate => candidate.title), ['Persisted chat']);
	});
});