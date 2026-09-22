import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { progressiveSupplementGraceMs, shouldPreserveProgressiveSession } from '../progressiveSessionPolicy';

describe('shouldPreserveProgressiveSession', () => {
	it('preserves an in-flight mutation index across fallback polls', () => {
		assert.equal(shouldPreserveProgressiveSession({
			primarySize: 100,
			primaryMtimeMs: 20,
			supplementPresent: false,
			now: 1_000,
			mutationIndexing: true,
		}), true);
	});

	it('preserves rendered transcript history during a transient supplement gap', () => {
		assert.equal(shouldPreserveProgressiveSession({
			currentRevision: 'progressive:100:20|50:30',
			primarySize: 100,
			primaryMtimeMs: 20,
			supplementPresent: false,
			supplementMissingSince: 1_000,
			now: 1_000 + progressiveSupplementGraceMs,
			mutationIndexing: false,
		}), true);
	});

	it('does not preserve stale history after a source change or expired grace', () => {
		assert.equal(shouldPreserveProgressiveSession({
			currentRevision: 'progressive:100:20|50:30',
			primarySize: 101,
			primaryMtimeMs: 21,
			supplementPresent: false,
			supplementMissingSince: 1_000,
			now: 1_100,
			mutationIndexing: false,
		}), false);
		assert.equal(shouldPreserveProgressiveSession({
			currentRevision: 'progressive:100:20|50:30',
			primarySize: 100,
			primaryMtimeMs: 20,
			supplementPresent: false,
			supplementMissingSince: 1_000,
			now: 1_001 + progressiveSupplementGraceMs,
			mutationIndexing: false,
		}), false);
	});
});