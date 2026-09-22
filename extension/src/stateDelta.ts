/**
 * Compact JSON state deltas for the `/api/events?v=2` stream.
 *
 * The server keeps the last state each client has seen and sends a patch that turns it into
 * the next state. Patches are plain JSON tuples so a browser, React Native, or another
 * extension host can apply them with `applyPatch` (or a direct port of it):
 *
 *   ['=', value]              replace the value
 *   ['-']                     delete this object property
 *   ['+', suffix]             append to a string (streaming assistant text / tool output)
 *   ['o', { key: patch }]     patch object members
 *   ['a', length, { i: p }]   positional array patch: resize to `length`, then patch indices
 *   ['k', keys, { key: p }]   keyed array patch: rebuild in `keys` order from the previous items
 *                             (looked up by their key), applying `p` where present
 *
 * Keyed patches keep a sliding window of turns cheap: when the oldest turn drops out and a new
 * one arrives, only the key list and the new turn travel — the surviving turns are reused.
 *
 * `undefined` members are treated as absent on both sides, matching `JSON.stringify`.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type Patch =
	| readonly ['=', unknown]
	| readonly ['-']
	| readonly ['+', string]
	| readonly ['o', Readonly<Record<string, Patch>>]
	| readonly ['a', number, Readonly<Record<string, Patch>>]
	| readonly ['k', readonly string[], Readonly<Record<string, Patch>>];

/** Property names that identify array elements, in priority order. */
const keyProperties = ['id', 'resource', 'windowId', 'identifier'] as const;

/** Returns the patch turning `previous` into `next`, or `undefined` when they are equal. */
export function diffValue(previous: unknown, next: unknown): Patch | undefined {
	if (previous === next) {
		return undefined;
	}
	if (typeof previous === 'string' && typeof next === 'string') {
		if (previous.length > 0 && next.length > previous.length && next.startsWith(previous)) {
			return ['+', next.slice(previous.length)];
		}
		return ['=', next];
	}
	if (Array.isArray(previous) && Array.isArray(next)) {
		return diffArray(previous, next);
	}
	if (isPlainObject(previous) && isPlainObject(next)) {
		return diffObject(previous, next);
	}
	if (typeof previous === 'number' && typeof next === 'number' && Number.isNaN(previous) && Number.isNaN(next)) {
		return undefined;
	}
	return ['=', next];
}

function diffObject(previous: Record<string, unknown>, next: Record<string, unknown>): Patch | undefined {
	const members: Record<string, Patch> = {};
	let changed = false;
	for (const key of Object.keys(previous)) {
		if (previous[key] !== undefined && next[key] === undefined) {
			members[key] = ['-'];
			changed = true;
		}
	}
	for (const key of Object.keys(next)) {
		const value = next[key];
		if (value === undefined) {
			continue;
		}
		const patch = previous[key] === undefined ? (['=', value] as const) : diffValue(previous[key], value);
		if (patch) {
			members[key] = patch;
			changed = true;
		}
	}
	return changed ? ['o', members] : undefined;
}

function diffArray(previous: readonly unknown[], next: readonly unknown[]): Patch | undefined {
	const previousKeys = keysOf(previous);
	const nextKeys = previousKeys ? keysOf(next) : undefined;
	if (previousKeys && nextKeys && !sameSequence(previousKeys, nextKeys)) {
		const byKey = new Map<string, unknown>();
		previousKeys.forEach((key, index) => byKey.set(key, previous[index]));
		const members: Record<string, Patch> = {};
		nextKeys.forEach((key, index) => {
			const item = next[index];
			if (!byKey.has(key)) {
				members[key] = ['=', item];
				return;
			}
			const patch = diffValue(byKey.get(key), item);
			if (patch) {
				members[key] = patch;
			}
		});
		return ['k', nextKeys, members];
	}

	const members: Record<string, Patch> = {};
	let changed = previous.length !== next.length;
	const shared = Math.min(previous.length, next.length);
	for (let index = 0; index < shared; index++) {
		const patch = diffValue(previous[index], next[index]);
		if (patch) {
			members[index] = patch;
			changed = true;
		}
	}
	for (let index = shared; index < next.length; index++) {
		members[index] = ['=', next[index]];
	}
	return changed ? ['a', next.length, members] : undefined;
}

