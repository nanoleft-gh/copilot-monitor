import * as Network from 'expo-network';
import type { HostProfile } from './types';

const gatewayPort = 43121;
const probeTimeoutMs = 650;
const probeConcurrency = 24;

export async function discoverHostEndpoint(host: HostProfile): Promise<string | undefined> {
  const localAddress = await Network.getIpAddressAsync().catch(() => undefined);
  const prefix = ipv4Prefix(localAddress);
  if (!prefix) return undefined;

  const candidates = Array.from({ length: 254 }, (_, index) => `http://${prefix}.${index + 1}:${gatewayPort}/`);
  let cursor = 0;
  let found: string | undefined;

  const worker = async () => {
    while (!found) {
      const endpoint = candidates[cursor++];
      if (!endpoint) return;
      if (await endpointMatchesHost(endpoint, host.id)) {
        found = endpoint;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: probeConcurrency }, () => worker()));
  return found;
}

async function endpointMatchesHost(endpoint: string, hostId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
  try {
    const response = await fetch(new URL('/api/health', endpoint), { signal: controller.signal });
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    const candidateHostId = typeof value.hostId === 'string'
      ? value.hostId
      : typeof value.registryId === 'string' ? value.registryId : undefined;
    return value.service === 'githubcopilot-monitor-gateway' && candidateHostId === hostId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function ipv4Prefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(value);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets.join('.') : undefined;
}