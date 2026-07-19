import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HostProfile } from './types';

const storageKey = 'copilot-monitor:hosts:v1';
let mutation = Promise.resolve();

export async function loadHosts(): Promise<HostProfile[]> {
  await mutation;
  return readHosts();
}

export async function saveHost(host: HostProfile): Promise<void> {
  mutation = mutation.then(async () => {
    const hosts = await readHosts();
    const existing = hosts.find(candidate => candidate.id === host.id);
    const next = existing
      ? hosts.map(candidate => candidate.id === host.id ? { ...existing, ...host } : candidate)
      : [...hosts, host];
    await AsyncStorage.setItem(storageKey, JSON.stringify(next));
  });
  await mutation;
}

export async function removeHost(hostId: string): Promise<void> {
  mutation = mutation.then(async () => {
    const hosts = await readHosts();
    await AsyncStorage.setItem(storageKey, JSON.stringify(hosts.filter(host => host.id !== hostId)));
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

function isHostProfile(value: unknown): value is HostProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<HostProfile>;
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.name === 'string' && candidate.name.length > 0
    && typeof candidate.endpoint === 'string' && candidate.endpoint.length > 0
    && typeof candidate.lastConnected === 'number' && Number.isFinite(candidate.lastConnected);
}

export async function getHost(hostId: string): Promise<HostProfile | undefined> {
  return (await loadHosts()).find(host => host.id === hostId);
}

export async function replaceHost(previousHostId: string, host: HostProfile): Promise<void> {
  mutation = mutation.then(async () => {
    const hosts = await readHosts();
    const next = hosts.filter(candidate => candidate.id !== previousHostId && candidate.id !== host.id);
    await AsyncStorage.setItem(storageKey, JSON.stringify([...next, host]));
  });
  await mutation;
}