import { timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';

export const authCookieName = 'cm_auth';
/** URL fragment key carrying the pairing secret; fragments never reach the server or its logs. */
export const pairingFragmentKey = 'k';

const cookieMaxAgeSeconds = 365 * 24 * 60 * 60;

/** Reads the token a client presented, from `Authorization: Bearer` or from the dashboard cookie. */
export function presentedToken(request: Pick<http.IncomingMessage, 'headers'>): string | undefined {
	const authorization = request.headers.authorization;
	if (typeof authorization === 'string') {
		const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
		if (match) {
			return match[1];
		}
	}
	const cookie = request.headers.cookie;
	if (typeof cookie === 'string') {
		for (const part of cookie.split(';')) {
			const separator = part.indexOf('=');
			if (separator > 0 && part.slice(0, separator).trim() === authCookieName) {
				return decodeURIComponent(part.slice(separator + 1).trim());
			}
		}
	}
	return undefined;
}

export function tokensMatch(expected: string, presented: string | undefined): boolean {
	if (!presented) {
		return false;
	}
	const left = Buffer.from(expected, 'utf8');
	const right = Buffer.from(presented, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Cookie for browsers; `Secure` only when the request arrived over HTTPS (e.g. through a tunnel). */
export function authCookie(token: string, secure: boolean): string {
	const attributes = [`${authCookieName}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${cookieMaxAgeSeconds}`];
	if (secure) {
		attributes.push('Secure');
	}
	return attributes.join('; ');
}

export function clearedAuthCookie(): string {
	return `${authCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function requestIsHttps(request: Pick<http.IncomingMessage, 'headers'>): boolean {
	const forwarded = request.headers['x-forwarded-proto'];
	const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	return typeof value === 'string' && value.split(',')[0].trim().toLowerCase() === 'https';
}

/** The address a phone scans or a browser opens: base URL plus the secret in the fragment. */
export function pairingUrl(baseUrl: string, secret: string): string {
	const url = new URL(baseUrl);
	url.hash = `${pairingFragmentKey}=${encodeURIComponent(secret)}`;
	return url.toString();
}

/** Splits a pairing URL into its gateway origin and secret; the secret is absent for plain addresses. */
export function parsePairingUrl(value: string): { endpoint: string; secret?: string } {
	const url = new URL(value);
	const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
	const secret = fragment.get(pairingFragmentKey) ?? undefined;
	url.hash = '';
	url.search = '';
	url.pathname = '/';
	return secret ? { endpoint: url.toString(), secret } : { endpoint: url.toString() };
}