/** Applies `patch` to `previous` without mutating it; untouched subtrees are shared. */
export function applyPatch(previous: unknown, patch: Patch): unknown {
	switch (patch[0]) {
		case '=':
			return patch[1];
		case '-':
			throw new Error('A delete patch is only valid inside an object patch.');
		case '+':
			if (typeof previous !== 'string') {
				throw new Error('Cannot append to a non-string value.');
			}
			return previous + patch[1];
		case 'o': {
			if (!isPlainObject(previous)) {
				throw new Error('Cannot patch members of a non-object value.');
			}
			const result: Record<string, unknown> = { ...previous };
			for (const [key, member] of Object.entries(patch[1])) {
				if (member[0] === '-') {
					delete result[key];
				} else {
					result[key] = applyPatch(previous[key], member);
				}
			}
			return result;
		}
		case 'a': {
			if (!Array.isArray(previous)) {
				throw new Error('Cannot patch indices of a non-array value.');
			}
			const length = patch[1];
			const result: unknown[] = previous.slice(0, length);
			for (const [index, member] of Object.entries(patch[2])) {
				const position = Number(index);
				if (!Number.isInteger(position) || position < 0 || position >= length) {
					throw new Error(`Array patch index ${index} is out of range.`);
				}
				result[position] = applyPatch(position < previous.length ? previous[position] : undefined, member);
			}
			if (result.length !== length) {
				throw new Error('Array patch left unfilled indices.');
			}
			for (let index = 0; index < length; index++) {
				if (!(index in result)) {
					throw new Error(`Array patch left index ${index} unfilled.`);
				}
			}
			return result;
		}
		case 'k': {
			if (!Array.isArray(previous)) {
				throw new Error('Cannot apply a keyed patch to a non-array value.');
			}
			const byKey = new Map<string, unknown>();
			for (const item of previous) {
				const key = keyOf(item);
				if (key !== undefined && !byKey.has(key)) {
					byKey.set(key, item);
				}
			}
			return patch[1].map(key => {
				const member = patch[2][key];
				if (member) {
					return applyPatch(byKey.get(key), member);
				}
				if (!byKey.has(key)) {
					throw new Error(`Keyed patch references unknown item ${key}.`);
				}
				return byKey.get(key);
			});
		}
		default:
			throw new Error(`Unknown patch operation ${String((patch as readonly unknown[])[0])}.`);
	}
}

/** Type guard for patches arriving over the wire. Shallow: nested patches are validated on apply. */
export function isPatch(value: unknown): value is Patch {
	if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'string') {
		return false;
	}
	switch (value[0]) {
		case '=': return value.length === 2;
		case '-': return value.length === 1;
		case '+': return value.length === 2 && typeof value[1] === 'string';
		case 'o': return value.length === 2 && isPlainObject(value[1]);
		case 'a': return value.length === 3 && Number.isInteger(value[1]) && value[1] >= 0 && isPlainObject(value[2]);
		case 'k': return value.length === 3 && Array.isArray(value[1]) && isPlainObject(value[2]);
		default: return false;
	}
}

function keysOf(items: readonly unknown[]): string[] | undefined {
	if (items.length === 0) {
		return [];
	}
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const key = keyOf(item);
		if (key === undefined || seen.has(key)) {
			return undefined;
		}
		seen.add(key);
		keys.push(key);
	}
	return keys;
}

function keyOf(item: unknown): string | undefined {
	if (!isPlainObject(item)) {
		return undefined;
	}
	for (const property of keyProperties) {
		const value = item[property];
		if (typeof value === 'string') {
			return `${property}:${value}`;
		}
	}
	return undefined;
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
