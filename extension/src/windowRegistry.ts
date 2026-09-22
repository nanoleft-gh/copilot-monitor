import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DirectoryWatcher } from './directoryWatcher';

/**
 * Each VS Code window publishes one descriptor file so the shared gateway can find its
 * local bridge. Liveness is not tracked here: the gateway keeps a connection to every
 * window's event stream, and a descriptor whose bridge refuses connections is removed by
 * the gateway. The only thing this class does after publishing is re-publish its own
 * descriptor if something deletes it (observed through fs.watch, never by polling).
 */

/** Temporary files and unparseable descriptors older than this are garbage-collected. */
export const abandonedFileAfterMs = 60_000;

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
	/** Kept for compatibility with older readers; equals the publish time. */
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
	private descriptor: WindowDescriptor | undefined;
	private watcher: DirectoryWatcher | undefined;
	private writing: Promise<void> = Promise.resolve();
	private republishTimer: NodeJS.Timeout | undefined;

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
		await this.publish();
		this.watcher = new DirectoryWatcher(this.directory, event => {
			if (!this.descriptor) {
				return;
			}
			if (event.type === 'reconcile' || !event.name || event.name === path.basename(this.descriptorPath)) {
				this.scheduleRepublish();
			}
		});
		this.watcher.start();
	}

	async stop(): Promise<void> {
		this.descriptor = undefined;
		this.watcher?.dispose();
		this.watcher = undefined;
		if (this.republishTimer) {
			clearTimeout(this.republishTimer);
			this.republishTimer = undefined;
		}
		await this.writing;
		await fs.rm(this.descriptorPath, { force: true }).catch(() => undefined);
	}

	/** Re-writes the descriptor only when it is actually missing. */
	private scheduleRepublish(): void {
		if (this.republishTimer) {
			return;
		}
		this.republishTimer = setTimeout(() => {
			this.republishTimer = undefined;
			void this.publishIfMissing();
		}, 100);
		this.republishTimer.unref();
	}

	private async publishIfMissing(): Promise<void> {
		if (!this.descriptor) {
			return;
		}
		try {
			await fs.access(this.descriptorPath);
			return;
		} catch {
			await this.publish();
		}
	}

	private publish(): Promise<void> {
		this.writing = this.writing.then(() => this.publishNow()).catch(() => undefined);
		return this.writing;
	}

	private async publishNow(): Promise<void> {
		const descriptor = this.descriptor;
		if (!descriptor) {
			return;
		}
		const temporaryPath = `${this.descriptorPath}.${process.pid}.tmp`;
		try {
			await fs.writeFile(temporaryPath, JSON.stringify(descriptor), 'utf8');
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

/**
 * Lists published descriptors. Liveness is the caller's job (connect to `localPort`);
 * only abandoned temporary files and old unparseable files are cleaned up here.
 */
export async function readWindowDescriptors(directory: string, now = Date.now()): Promise<WindowDescriptor[]> {
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
			await removeIfOld(filePath, now);
			continue;
		}
		try {
			const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
			if (!isWindowDescriptor(value)) {
				await removeIfOld(filePath, now);
				continue;
			}
			descriptors.push(value);
		} catch {
			await removeIfOld(filePath, now);
		}
	}

	return descriptors.sort((left, right) => left.startedAt - right.startedAt);
}

/** Removes the descriptor of a window whose bridge is gone. */
export async function removeWindowDescriptor(directory: string, windowId: string): Promise<void> {
	await fs.rm(path.join(directory, `${windowId}.json`), { force: true }).catch(() => undefined);
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

async function removeIfOld(filePath: string, now: number): Promise<void> {
	try {
		const stat = await fs.stat(filePath);
		if (now - stat.mtimeMs > abandonedFileAfterMs) {
			await fs.rm(filePath, { force: true });
		}
	} catch {
		// The writer or another registry reader may already have replaced it.
	}
}
