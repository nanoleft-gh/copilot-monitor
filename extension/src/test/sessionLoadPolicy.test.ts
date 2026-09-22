import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSessionLoads } from '../sessionLoadPolicy';

describe('planSessionLoads', () => {
	it('loads newest sessions until the workspace budget is exhausted', () => {
		assert.deepEqual(planSessionLoads([
			{ resource: 'newest', size: 6 },
			{ resource: 'second', size: 4 },
			{ resource: 'archived', size: 1 },
		], undefined, 10, 10), [true, true, false]);
	});

	it('prioritizes an active safe session without loading skipped history', () => {
		assert.deepEqual(planSessionLoads([
			{ resource: 'newest', size: 8 },
			{ resource: 'middle', size: 8 },
			{ resource: 'active', size: 8 },
		], 'active', 10, 16), [true, false, true]);
	});

	it('reserves workspace bytes for the active session before newer history', () => {
		assert.deepEqual(planSessionLoads([
			{ resource: 'newest', size: 8 },
			{ resource: 'active', size: 8 },
		], 'active', 10, 10), [false, true]);
	});

	it('does not charge an oversized active session against the workspace budget', () => {
		assert.deepEqual(planSessionLoads([
			{ resource: 'oversized', size: 20 },
			{ resource: 'recent', size: 6 },
		], 'oversized', 10, 10), [false, true]);
	});
});