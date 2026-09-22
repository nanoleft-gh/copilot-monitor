import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HostIdentity {
	readonly version: 1;
	readonly hostId: string;
	readonly name: string;
}

export function getSharedStateDirectory(
	platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = os.homedir(),
): string {
	if (platform === 'win32') {
		return path.join(environment.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local'), 'CopilotMonitor');
	}
	if (platform === 'darwin') {
		return path.join(homeDirectory, 'Library', 'Application Support', 'CopilotMonitor');
	}
	return path.join(environment.XDG_STATE_HOME || path.join(homeDirectory, '.local', 'state'), 'copilot-monitor');
}

export async function getOrCreateHostIdentity(
	directory: string,
	hostName = os.hostname(),
): Promise<HostIdentity> {
	await fs.mkdir(directory, { recursive: true });
	const filePath = path.join(directory, 'host.json');
	const existing = await readHostIdentity(filePath);
	if (existing) {
		return existing;
	}

	const identity: HostIdentity = {
		version: 1,
		hostId: randomUUID(),
		name: hostName || 'Copilot Monitor Host',
	};
	try {
		const handle = await fs.open(filePath, 'wx');
		try {
			await handle.writeFile(JSON.stringify(identity), 'utf8');
		} finally {
			await handle.close();
		}
		return identity;
	} catch (error) {
		if (!isFileExists(error)) {
			throw error;
		}
		const winner = await readHostIdentity(filePath);
		if (winner) {
			return winner;
		}
		throw new Error('The shared Copilot Monitor host identity is invalid.');
	}
}

async function readHostIdentity(filePath: string): Promise<HostIdentity | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
		if (isHostIdentity(value)) {
			return value;
		}
		return undefined;
	} catch (error) {
		if (isFileNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

const pairingSecretFile = 'pairing-secret';
const pairingSecretPattern = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The bearer token every client (phone, browser) must present to the shared gateway. One per
 * host so it survives gateway failover between windows; created exclusively so concurrent
 * windows converge on the same value.
 */
export async function getOrCreatePairingSecret(directory: string): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	const filePath = path.join(directory, pairingSecretFile);
	const existing = await readPairingSecret(filePath);
	if (existing) {
		return existing;
	}
	const secret = randomBytes(32).toString('base64url');
	try {
		const handle = await fs.open(filePath, 'wx', 0o600);
		try {
			await handle.writeFile(secret, 'utf8');
		} finally {
			await handle.close();
		}
		return secret;
	} catch (error) {
		if (!isFileExists(error)) {
			throw error;
		}
		const winner = await readPairingSecret(filePath);
		if (winner) {
			return winner;
		}
		throw new Error('The shared Copilot Monitor pairing secret is invalid.');
	}
}

/** Forgets the current secret; the next `getOrCreatePairingSecret` mints a new one and all paired devices must re-pair. */
export async function resetPairingSecret(directory: string): Promise<void> {
	try {
		await fs.rm(path.join(directory, pairingSecretFile));
	} catch (error) {
		if (!isFileNotFound(error)) {
			throw error;
		}
	}
}

async function readPairingSecret(filePath: string): Promise<string | undefined> {
	try {
		const value = (await fs.readFile(filePath, 'utf8')).trim();
		return pairingSecretPattern.test(value) ? value : undefined;
	} catch (error) {
		if (isFileNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

function isHostIdentity(value: unknown): value is HostIdentity {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<HostIdentity>;
	return candidate.version === 1
		&& typeof candidate.hostId === 'string'
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.hostId)
		&& typeof candidate.name === 'string'
		&& candidate.name.length > 0;
}

function isFileExists(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}