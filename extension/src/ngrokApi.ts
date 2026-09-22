/**
 * ngrok issues two kinds of secrets that look alike (`2abc…_xyz`): an **API key** (dashboard →
 * API Keys) that drives api.ngrok.com, and an agent **authtoken** (dashboard → Your Authtoken)
 * that the `ngrok` agent uses to connect. Users mix them up, so we accept either: an API key is
 * recognised by the API accepting it and is used once to mint a dedicated agent authtoken;
 * anything else is assumed to be an authtoken already.
 */

const apiBase = 'https://api.ngrok.com';
const requestTimeoutMs = 10_000;

export type ResolvedNgrokCredential =
	| { readonly kind: 'apiKey'; readonly authtoken: string }
	| { readonly kind: 'authtoken'; readonly authtoken: string };

export async function resolveNgrokCredential(
	credential: string,
	description: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ResolvedNgrokCredential> {
	const trimmed = credential.trim();
	if (!trimmed) {
		throw new Error('Paste your ngrok API key or authtoken.');
	}
	const probe = await apiRequest(fetchImpl, 'GET', '/credentials?limit=1', trimmed);
	if (probe.status === 401 || probe.status === 403) {
		// Not an API key; the agent will tell us if it is not a valid authtoken either.
		return { kind: 'authtoken', authtoken: trimmed };
	}
	if (!probe.ok) {
		throw new Error(`ngrok API answered HTTP ${probe.status}: ${await errorMessage(probe)}`);
	}
	const created = await apiRequest(fetchImpl, 'POST', '/credentials', trimmed, { description });
	if (!created.ok) {
		throw new Error(`ngrok would not create an agent authtoken: ${await errorMessage(created)}`);
	}
	const body = await created.json() as { token?: unknown };
	if (typeof body.token !== 'string' || !body.token) {
		throw new Error('ngrok created a credential but returned no token.');
	}
	return { kind: 'apiKey', authtoken: body.token };
}

async function apiRequest(fetchImpl: typeof fetch, method: 'GET' | 'POST', path: string, apiKey: string, body?: unknown): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		return await fetchImpl(`${apiBase}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${apiKey}`,
				'ngrok-version': '2',
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
	} catch (error) {
		throw new Error(error instanceof Error && error.name === 'AbortError'
			? 'api.ngrok.com did not respond.'
			: `Could not reach api.ngrok.com: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = await response.json() as { msg?: unknown; error_code?: unknown };
		return typeof body.msg === 'string' ? `${body.msg}${typeof body.error_code === 'string' ? ` (${body.error_code})` : ''}` : response.statusText;
	} catch {
		return response.statusText;
	}
}
