import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authCookie, pairingUrl, parsePairingUrl, presentedToken, requestIsHttps, tokensMatch } from '../gatewayAuth';

describe('gateway auth', () => {
	it('reads a bearer header first and falls back to the dashboard cookie', () => {
		assert.equal(presentedToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
		assert.equal(presentedToken({ headers: { authorization: 'bearer   abc  ' } }), 'abc');
		assert.equal(presentedToken({ headers: { authorization: 'Basic abc' } }), undefined);
		assert.equal(presentedToken({ headers: { cookie: 'theme=dark; cm_auth=t%2Fok; other=1' } }), 't/ok');
		assert.equal(presentedToken({ headers: { cookie: 'xcm_auth=nope' } }), undefined);
		assert.equal(presentedToken({ headers: {} }), undefined);
	});

	it('compares tokens in constant time without leaking on length', () => {
		assert.equal(tokensMatch('secret', 'secret'), true);
		assert.equal(tokensMatch('secret', 'secret1'), false);
		assert.equal(tokensMatch('secret', 'Secret'), false);
		assert.equal(tokensMatch('secret', undefined), false);
		assert.equal(tokensMatch('secret', ''), false);
	});

	it('builds cookies that browsers accept on plain LAN HTTP and mark Secure behind HTTPS tunnels', () => {
		assert.equal(authCookie('a b', false), 'cm_auth=a%20b; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000');
		assert.match(authCookie('x', true), /; Secure$/);
		assert.equal(requestIsHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
		assert.equal(requestIsHttps({ headers: { 'x-forwarded-proto': 'https, http' } }), true);
		assert.equal(requestIsHttps({ headers: { 'x-forwarded-proto': 'http' } }), false);
		assert.equal(requestIsHttps({ headers: {} }), false);
	});

	it('round-trips the secret through the URL fragment so it never reaches the server or its logs', () => {
		const url = pairingUrl('http://192.168.1.10:43121/', 'se/cr+et');
		assert.equal(url, 'http://192.168.1.10:43121/#k=se%2Fcr%2Bet');
		assert.deepEqual(parsePairingUrl(url), { endpoint: 'http://192.168.1.10:43121/', secret: 'se/cr+et', alternates: [] });
		assert.deepEqual(parsePairingUrl('https://abc-43121.inc1.devtunnels.ms/some/path?x=1#k=tok'), { endpoint: 'https://abc-43121.inc1.devtunnels.ms/', secret: 'tok', alternates: [] });
		assert.deepEqual(parsePairingUrl('http://192.168.1.10:43121/'), { endpoint: 'http://192.168.1.10:43121/', alternates: [] });
	});

	it('carries the gateway\'s other addresses so one code works at home and away', () => {
		const url = pairingUrl('http://192.168.1.10:43121/', 'tok', ['http://192.168.1.10:43121/', 'https://abc-43121.inc1.devtunnels.ms/', 'http://10.0.0.5:43121/']);
		assert.equal(url, 'http://192.168.1.10:43121/#k=tok&e=https%3A%2F%2Fabc-43121.inc1.devtunnels.ms%2F,http%3A%2F%2F10.0.0.5%3A43121%2F');
		assert.deepEqual(parsePairingUrl(url), {
			endpoint: 'http://192.168.1.10:43121/',
			secret: 'tok',
			alternates: ['https://abc-43121.inc1.devtunnels.ms/', 'http://10.0.0.5:43121/'],
		});
		assert.deepEqual(parsePairingUrl('http://h/#k=t&e=junk,%ZZ').alternates, []);
	});
});
