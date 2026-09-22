import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RemoteTunnelProvider } from './protocol';

/**
 * Machine-wide remote access preferences, kept next to the host identity so every VS Code
 * window (and every VS Code flavour) sharing the gateway sees the same choice. Written by
 * the gateway owner only; other windows change it through the gateway API. The ngrok
 * authtoken lives here too (0600 like the pairing secret) because the owner window may be
 * a different VS Code than the one that entered it, which rules out per-app SecretStorage.
 */
export interface RemoteAccessPreferences {
	readonly version: 1;
	readonly enabled: boolean;
	readonly provider: RemoteTunnelProvider;
	readonly manualUrl?: string;
	readonly ngrok?: { readonly authtoken?: string; readonly domain?: string };
}

const fileName = 'remote-access.json';
const defaults: RemoteAccessPreferences = { version: 1, enabled: false, provider: 'devtunnel' };

export async function readRemoteAccessPreferences(directory: string): Promise<RemoteAccessPreferences> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(directory, fileName), 'utf8')) as Partial<RemoteAccessPreferences>;
		if (typeof value !== 'object' || value === null || value.version !== 1) {
			return defaults;
		}
		const ngrok = typeof value.ngrok === 'object' && value.ngrok !== null
			? {
				...(typeof value.ngrok.authtoken === 'string' && value.ngrok.authtoken ? { authtoken: value.ngrok.authtoken } : {}),
				...(typeof value.ngrok.domain === 'string' && value.ngrok.domain ? { domain: value.ngrok.domain } : {}),
			}
			: undefined;
		return {
			version: 1,
			enabled: value.enabled === true,
			provider: value.provider === 'ngrok' ? 'ngrok' : 'devtunnel',
			...(typeof value.manualUrl === 'string' && value.manualUrl ? { manualUrl: value.manualUrl } : {}),
			...(ngrok && Object.keys(ngrok).length > 0 ? { ngrok } : {}),
		};
	} catch {
		return defaults;
	}
}

export async function writeRemoteAccessPreferences(directory: string, preferences: RemoteAccessPreferences): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	const target = path.join(directory, fileName);
	const temporary = `${target}.${process.pid}.tmp`;
	await fs.writeFile(temporary, JSON.stringify(preferences), { encoding: 'utf8', mode: 0o600 });
	await fs.rename(temporary, target);
}
