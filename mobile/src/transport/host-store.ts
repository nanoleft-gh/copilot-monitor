import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteHostSecret, getHostSecret, setHostSecret } from './host-secrets';
import type { HostProfile } from './types';

const storageKey = 'copilot-monitor:hosts:v1';
let mutation = Promise.resolve();

export async function loadHosts(): Promise<HostProfile[]> {
  await mutation;
  return attachSecrets(await readHosts());
}

export async function saveHost(host: HostProfile): Promise<void> {
  mutation = mutation.then(async () => {
    if (host.secret) await setHostSecret(host.id, host.secret);
    const hosts = await readHosts();
    const existing = hosts.find(candidate => candidate.id === host.id);
    const next = existing
      ? hosts.map(candidate => candidate.id === host.id ? { ...existing, ...persistable(host) } : candidate)
      : [...hosts, persistable(host)];
    await AsyncStorage.setItem(storageKey, JSON.stringify(next));
  });
  await mutation;
}

export async function removeHost(hostId: string): Promise<void> {
  mutation = mutation.then(async () => {
    const hosts = await readHosts();
    await AsyncStorage.setItem(storageKey, JSON.stringify(hosts.filter(host => host.id !== hostId)));
    await deleteHostSecret(hostId);
  });
  await mutation;
}

async function readHosts(): Promise<HostProfile[]> {
  try {
    const value = JSON.parse(await AsyncStorage.getItem(storageKey) ?? '[]') as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap(item => isHostProfile(item) ? [item] : []);
  } catch {
    return [];
  }
}

async function attachSecrets(hosts: HostProfile[]): Promise<HostProfile[]> {
  return Promise.all(hosts.map(async host => {
    const secret = await getHostSecret(host.id);
    return secret ? { ...host, secret } : host;
  }));
}

/** The secret never goes into AsyncStorage; everything else does. */
function persistable(host: HostProfile): HostProfile {
  const { secret: _secret, ...rest } = host;
  return rest;
}

function isHostProfile(value: unknown): value is HostProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<HostProfile>;
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.name === 'string' && candidate.name.length > 0
    && typeof candidate.endpoint === 'string' && candidate.endpoint.length > 0
    && typeof candidate.lastConnected === 'number' && Number.isFinite(candidate.lastConnected)
    && (candidate.endpoints === undefined
      || (Array.isArray(candidate.endpoints) && candidate.endpoints.every(endpoint => typeof endpoint === 'string')));
}

export async function getHost(hostId: string): Promise<HostProfile | undefined> {
  return (await loadHosts()).find(host => host.id === hostId);
}

export async function replaceHost(previousHostId: string, host: HostProfile): Promise<void> {
  mutation = mutation.then(async () => {
    if (previousHostId !== host.id) await deleteHostSecret(previousHostId);
    if (host.secret) await setHostSecret(host.id, host.secret);
    const hosts = await readHosts();
    const next = hosts.filter(candidate => candidate.id !== previousHostId && candidate.id !== host.id);
    await AsyncStorage.setItem(storageKey, JSON.stringify([...next, persistable(host)]));
  });
  await mutation;
}