import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const windowHeartbeatIntervalMs = 2_000;
export const windowStaleAfterMs = 8_000;

export interface WindowDescriptor {
	readonly version: 1 | 2;
	readonly windowId: string;
	readonly hostId?: string;
	readonly productName?: string;
	readonly productVersion?: string;
	readonly localPort: number;
	readonly workspaceName: string;
	readonly workspaceFolders: readonly string[];
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly pid: number;
}

export interface WindowRegistration {
	readonly hostId: string;
	readonly productName: string;
	readonly productVersion: string;
	readonly localPort: number;
	readonly workspaceName: string;
	readonly workspaceFolders: readonly string[];
	readonly startedAt: number;
	readonly pid: number;
}

export class WindowRegistry {
	private readonly descriptorPath: string;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private descriptor: WindowDescriptor | undefined;
	private heartbeatWrite: Promise<void> = Promise.resolve();

	constructor(
		readonly directory: string,
		private readonly windowId: string,
	) {
		this.descriptorPath = path.join(directory, `${windowId}.json`);
	}

	async start(descriptor: WindowRegistration): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		this.descriptor = {
			...descriptor,
			version: 2,
			windowId: this.windowId,
			heartbeatAt: Date.now(),
		};
		await this.writeHeartbeat();
		this.heartbeatTimer = setInterval(() => void this.writeHeartbeat(), windowHeartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}

	async stop(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.descriptor = undefined;
		await this.heartbeatWrite;
		await fs.rm(this.descriptorPath, { force: true }).catch(() => undefined);
	}

	private writeHeartbeat(): Promise<void> {
		this.heartbeatWrite = this.heartbeatWrite
			.then(() => this.writeHeartbeatNow())
			.catch(() => undefined);
		return this.heartbeatWrite;
	}

	private async writeHeartbeatNow(): Promise<void> {
		if (!this.descriptor) {
			return;
		}
		this.descriptor = { ...this.descriptor, heartbeatAt: Date.now() };
		const temporaryPath = `${this.descriptorPath}.${process.pid}.tmp`;
		try {
			await fs.writeFile(temporaryPath, JSON.stringify(this.descriptor), 'utf8');
			await replaceFile(temporaryPath, this.descriptorPath);
		} catch {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
	try {
		await fs.rename(sourcePath, targetPath);
	} catch (error) {
		if (!isWindowsReplaceError(error)) {
			throw error;
		}
		await fs.rm(targetPath, { force: true });
		await fs.rename(sourcePath, targetPath);
	}
}

function isWindowsReplaceError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error
		&& (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EEXIST');
}

export async function readActiveWindowDescriptors(
	directory: string,
	now = Date.now(),
	staleAfterMs = windowStaleAfterMs,
): Promise<WindowDescriptor[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		return [];
	}

	const descriptors: WindowDescriptor[] = [];
	for (const entry of entries) {
		const isDescriptor = entry.endsWith('.json');
		const isTemporary = entry.endsWith('.tmp');
		if (!isDescriptor && !isTemporary) {
			continue;
		}
		const filePath = path.join(directory, entry);
		if (isTemporary) {
			await removeIfOld(filePath, now, staleAfterMs);
			continue;
		}
		try {
			const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
			if (!isWindowDescriptor(value)) {
				await removeIfOld(filePath, now, staleAfterMs);
				continue;
			}
			if (now - value.heartbeatAt > staleAfterMs) {
				await fs.rm(filePath, { force: true }).catch(() => undefined);
				continue;
			}
			descriptors.push(value);
		} catch {
			await removeIfOld(filePath, now, staleAfterMs);
		}
	}

	return descriptors.sort((left, right) => left.startedAt - right.startedAt);
}

function isWindowDescriptor(value: unknown): value is WindowDescriptor {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<WindowDescriptor>;
	const validVersion = candidate.version === 1 || candidate.version === 2;
	const validHostMetadata = candidate.version === 1 || (
		typeof candidate.hostId === 'string' && candidate.hostId.length > 0
		&& typeof candidate.productName === 'string' && candidate.productName.length > 0
		&& typeof candidate.productVersion === 'string' && candidate.productVersion.length > 0
	);
	return validVersion
		&& validHostMetadata
		&& typeof candidate.windowId === 'string'
		&& Number.isInteger(candidate.localPort)
		&& candidate.localPort! > 0
		&& typeof candidate.workspaceName === 'string'
		&& Array.isArray(candidate.workspaceFolders)
		&& candidate.workspaceFolders.every(folder => typeof folder === 'string')
		&& typeof candidate.startedAt === 'number'
		&& typeof candidate.heartbeatAt === 'number'
		&& Number.isInteger(candidate.pid);
}

async function removeIfOld(filePath: string, now: number, staleAfterMs: number): Promise<void> {
	try {
		const stat = await fs.stat(filePath);
		if (now - stat.mtimeMs > staleAfterMs) {
			await fs.rm(filePath, { force: true });
		}
	} catch {
		// The writer or another registry reader may already have replaced it.
	}
}