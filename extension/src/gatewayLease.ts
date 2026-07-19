import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface GatewayLease {
	readonly version: 1;
	readonly hostId: string;
	readonly nonce: string;
	readonly ownerId: string;
	readonly port: number;
	readonly heartbeatAt: number;
}

export class GatewayLeaseStore {
	private readonly leasePath: string;
	private readonly lockPath: string;

	constructor(
		readonly directory: string,
		private readonly staleAfterMs = 8_000,
	) {
		this.leasePath = path.join(directory, 'gateway.json');
		this.lockPath = path.join(directory, 'gateway.lock');
	}

	async read(now = Date.now()): Promise<GatewayLease | undefined> {
		try {
			const value = JSON.parse(await fs.readFile(this.leasePath, 'utf8')) as unknown;
			if (!isGatewayLease(value) || now - value.heartbeatAt > this.staleAfterMs) {
				return undefined;
			}
			return value;
		} catch {
			return undefined;
		}
	}

	async acquire(ownerId: string, now = Date.now()): Promise<GatewayElectionLock | undefined> {
		await fs.mkdir(this.directory, { recursive: true });
		try {
			return await this.createLock(ownerId, now);
		} catch (error) {
			if (!isFileExists(error)) {
				throw error;
			}
		}

		try {
			const stat = await fs.stat(this.lockPath);
			if (now - stat.mtimeMs <= this.staleAfterMs) {
				return undefined;
			}
			await fs.rm(this.lockPath, { force: true });
		} catch {
			return undefined;
		}

		try {
			return await this.createLock(ownerId, now);
		} catch (error) {
			if (isFileExists(error)) {
				return undefined;
			}
			throw error;
		}
	}

	async publish(lease: GatewayLease): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		const temporaryPath = `${this.leasePath}.${lease.ownerId}.tmp`;
		await fs.writeFile(temporaryPath, JSON.stringify(lease), 'utf8');
		try {
			await fs.rename(temporaryPath, this.leasePath);
		} catch (error) {
			if (!isWindowsReplaceError(error)) {
				throw error;
			}
			await fs.rm(this.leasePath, { force: true });
			await fs.rename(temporaryPath, this.leasePath);
		}
	}

	async remove(nonce: string): Promise<void> {
		const lease = await this.read();
		if (lease?.nonce === nonce) {
			await fs.rm(this.leasePath, { force: true });
		}
	}

	private async createLock(ownerId: string, now: number): Promise<GatewayElectionLock> {
		const token = randomUUID();
		const handle = await fs.open(this.lockPath, 'wx');
		await handle.writeFile(JSON.stringify({ ownerId, token, createdAt: now }), 'utf8');
		return new GatewayElectionLock(handle, this.lockPath, token);
	}
}

export class GatewayElectionLock {
	private released = false;

	constructor(
		private readonly handle: fs.FileHandle,
		private readonly lockPath: string,
		private readonly token: string,
	) {}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		await this.handle.close();
		try {
			const value = JSON.parse(await fs.readFile(this.lockPath, 'utf8')) as { token?: unknown };
			if (value.token === this.token) {
				await fs.rm(this.lockPath, { force: true });
			}
		} catch {
			// A stale owner may release after its lock was replaced.
		}
	}
}

function isGatewayLease(value: unknown): value is GatewayLease {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<GatewayLease>;
	return candidate.version === 1
		&& typeof candidate.hostId === 'string' && candidate.hostId.length > 0
		&& typeof candidate.nonce === 'string' && candidate.nonce.length > 0
		&& typeof candidate.ownerId === 'string' && candidate.ownerId.length > 0
		&& Number.isInteger(candidate.port) && candidate.port! > 0 && candidate.port! <= 65_535
		&& typeof candidate.heartbeatAt === 'number' && Number.isFinite(candidate.heartbeatAt);
}

function isFileExists(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isWindowsReplaceError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error
		&& (error.code === 'EPERM' || error.code === 'EACCES');
}