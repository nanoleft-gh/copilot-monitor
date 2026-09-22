/**
 * Applies `/api/events?v=2` patches. Mirrors `extension/src/stateDelta.ts`:
 *
 *   ['=', value]              replace
 *   ['-']                     delete (only inside 'o')
 *   ['+', suffix]             string append
 *   ['o', { key: patch }]     object members
 *   ['a', length, { i: p }]   positional array: resize to `length`, patch indices
 *   ['k', keys, { key: p }]   keyed array: rebuild in `keys` order from the previous items
 */
export type Patch =
  | readonly ['=', unknown]
  | readonly ['-']
  | readonly ['+', string]
  | readonly ['o', Readonly<Record<string, Patch>>]
  | readonly ['a', number, Readonly<Record<string, Patch>>]
  | readonly ['k', readonly string[], Readonly<Record<string, Patch>>];

const keyProperties = ['id', 'resource', 'windowId', 'identifier'] as const;

export function applyPatch(previous: unknown, patch: Patch): unknown {
  switch (patch[0]) {
    case '=':
      return patch[1];
    case '-':
      throw new Error('A delete patch is only valid inside an object patch.');
    case '+':
      if (typeof previous !== 'string') throw new Error('Cannot append to a non-string value.');
      return previous + patch[1];
    case 'o': {
      if (!isPlainObject(previous)) throw new Error('Cannot patch members of a non-object value.');
      const result: Record<string, unknown> = { ...previous };
      for (const [key, member] of Object.entries(patch[1])) {
        if (member[0] === '-') delete result[key];
        else result[key] = applyPatch(previous[key], member);
      }
      return result;
    }
    case 'a': {
      if (!Array.isArray(previous)) throw new Error('Cannot patch indices of a non-array value.');
      const length = patch[1];
      const result: unknown[] = previous.slice(0, length);
      for (const [index, member] of Object.entries(patch[2])) {
        const position = Number(index);
        if (!Number.isInteger(position) || position < 0 || position >= length) {
          throw new Error(`Array patch index ${index} is out of range.`);
        }
        result[position] = applyPatch(position < previous.length ? previous[position] : undefined, member);
      }
      if (result.length !== length) throw new Error('Array patch left unfilled indices.');
      for (let index = 0; index < length; index++) {
        if (!(index in result)) throw new Error(`Array patch left index ${index} unfilled.`);
      }
      return result;
    }
    case 'k': {
      if (!Array.isArray(previous)) throw new Error('Cannot apply a keyed patch to a non-array value.');
      const byKey = new Map<string, unknown>();
      for (const item of previous) {
        const key = keyOf(item);
        if (key !== undefined && !byKey.has(key)) byKey.set(key, item);
      }
      return patch[1].map(key => {
        const member = patch[2][key];
        if (member) return applyPatch(byKey.get(key), member);
        if (!byKey.has(key)) throw new Error(`Keyed patch references unknown item ${key}.`);
        return byKey.get(key);
      });
    }
    default:
      throw new Error(`Unknown patch operation ${String((patch as readonly unknown[])[0])}.`);
  }
}

export function isPatch(value: unknown): value is Patch {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'string') return false;
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

function keyOf(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined;
  for (const property of keyProperties) {
    const value = item[property];
    if (typeof value === 'string') return `${property}:${value}`;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
