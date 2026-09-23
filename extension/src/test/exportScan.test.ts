import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanExport } from '../exportScan';

const encode = (value: unknown, space: number | undefined = 2) => new TextEncoder().encode(JSON.stringify(value, undefined, space));

describe('scanExport', () => {
	const exported = {
		responderUsername: 'GitHub Copilot',
		initialLocation: 'panel',
		requests: [
			{ requestId: 'request-1', message: { text: 'first' }, response: [{ value: 'a "quoted"\n\n      "requestId": "fake"' }] },
			{ requestId: 'request-2', message: { text: 'second' }, response: [{ nested: { requestId: 'inner' } }, { value: 'streaming' }] },
		],
		trailing: ['another top-level array'],
	};

	it('lists request ids in order and parses only the newest request', () => {
		const scan = scanExport(encode(exported));
		assert.deepEqual(scan.requestIds, ['request-1', 'request-2']);
		assert.deepEqual(scan.lastRequest, exported.requests[1]);
		assert.equal(scan.bytes, encode(exported).byteLength);
	});

	it('falls back to a full parse for an unexpected layout', () => {
		const scan = scanExport(encode(exported, undefined));
		assert.deepEqual(scan.requestIds, ['request-1', 'request-2']);
		assert.deepEqual(scan.lastRequest, exported.requests[1]);
	});

	it('handles empty exports and chats without requests', () => {
		assert.deepEqual(scanExport(new Uint8Array()), { requestIds: [], lastRequest: undefined, bytes: 0 });
		const scan = scanExport(encode({ requests: [] }));
		assert.deepEqual(scan.requestIds, []);
		assert.equal(scan.lastRequest, undefined);
	});

	it('reads a subarray view without copying beyond it', () => {
		const bytes = encode(exported);
		const padded = new Uint8Array(bytes.byteLength + 8);
		padded.set(bytes, 4);
		assert.deepEqual(scanExport(padded.subarray(4, 4 + bytes.byteLength)).requestIds, ['request-1', 'request-2']);
	});
});
