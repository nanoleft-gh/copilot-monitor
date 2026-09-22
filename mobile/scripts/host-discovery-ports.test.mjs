import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoveryPorts } from '../src/transport/host-discovery-ports.ts';

describe('discoveryPorts', () => {
  it('tries the saved custom gateway port before the default', () => {
    assert.deepEqual(discoveryPorts('http://10.255.172.59:2643/'), [2643, 43121]);
  });

  it('does not probe the default port twice', () => {
    assert.deepEqual(discoveryPorts('http://192.168.1.12:43121/'), [43121]);
  });

  it('retains a default recovery port for invalid legacy data', () => {
    assert.deepEqual(discoveryPorts('not a URL'), [43121]);
  });
});