import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveNgrokCredential } from '../ngrokApi';

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const { status, body } = handler(String(input), init ?? {});
		return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

describe('resolveNgrokCredential', () => {
	it('mints an agent authtoken from an API key, sending the required headers', async () => {
		const calls: { url: string; method: string; auth: string; version: string; body?: string }[] = [];
		const fetchImpl = fakeFetch((url, init) => {
			const headers = init.headers as Record<string, string>;
			calls.push({ url, method: init.method ?? 'GET', auth: headers.authorization, version: headers['ngrok-version'], body: typeof init.body === 'string' ? init.body : undefined });
			if (url.endsWith('/credentials?limit=1')) {
				return { status: 200, body: { credentials: [] } };
			}
			return { status: 201, body: { id: 'cr_1', token: '2minted_token' } };
		});
		const resolved = await resolveNgrokCredential('2apikey_abc', 'Copilot Monitor on pc', fetchImpl);
		assert.deepEqual(resolved, { kind: 'apiKey', authtoken: '2minted_token' });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].auth, 'Bearer 2apikey_abc');
		assert.equal(calls[0].version, '2');
		assert.equal(calls[1].method, 'POST');
		assert.equal(calls[1].body, JSON.stringify({ description: 'Copilot Monitor on pc' }));
	});

	it('treats a secret the API rejects as an agent authtoken', async () => {
		const resolved = await resolveNgrokCredential('  2authtoken_xyz ', 'x', fakeFetch(() => ({ status: 401, body: { msg: 'nope', error_code: 'ERR_NGROK_200' } })));
		assert.deepEqual(resolved, { kind: 'authtoken', authtoken: '2authtoken_xyz' });
	});

	it('surfaces API problems and rejects blanks', async () => {
		await assert.rejects(resolveNgrokCredential('', 'x', fakeFetch(() => ({ status: 200 }))), /Paste your ngrok/);
		await assert.rejects(resolveNgrokCredential('k', 'x', fakeFetch(() => ({ status: 429, body: { msg: 'slow down', error_code: 'ERR_NGROK_226' } }))), /HTTP 429: slow down \(ERR_NGROK_226\)/);
		await assert.rejects(resolveNgrokCredential('k', 'x', fakeFetch(url => url.endsWith('?limit=1') ? { status: 200, body: {} } : { status: 403, body: { msg: 'plan limit' } })), /would not create an agent authtoken: plan limit/);
		await assert.rejects(resolveNgrokCredential('k', 'x', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch), /Could not reach api.ngrok.com/);
	});
});
