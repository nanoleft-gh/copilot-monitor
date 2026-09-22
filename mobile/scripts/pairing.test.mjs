import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authHeaders, isLocalEndpoint, mergeEndpoints, parseGatewayHealth, parsePairingCode } from '../src/transport/pairing.ts';

describe('parsePairingCode', () => {
  it('splits the QR/link into gateway origin and fragment secret', () => {
    assert.deepEqual(parsePairingCode('http://192.168.1.10:43121/#k=se%2Fcr%2Bet'), { endpoint: 'http://192.168.1.10:43121/', secret: 'se/cr+et', alternates: [] });
    assert.deepEqual(parsePairingCode('  https://abc-43121.inc1.devtunnels.ms/x?y=1#k=tok '), { endpoint: 'https://abc-43121.inc1.devtunnels.ms/', secret: 'tok', alternates: [] });
    assert.deepEqual(parsePairingCode('192.168.1.10:43121'), { endpoint: 'http://192.168.1.10:43121/', alternates: [] });
  });

  it('reads the alternate addresses a code carries and drops junk', () => {
    assert.deepEqual(
      parsePairingCode('http://192.168.1.10:43121/#k=tok&e=https%3A%2F%2Fabc-43121.inc1.devtunnels.ms%2F,http%3A%2F%2F10.0.0.5%3A43121%2F,junk,%ZZ'),
      { endpoint: 'http://192.168.1.10:43121/', secret: 'tok', alternates: ['https://abc-43121.inc1.devtunnels.ms/', 'http://10.0.0.5:43121/'] },
    );
  });

  it('rejects credentials and non-http schemes', () => {
    assert.throws(() => parsePairingCode('http://user:pw@192.168.1.10:43121/'), /credentials/);
    assert.throws(() => parsePairingCode('ftp://192.168.1.10/'), /HTTP address/);
  });
});

describe('endpoint helpers', () => {
  it('deduplicates and normalises advertised endpoints, ignoring junk', () => {
    assert.deepEqual(
      mergeEndpoints(['http://10.0.0.5:43121/'], ['http://10.0.0.5:43121', 'https://t.devtunnels.ms/path', 'not a url'], undefined),
      ['http://10.0.0.5:43121/', 'https://t.devtunnels.ms/'],
    );
  });

  it('tells LAN addresses from remote ones', () => {
    assert.equal(isLocalEndpoint('http://192.168.1.10:43121/'), true);
    assert.equal(isLocalEndpoint('http://10.225.47.59:43121/'), true);
    assert.equal(isLocalEndpoint('http://172.20.0.2:43121/'), true);
    assert.equal(isLocalEndpoint('http://172.32.0.2:43121/'), false);
    assert.equal(isLocalEndpoint('http://my-pc.local:43121/'), true);
    assert.equal(isLocalEndpoint('https://abc-43121.inc1.devtunnels.ms/'), false);
    assert.equal(isLocalEndpoint('http://100.101.102.103:43121/'), false);
  });

  it('builds a bearer header only when a secret is known', () => {
    assert.deepEqual(authHeaders({ secret: 'abc' }), { Authorization: 'Bearer abc' });
    assert.deepEqual(authHeaders({}), {});
  });
});

describe('parseGatewayHealth', () => {
  it('treats gateways without pairing support as authorized and reads advertised endpoints', () => {
    const legacy = parseGatewayHealth({ service: 'githubcopilot-monitor-gateway', registryId: 'r1' });
    assert.equal(legacy.hostId, 'r1');
    assert.equal(legacy.authRequired, false);
    assert.equal(legacy.authorized, true);
    assert.deepEqual(legacy.endpoints, []);

    const current = parseGatewayHealth({ service: 'githubcopilot-monitor-gateway', hostId: 'h1', registryId: 'h1', apiVersion: 4, authRequired: true, authorized: false, endpoints: ['http://10.0.0.5:43121/', 7] });
    assert.equal(current.authRequired, true);
    assert.equal(current.authorized, false);
    assert.deepEqual(current.endpoints, ['http://10.0.0.5:43121/']);
  });

  it('rejects anything that is not a Copilot Monitor gateway', () => {
    assert.throws(() => parseGatewayHealth({ service: 'other' }), /not a Copilot Monitor gateway/);
    assert.throws(() => parseGatewayHealth(null), /not a Copilot Monitor gateway/);
  });
});
