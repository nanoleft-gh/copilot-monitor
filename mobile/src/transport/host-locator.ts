import { discoverHostEndpoint } from './host-discovery';
import { replaceHost } from './host-store';
import { fetchGatewayHealth, isLocalEndpoint, mergeEndpoints } from './pairing';
import type { GatewayHealth, HostProfile } from './types';

const localProbeTimeoutMs = 2_500;
const remoteProbeTimeoutMs = 8_000;
const refreshIntervalMs = 5 * 60_000;
const lastRefreshAt = new Map<string, number>();

export class UnpairedError extends Error {
  constructor(hostName: string) {
    super(`${hostName} no longer accepts this phone's pairing. Open the Copilot Monitor sidebar in VS Code and scan its code again.`);
    this.name = 'UnpairedError';
  }
}

/**
 * Finds an address that answers for `host` right now: every known LAN address in parallel,
 * then any remote (tunnel) address, then a subnet scan for a changed IP. Updates `host` in
 * place and persists the winner so the next connection tries it first.
 */
export async function locateHost(host: HostProfile): Promise<HostProfile> {
  const candidates = mergeEndpoints([host.endpoint], host.endpoints);
  const found = await firstReachable(host, candidates.filter(isLocalEndpoint), localProbeTimeoutMs)
    ?? await firstReachable(host, candidates.filter(candidate => !isLocalEndpoint(candidate)), remoteProbeTimeoutMs)
    ?? await scanSubnet(host);
  if (!found) {
    throw new Error(host.endpoints?.some(candidate => !isLocalEndpoint(candidate))
      ? `Cannot reach ${host.name} on this network or through its remote address. Confirm VS Code is running and the tunnel is still forwarded.`
      : `Cannot find ${host.name} on this local network. Confirm VS Code is running and both devices are on the same network, or add a remote access URL in VS Code to reach it from anywhere.`);
  }
  if (found.health.authRequired && !found.health.authorized) {
    throw new UnpairedError(host.name);
  }
  return adopt(host, found.endpoint, found.health);
}

/** Learns newly advertised addresses (e.g. a tunnel URL added in VS Code) without blocking the caller. */
export function refreshHostEndpoints(host: HostProfile): void {
  const now = Date.now();
  if (now - (lastRefreshAt.get(host.id) ?? 0) < refreshIntervalMs) return;
  lastRefreshAt.set(host.id, now);
  void fetchGatewayHealth(host.endpoint, host.secret, localProbeTimeoutMs)
    .then(health => {
      if (health.hostId !== host.id) return;
      learnEndpoints(host, health.endpoints);
    })
    .catch(() => undefined);
}

/**
 * Adopts the address list the gateway just streamed (it is authoritative about what exists now),
 * keeping the current connection's address first. Persists only when something changed, so
 * calling this on every snapshot is cheap.
 */
export function learnEndpoints(host: HostProfile, advertised: readonly string[]): void {
  if (advertised.length === 0) return;
  const endpoints = mergeEndpoints([host.endpoint], advertised);
  if (endpoints.join('\n') === (host.endpoints ?? []).join('\n')) return;
  const updated: HostProfile = { ...host, endpoints, lastConnected: Date.now() };
  Object.assign(host, updated);
  void replaceHost(host.id, updated).catch(() => undefined);
}

async function adopt(host: HostProfile, endpoint: string, health: GatewayHealth): Promise<HostProfile> {
  const updated: HostProfile = {
    ...host,
    endpoint,
    // The gateway's own list is authoritative about which addresses still exist.
    endpoints: mergeEndpoints([endpoint], health.endpoints.length > 0 ? health.endpoints : host.endpoints),
    lastConnected: Date.now(),
  };
  await replaceHost(host.id, updated);
  Object.assign(host, updated);
  return host;
}

type Reachable = { endpoint: string; health: GatewayHealth };

async function firstReachable(host: HostProfile, endpoints: readonly string[], timeoutMs: number): Promise<Reachable | undefined> {
  if (endpoints.length === 0) return undefined;
  return new Promise(resolve => {
    let pending = endpoints.length;
    let settled = false;
    for (const endpoint of endpoints) {
      fetchGatewayHealth(endpoint, host.secret, timeoutMs)
        .then(health => {
          if (!settled && health.hostId === host.id) {
            settled = true;
            resolve({ endpoint, health });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (--pending === 0 && !settled) resolve(undefined);
        });
    }
  });
}

async function scanSubnet(host: HostProfile): Promise<Reachable | undefined> {
  const endpoint = await discoverHostEndpoint(host);
  if (!endpoint) return undefined;
  try {
    return { endpoint, health: await fetchGatewayHealth(endpoint, host.secret, localProbeTimeoutMs) };
  } catch {
    return undefined;
  }
}
