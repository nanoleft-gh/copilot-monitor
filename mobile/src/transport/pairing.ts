import type { GatewayHealth, HostProfile } from './types';

const healthTimeoutMs = 8_000;
/** Fragment key the extension uses for the pairing secret (`http://host:port/#k=...`). */
const pairingFragmentKey = 'k';

export function normalizeGatewayUrl(value: string): string {
  return parsePairingCode(value).endpoint;
}

/** Splits a scanned/pasted code into the gateway origin and the secret carried in its fragment. */
export function parsePairingCode(value: string): { endpoint: string; secret?: string } {
  const trimmed = value.trim();
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Expected a Copilot Monitor HTTP address.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Gateway addresses cannot contain credentials.');
  }
  const secret = new URLSearchParams(parsed.hash.replace(/^#/, '')).get(pairingFragmentKey) ?? undefined;
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return secret ? { endpoint: parsed.toString(), secret } : { endpoint: parsed.toString() };
}

export function authHeaders(host: Pick<HostProfile, 'secret'>): Record<string, string> {
  return host.secret ? { Authorization: `Bearer ${host.secret}` } : {};
}

export async function pairGateway(value: string, knownSecret?: string): Promise<HostProfile> {
  const { endpoint, secret = knownSecret } = parsePairingCode(value);
  const health = await fetchGatewayHealth(endpoint, secret, healthTimeoutMs);
  if (health.authRequired && !health.authorized) {
    throw new Error(secret
      ? 'This pairing code is no longer valid for the computer. Scan the fresh code in the Copilot Monitor sidebar.'
      : 'This address is missing its pairing secret. Scan the QR code in the Copilot Monitor sidebar, or paste the full pairing link.');
  }
  return {
    id: health.hostId,
    name: hostLabel(endpoint),
    endpoint,
    endpoints: mergeEndpoints([endpoint], health.endpoints),
    lastConnected: Date.now(),
    ...(secret ? { secret } : {}),
  };
}

/** `GET /api/health` with the secret attached; the only route that answers without one. */
export async function fetchGatewayHealth(endpoint: string, secret: string | undefined, timeoutMs: number): Promise<GatewayHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/api/health', endpoint), { signal: controller.signal, headers: authHeaders({ secret }) });
    if (!response.ok) {
      throw new Error(`Gateway responded with HTTP ${response.status}.`);
    }
    return parseGatewayHealth(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The computer did not respond. Check that both devices are on the same Wi-Fi network.');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

export function mergeEndpoints(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const candidate of list ?? []) {
      try {
        const normalized = normalizeGatewayUrl(candidate);
        if (!merged.includes(normalized)) merged.push(normalized);
      } catch {
        // Ignore malformed advertisements.
      }
    }
  }
  return merged;
}

export function parseGatewayHealth(value: unknown): GatewayHealth {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('This address is not a Copilot Monitor gateway.');
  }
  const candidate = value as Partial<GatewayHealth>;
  const hostId = typeof candidate.hostId === 'string' && candidate.hostId
    ? candidate.hostId
    : typeof candidate.registryId === 'string' ? candidate.registryId : '';
  if (candidate.service !== 'githubcopilot-monitor-gateway' || !hostId) {
    throw new Error('This address is not a Copilot Monitor gateway.');
  }
  return {
    service: candidate.service,
    hostId,
    registryId: typeof candidate.registryId === 'string' ? candidate.registryId : hostId,
    apiVersion: typeof candidate.apiVersion === 'number' ? candidate.apiVersion : 0,
    authRequired: candidate.authRequired === true,
    // Gateways that predate pairing secrets accept everything.
    authorized: candidate.authRequired !== true || candidate.authorized === true,
    endpoints: Array.isArray(candidate.endpoints) ? candidate.endpoints.filter((item): item is string => typeof item === 'string') : [],
  };
}

function hostLabel(endpoint: string): string {
  const url = new URL(endpoint);
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    ? 'This computer'
    : url.hostname;
}

/** Private IPv4 / .local names are only reachable on the same network; anything else is treated as remote. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(hostname)
      || hostname === 'localhost' || hostname.endsWith('.local');
  } catch {
    return false;
  }
}