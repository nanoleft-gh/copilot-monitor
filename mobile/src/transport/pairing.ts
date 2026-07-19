import type { GatewayHealth, HostProfile } from './types';

const healthTimeoutMs = 8_000;

export function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Expected a Copilot Monitor HTTP address.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Gateway addresses cannot contain credentials.');
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export async function pairGateway(value: string): Promise<HostProfile> {
  const endpoint = normalizeGatewayUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(new URL('/api/health', endpoint), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Gateway responded with HTTP ${response.status}.`);
    }
    const health = parseGatewayHealth(await response.json());
    return {
      id: health.hostId,
      name: hostLabel(endpoint),
      endpoint,
      lastConnected: Date.now(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The computer did not respond. Check that both devices are on the same Wi-Fi network.');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function parseGatewayHealth(value: unknown): GatewayHealth {
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
  };
}

function hostLabel(endpoint: string): string {
  const url = new URL(endpoint);
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    ? 'This computer'
    : url.hostname;
}