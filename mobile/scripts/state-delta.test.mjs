import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPatch, isPatch } from '../src/transport/state-delta.ts';

describe('applyPatch', () => {
  it('applies the v2 gateway patch grammar', () => {
    const previous = {
      version: 2,
      windows: [
        { windowId: 'w1', sessions: [{ resource: 'a', turns: [{ id: 't1', assistantText: 'Hel' }, { id: 't2', assistantText: '' }] }] },
        { windowId: 'w2', sessions: [] },
      ],
    };
    const patch = ['o', {
      windows: ['k', ['windowId:w2', 'windowId:w1'], {
        'windowId:w1': ['o', {
          sessions: ['a', 1, {
            0: ['o', {
              turns: ['k', ['id:t2', 'id:t3'], {
                'id:t2': ['o', { assistantText: ['+', 'lo'] }],
                'id:t3': ['=', { id: 't3', assistantText: 'new' }],
              }],
            }],
          }],
        }],
      }],
    }];
    assert.ok(isPatch(patch));
    const next = applyPatch(previous, patch);
    assert.deepEqual(next, {
      version: 2,
      windows: [
        { windowId: 'w2', sessions: [] },
        { windowId: 'w1', sessions: [{ resource: 'a', turns: [{ id: 't2', assistantText: 'lo' }, { id: 't3', assistantText: 'new' }] }] },
      ],
    });
    // The previous state is untouched and untouched subtrees are shared.
    assert.equal(previous.windows[0].sessions[0].turns[0].assistantText, 'Hel');
    assert.equal(next.windows[0], previous.windows[1]);
  });

  it('rejects patches that cannot be applied so the caller resyncs', () => {
    assert.throws(() => applyPatch({ a: 1 }, ['+', 'x']));
    assert.throws(() => applyPatch([{ id: 'a' }], ['k', ['id:missing'], {}]));
    assert.throws(() => applyPatch([1], ['a', 2, {}]));
    assert.equal(isPatch(['o', []]), false);
    assert.equal(isPatch(null), false);
  });
});
