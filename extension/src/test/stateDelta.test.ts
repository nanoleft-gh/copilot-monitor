import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPatch, diffValue, isPatch, Patch } from '../stateDelta';

function roundTrip(previous: unknown, next: unknown): Patch | undefined {
	const patch = diffValue(previous, next);
	if (patch === undefined) {
		assert.deepEqual(previous, next, 'no patch means equal');
		return undefined;
	}
	assert.ok(isPatch(patch));
	const wire = JSON.parse(JSON.stringify(patch)) as Patch;
	const result = applyPatch(previous, wire);
	// Compare as JSON: `undefined` members never exist on the wire, and untouched subtrees may be shared.
	assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(next)));
	return patch;
}

describe('stateDelta', () => {
	it('emits nothing for equal values and replaces values of different kinds', () => {
		assert.equal(diffValue({ a: [1, 'x'] }, { a: [1, 'x'] }), undefined);
		assert.deepEqual(roundTrip(1, 'one'), ['=', 'one']);
		assert.deepEqual(roundTrip([1], { 0: 1 }), ['=', { 0: 1 }]);
		assert.deepEqual(roundTrip(null, { x: 1 }), ['=', { x: 1 }]);
		assert.deepEqual(roundTrip({ x: 1 }, null), ['=', null]);
	});

	it('appends to strings that only grew and replaces others', () => {
		assert.deepEqual(roundTrip('Hello', 'Hello, world'), ['+', ', world']);
		assert.deepEqual(roundTrip('', 'abc'), ['=', 'abc']);
		assert.deepEqual(roundTrip('abc', 'abd'), ['=', 'abd']);
		assert.deepEqual(roundTrip('abc', 'ab'), ['=', 'ab']);
	});

	it('patches object members individually, including deletions and undefined members', () => {
		const patch = roundTrip(
			{ keep: 1, change: 'a', drop: true, wasUndefined: undefined },
			{ keep: 1, change: 'ab', added: [1], wasUndefined: 'now' },
		);
		assert.deepEqual(patch, ['o', { drop: ['-'], change: ['+', 'b'], added: ['=', [1]], wasUndefined: ['=', 'now'] }]);
		// Setting a member to undefined is a deletion on the wire.
		assert.deepEqual(roundTrip({ a: 1, b: 2 }, { a: 1, b: undefined }), ['o', { b: ['-'] }]);
		// An undefined member on both sides is not a change.
		assert.equal(diffValue({ a: undefined }, { a: undefined }), undefined);
	});

	it('patches arrays positionally when their keys are stable', () => {
		const previous = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
		const next = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two more' }];
		assert.deepEqual(roundTrip(previous, next), ['a', 2, { 1: ['o', { text: ['+', ' more'] }] }]);
		assert.deepEqual(roundTrip([1, 2, 3], [1, 2]), ['a', 2, {}]);
		assert.deepEqual(roundTrip([1, 2], [1, 2, 3]), ['a', 3, { 2: ['=', 3] }]);
		assert.deepEqual(roundTrip(['x', 'y'], ['x', 'z']), ['a', 2, { 1: ['=', 'z'] }]);
	});

	it('patches keyed arrays by key so a sliding window only sends the new item', () => {
		const previous = [{ id: 't1', text: 'first' }, { id: 't2', text: 'second' }, { id: 't3', text: 'third' }];
		const next = [{ id: 't2', text: 'second' }, { id: 't3', text: 'third!' }, { id: 't4', text: 'fourth' }];
		const patch = roundTrip(previous, next);
		assert.deepEqual(patch, ['k', ['id:t2', 'id:t3', 'id:t4'], {
			'id:t3': ['o', { text: ['+', '!'] }],
			'id:t4': ['=', { id: 't4', text: 'fourth' }],
		}]);
		// Reordering reuses items without resending them.
		assert.deepEqual(roundTrip(previous, [previous[2], previous[0], previous[1]]), ['k', ['id:t3', 'id:t1', 'id:t2'], {}]);
		// Other identifying properties work too, and mixed/duplicate keys fall back to positions.
		assert.deepEqual(
			roundTrip([{ resource: 'r1' }, { resource: 'r2' }], [{ resource: 'r2' }]),
			['k', ['resource:r2'], {}],
		);
		assert.deepEqual(
			roundTrip([{ id: 'dup' }, { id: 'dup' }], [{ id: 'dup' }])?.[0],
			'a',
		);
		assert.deepEqual(roundTrip([{ id: 'a' }, 5], [5])?.[0], 'a');
	});

	it('applies patches without mutating the previous value and shares untouched subtrees', () => {
		const previous = { list: [{ id: 'a', nested: { deep: 1 } }, { id: 'b', nested: { deep: 2 } }], other: { untouched: true } };
		const snapshot = JSON.parse(JSON.stringify(previous));
		const next = { list: [{ id: 'a', nested: { deep: 1 } }, { id: 'b', nested: { deep: 3 } }], other: { untouched: true } };
		const result = applyPatch(previous, diffValue(previous, next)!) as typeof previous;
		assert.deepEqual(result, next);
		assert.deepEqual(previous, snapshot);
		assert.equal(result.other, previous.other, 'untouched subtree is shared');
		assert.equal(result.list[0], previous.list[0], 'untouched array item is shared');
	});

	it('rejects malformed or inapplicable patches', () => {
		assert.throws(() => applyPatch('text', ['o', {}]));
		assert.throws(() => applyPatch({ a: 1 }, ['+', 'x']));
		assert.throws(() => applyPatch([1], ['a', 2, {}]), /unfilled/);
		assert.throws(() => applyPatch([1], ['a', 1, { 5: ['=', 1] }]), /out of range/);
		assert.throws(() => applyPatch([{ id: 'a' }], ['k', ['id:zzz'], {}]), /unknown item/);
		assert.throws(() => applyPatch(1, ['-']));
		assert.throws(() => applyPatch(1, ['?'] as unknown as Patch));
		assert.equal(isPatch(['o', 5]), false);
		assert.equal(isPatch(['a', -1, {}]), false);
		assert.equal(isPatch('nope'), false);
	});

	it('round-trips random state mutations (fuzz)', () => {
		let seed = 0x2f6e2b1;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
			return seed / 0x7fff_ffff;
		};
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
		const word = () => pick(['alpha', 'beta', 'gamma', 'δέλτα', '日本', '', 'x']);
		const makeTurn = (id: number) => ({
			id: `t${id}`,
			userText: word(),
			assistantText: word(),
			status: pick(['working', 'completed']),
			activities: Array.from({ length: Math.floor(random() * 3) }, (_, index) => ({ id: `${id}-${index}`, label: word(), output: word() })),
			maybe: random() < 0.5 ? undefined : { n: Math.floor(random() * 10) },
		});
		type Turn = ReturnType<typeof makeTurn>;
		type State = { turns: Turn[]; title: string; count: number; tags: string[] };

		let state: State = { turns: [makeTurn(1), makeTurn(2)], title: 'start', count: 0, tags: ['a', 'b'] };
		let nextId = 3;
		for (let step = 0; step < 400; step++) {
			const turns = state.turns.map(turn => ({ ...turn, activities: turn.activities.map(activity => ({ ...activity })) }));
			switch (Math.floor(random() * 9)) {
				case 0: turns.push(makeTurn(nextId++)); break;
				case 1: if (turns.length > 1) { turns.shift(); } break;
				case 2: if (turns.length) { const last = turns[turns.length - 1]; last.assistantText += word(); } break;
				case 3: if (turns.length) { turns[Math.floor(random() * turns.length)].status = 'completed'; } break;
				case 4: if (turns.length) { const turn = pick(turns); turn.activities.push({ id: `${turn.id}-${turn.activities.length}`, label: word(), output: '' }); } break;
				case 5: if (turns.length) { const turn = pick(turns); if (turn.activities.length) { pick(turn.activities).output += word(); } } break;
				case 6: if (turns.length > 1) { turns.reverse(); } break;
				case 7: if (turns.length) { turns[turns.length - 1] = { ...turns[turns.length - 1], id: `renamed-${nextId++}` }; } break;
				default: break;
			}
			const next: State = {
				turns,
				title: random() < 0.2 ? state.title + word() : state.title,
				count: state.count + (random() < 0.3 ? 1 : 0),
				tags: random() < 0.1 ? [...state.tags, word()] : state.tags,
			};
			roundTrip(state, next);
			state = next;
		}
	});
});
