import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const windowHeartbeatIntervalMs = 2_000;
export const windowStaleAfterMs = 8_000;

export interface WindowDescriptor {
	readonly version: 1;
	readonly windowId: string;
	readonly localPort: number;
	readonly workspaceName: string;
	readonly workspaceFolders: readonly string[];
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly pid: number;
}

export class WindowRegistry {
	private readonly descriptorPath: string;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private descriptor: WindowDescriptor | undefined;

	constructor(
		readonly directory: string,
		private readonly windowId: string,
	) {
		this.descriptorPath = path.join(directory, `${windowId}.json`);
	}

	async start(descriptor: Omit<WindowDescriptor, 'version' | 'windowId' | 'heartbeatAt'>): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		this.descriptor = {
			...descriptor,
			version: 1,
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
		await fs.rm(this.descriptorPath, { force: true }).catch(() => undefined);
	}

	private async writeHeartbeat(): Promise<void> {
		if (!this.descriptor) {
			return;
		}
		this.descriptor = { ...this.descriptor, heartbeatAt: Date.now() };
		await fs.writeFile(this.descriptorPath, JSON.stringify(this.descriptor), 'utf8').catch(() => undefined);
	}
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
		if (!entry.endsWith('.json')) {
			continue;
		}
		const filePath = path.join(directory, entry);
		try {
			const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
			if (!isWindowDescriptor(value)) {
				continue;
			}
			if (now - value.heartbeatAt > staleAfterMs) {
				await fs.rm(filePath, { force: true }).catch(() => undefined);
				continue;
			}
			descriptors.push(value);
		} catch {
			// A heartbeat write may be observed between truncate and write.
		}
	}

	return descriptors.sort((left, right) => left.startedAt - right.startedAt);
}

function isWindowDescriptor(value: unknown): value is WindowDescriptor {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<WindowDescriptor>;
	return candidate.version === 1
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