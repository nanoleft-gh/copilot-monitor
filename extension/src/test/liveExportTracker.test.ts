import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LiveExportTracker } from '../liveExportTracker';
import type { TranscriptTurn } from '../transcript';

function turn(userText: string, timestamp: number, status: TranscriptTurn['status']): TranscriptTurn {
	return {
		id: `${timestamp}`,
		editable: true,
		timestamp,
		userText,
		thinking: '',
		thinkingTitle: '',
		assistantText: '',
		activities: [],
		blocks: [],
		status,
	};
}

describe('LiveExportTracker', () => {
	it('samples an idle persisted session while a dashboard turn is pending', () => {
		const tracker = new LiveExportTracker();
		tracker.begin('Explain queues', 'message-1', 10_000, 'session-1');
		assert.equal(tracker.shouldSample(false, 'idle', 10_200), true);
	});

	it('ignores an older duplicate prompt and completes on the new turn', () => {
		const tracker = new LiveExportTracker();
		tracker.begin('Repeat this', 'message-2', 20_000, 'session-2');
		assert.equal(tracker.observe('session-2', [turn('Repeat this', 5_000, 'completed')]), undefined);
		assert.deepEqual(
			tracker.observe('session-2', [
				turn('Repeat this', 5_000, 'completed'),
				turn('Repeat this', 20_100, 'completed'),
			]),
			{ userText: 'Repeat this', outboundMessageId: 'message-2', createdAt: 20_000, sessionResource: 'session-2' },
		);
		assert.equal(tracker.shouldSample(false, 'idle', 20_200), false);
	});

	it('keeps sampling through a transient empty cancellation', () => {
		const tracker = new LiveExportTracker();
		tracker.begin('Explain queues', 'message-3', 30_000, 'session-3');
		const cancelled = turn('Explain queues', 30_100, 'cancelled');
		assert.equal(tracker.observe('session-3', [cancelled]), undefined);
		assert.equal(tracker.shouldSample(false, 'idle', 30_200), true);
		const stabilized = tracker.stabilize('session-3', {
			sessionId: '',
			title: 'Explain queues',
			status: 'idle',
			turns: [cancelled],
		});
		assert.equal(stabilized.status, 'working');
		assert.equal(stabilized.turns[0].status, 'working');
	});

	it('cannot complete a pending turn from another session', () => {
		const tracker = new LiveExportTracker();
		tracker.begin('Same prompt', 'message-4', 40_000, 'session-a');
		assert.equal(tracker.observe('session-b', [turn('Same prompt', 40_100, 'completed')]), undefined);
		assert.equal(tracker.shouldSample(false, 'idle', 40_200), true);
	});
});