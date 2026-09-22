import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Machine-wide remote access preferences, kept next to the host identity so every VS Code
 * window (and every VS Code flavour) sharing the gateway sees the same choice. Written by
 * the gateway owner only; other windows change it through the gateway API.
 */
export interface RemoteAccessPreferences {
	readonly version: 1;
	readonly enabled: boolean;
	readonly manualUrl?: string;
}

const fileName = 'remote-access.json';
const defaults: RemoteAccessPreferences = { version: 1, enabled: false };

export async function readRemoteAccessPreferences(directory: string): Promise<RemoteAccessPreferences> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(directory, fileName), 'utf8')) as Partial<RemoteAccessPreferences>;
		if (typeof value !== 'object' || value === null || value.version !== 1) {
			return defaults;
		}
		return {
			version: 1,
			enabled: value.enabled === true,
			...(typeof value.manualUrl === 'string' && value.manualUrl ? { manualUrl: value.manualUrl } : {}),
		};
	} catch {
		return defaults;
	}
}

export async function writeRemoteAccessPreferences(directory: string, preferences: RemoteAccessPreferences): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	const target = path.join(directory, fileName);
	const temporary = `${target}.${process.pid}.tmp`;
	await fs.writeFile(temporary, JSON.stringify(preferences), 'utf8');
	await fs.rename(temporary, target);
}
