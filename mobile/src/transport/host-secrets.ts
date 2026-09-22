import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// SecureStore keys may only contain [A-Za-z0-9._-]; host ids are UUIDs so a fixed prefix is enough.
const keyFor = (hostId: string) => `copilot-monitor.secret.${hostId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
const secureStoreAvailable = Platform.OS !== 'web';

/** Pairing secrets live in the device keystore (Keychain / Keystore), never next to the host list. */
export async function getHostSecret(hostId: string): Promise<string | undefined> {
  try {
    const value = secureStoreAvailable
      ? await SecureStore.getItemAsync(keyFor(hostId))
      : await AsyncStorage.getItem(keyFor(hostId));
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

export async function setHostSecret(hostId: string, secret: string): Promise<void> {
  if (secureStoreAvailable) {
    await SecureStore.setItemAsync(keyFor(hostId), secret, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  } else {
    await AsyncStorage.setItem(keyFor(hostId), secret);
  }
}

export async function deleteHostSecret(hostId: string): Promise<void> {
  try {
    if (secureStoreAvailable) {
      await SecureStore.deleteItemAsync(keyFor(hostId));
    } else {
      await AsyncStorage.removeItem(keyFor(hostId));
    }
  } catch {
    // Nothing stored.
  }
}
