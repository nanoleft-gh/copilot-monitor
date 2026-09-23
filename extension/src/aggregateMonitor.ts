import * as http from 'node:http';
import { DirectoryWatcher } from './directoryWatcher';
import {
	GatewayCreateSessionRequest,
	GatewayEditTurnRequest,
	GatewayHistoryPageRequest,
	GatewayPermissionLevelRequest,
	GatewayRenameSessionRequest,
	GatewayModelSelectionRequest,
	GatewayModelConfigurationRequest,
	GatewaySelectSessionRequest,
	GatewaySyncSessionRequest,
	GatewaySendMessageRequest,
	GatewayState,
	GatewayToolDecisionRequest,
	GatewayWindowState,
	HistoryPageResult,
	MonitorRequestError,
	MonitorState,
	SendMessageResult,
	CreateSessionResult,
} from './protocol';
import { readWindowDescriptors, removeWindowDescriptor, WindowDescriptor } from './windowRegistry';
import { applyPatch, isPatch } from './stateDelta';
import type { WatchTarget } from './stateStream';

const defaultScanDebounceMs = 100;
const relayRequestTimeoutMs = 15_000;
/** Reconnect delays after the event stream to a window drops; after the last one the window is declared dead. */
const defaultReconnectDelaysMs: readonly number[] = [500, 1_500, 4_000];
/** Spacing between viewer updates sent to successive windows, so their attach work does not land at once. */
const defaultViewerFanoutSpacingMs = 100;

export interface AggregateMonitorOptions {
	readonly scanDebounceMs?: number;
	readonly reconnectDelaysMs?: readonly number[];
	readonly viewerFanoutSpacingMs?: number;
}

/**
 * Aggregates every window's bridge behind the shared gateway.
 *
 * Discovery is driven by fs.watch on the registry directory; liveness by the event-stream
 * connection to each window. A window whose stream drops is reconnected a few times with
 * growing delays and then removed together with its stale descriptor. Nothing polls.
 */
export class AggregateMonitor {
	private readonly listeners = new Set<(state: GatewayState) => void>();
	private readonly connections = new Map<string, WindowConnection>();
	private readonly gatewayStartedAt = Date.now();
	private readonly scanDebounceMs: number;
	private readonly reconnectDelaysMs: readonly number[];
	private readonly viewerFanoutSpacingMs: number;
	private watcher: DirectoryWatcher | undefined;
	private scanTimer: NodeJS.Timeout | undefined;
	private scanRunning: Promise<void> | undefined;
	private scanRequested = false;
	private eventClientCount = 0;
	private watched: readonly WatchTarget[] = [];
	private fanoutTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(
		private readonly registryDirectory: string,
		options: AggregateMonitorOptions = {},
	) {
		this.scanDebounceMs = options.scanDebounceMs ?? defaultScanDebounceMs;
		this.reconnectDelaysMs = options.reconnectDelaysMs ?? defaultReconnectDelaysMs;
		this.viewerFanoutSpacingMs = options.viewerFanoutSpacingMs ?? defaultViewerFanoutSpacingMs;
	}

	async start(): Promise<void> {
		await this.scan();
		this.watcher = new DirectoryWatcher(this.registryDirectory, event => {
			if (event.type === 'change' && event.name && !event.name.endsWith('.json')) {
				return;
			}
			this.requestScan();
		});
		this.watcher.start();
	}

	getState(): GatewayState {
		return {
			version: 2,
			gatewayStartedAt: this.gatewayStartedAt,
			windows: [...this.connections.values()]
				.map(connection => connection.getState())
				.sort((left, right) => left.startedAt - right.startedAt),
		};
	}

	onDidChange(listener: (state: GatewayState) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async sendMessage(request: GatewaySendMessageRequest): Promise<SendMessageResult> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		return connection.postJson<SendMessageResult>('/api/messages', {
			id: request.id,
			sessionResource: request.sessionResource,
			text: request.text,
		});
	}

	async editTurn(request: GatewayEditTurnRequest): Promise<SendMessageResult> {
		const connection = this.requireConnection(request.windowId);
		return connection.postJson<SendMessageResult>('/api/turns/edit', {
			id: request.id,
			sessionResource: request.sessionResource,
			sessionRevision: request.sessionRevision,
			requestId: request.requestId,
			text: request.text,
			...(request.sourceText !== undefined ? { sourceText: request.sourceText } : {}),
			...(request.sourceTimestamp !== undefined ? { sourceTimestamp: request.sourceTimestamp } : {}),
		});
	}

	async selectSession(request: GatewaySelectSessionRequest): Promise<void> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		await connection.postJson('/api/sessions/select', {
			sessionResource: request.sessionResource,
		});
	}

	async syncSession(request: GatewaySyncSessionRequest): Promise<void> {
		const connection = this.requireConnection(request.windowId);
		await connection.postJson('/api/sessions/sync', { sessionResource: request.sessionResource });
	}

	async loadHistory(request: GatewayHistoryPageRequest): Promise<HistoryPageResult> {
		const connection = this.requireConnection(request.windowId);
		return connection.postJson<HistoryPageResult>('/api/sessions/history', {
			sessionResource: request.sessionResource,
			sessionRevision: request.sessionRevision,
			before: request.before,
			limit: request.limit,
		});
	}

	async renameSession(request: GatewayRenameSessionRequest): Promise<void> {
		const connection = this.requireConnection(request.windowId);
		await connection.postJson('/api/sessions/rename', { sessionResource: request.sessionResource, title: request.title });
	}

	async createSession(request: GatewayCreateSessionRequest): Promise<CreateSessionResult> {
		const connection = this.requireConnection(request.windowId);
		return connection.postJson<CreateSessionResult>('/api/sessions/new', {
			...(request.id !== undefined ? { id: request.id } : {}),
			...(request.sourceSessionResource !== undefined ? { sourceSessionResource: request.sourceSessionResource } : {}),
		});
	}

	async setPermissionLevel(request: GatewayPermissionLevelRequest): Promise<void> {
		const connection = this.requireConnection(request.windowId);
		await connection.postJson('/api/sessions/permission', {
			sessionResource: request.sessionResource,
			permissionLevel: request.permissionLevel,
		});
	}

	async selectModel(request: GatewayModelSelectionRequest): Promise<void> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		await connection.postJson('/api/models/select', {
			sessionResource: request.sessionResource,
			modelId: request.modelId,
		});
	}

	async configureModel(request: GatewayModelConfigurationRequest): Promise<void> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		await connection.postJson('/api/models/configure', {
			sessionResource: request.sessionResource,
			modelId: request.modelId,
			key: request.key,
			value: request.value,
		});
	}

	async decideTool(request: GatewayToolDecisionRequest): Promise<void> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		await connection.postJson('/api/tools/decision', {
			sessionResource: request.sessionResource,
			requestId: request.requestId,
			toolCallId: request.toolCallId,
			decision: request.decision,
		});
	}

	setEventClientCount(count: number): void {
		this.eventClientCount = count;
		this.scheduleViewerFanout();
	}

	setWatched(targets: readonly WatchTarget[]): void {
		this.watched = targets;
		this.scheduleViewerFanout();
	}

	/** Pushes the viewer set to windows one at a time, spaced out, so five windows do not attach in the same tick. */
	private scheduleViewerFanout(): void {
		if (this.fanoutTimer || this.disposed) {
			return;
		}
		const pending = [...this.connections.values()];
		const step = () => {
			this.fanoutTimer = undefined;
			const connection = pending.shift();
			if (!connection || this.disposed) {
				return;
			}
			connection.setViewers(this.eventClientCount, this.watchedIn(connection.windowId));
			if (pending.length > 0) {
				this.fanoutTimer = setTimeout(step, this.viewerFanoutSpacingMs);
				this.fanoutTimer.unref();
			}
		};
		// The first window is updated on the next tick so several changes in one tick coalesce.
		this.fanoutTimer = setTimeout(step, 0);
		this.fanoutTimer.unref();
	}

	private watchedIn(windowId: string): string[] {
		return this.watched.filter(target => target.windowId === windowId).map(target => target.sessionResource);
	}

	dispose(): void {
		this.disposed = true;
		this.watcher?.dispose();
		this.watcher = undefined;
		if (this.scanTimer) {
			clearTimeout(this.scanTimer);
			this.scanTimer = undefined;
		}
		if (this.fanoutTimer) {
			clearTimeout(this.fanoutTimer);
			this.fanoutTimer = undefined;
		}
		for (const connection of this.connections.values()) {
			connection.dispose();
		}
		this.connections.clear();
		this.listeners.clear();
	}

	private requireConnection(windowId: string): WindowConnection {
		const connection = this.connections.get(windowId);
		if (!connection) {throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');}
		return connection;
	}

	private requestScan(): void {
		if (this.disposed || this.scanTimer) {
			return;
		}
		this.scanTimer = setTimeout(() => {
			this.scanTimer = undefined;
			void this.scan();
		}, this.scanDebounceMs);
		this.scanTimer.unref();
	}

	private scan(): Promise<void> {
		if (this.scanRunning) {
			this.scanRequested = true;
			return this.scanRunning;
		}
		this.scanRunning = this.doScan().finally(() => {
			this.scanRunning = undefined;
			if (this.scanRequested && !this.disposed) {
				this.scanRequested = false;
				void this.scan();
			}
		});
		return this.scanRunning;
	}

	private async doScan(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const descriptors = await readWindowDescriptors(this.registryDirectory);
		const activeIds = new Set(descriptors.map(descriptor => descriptor.windowId));
		let changed = false;

		for (const [windowId, connection] of this.connections) {
			if (!activeIds.has(windowId)) {
				connection.dispose();
				this.connections.delete(windowId);
				changed = true;
			}
		}

		for (const descriptor of descriptors) {
			const current = this.connections.get(descriptor.windowId);
			if (!current || current.localPort !== descriptor.localPort) {
				current?.dispose();
				const connection = new WindowConnection(
					descriptor,
					this.reconnectDelaysMs,
					() => this.emit(),
					() => this.forgetDeadWindow(descriptor.windowId),
				);
				this.connections.set(descriptor.windowId, connection);
				connection.setViewers(this.eventClientCount, this.watchedIn(descriptor.windowId));
				connection.connect();
				changed = true;
			} else {
				changed = current.updateDescriptor(descriptor) || changed;
			}
		}

		if (changed) {
			this.emit();
		}
	}

	/** The bridge behind a descriptor refused connections repeatedly: the window is gone. */
	private forgetDeadWindow(windowId: string): void {
		const connection = this.connections.get(windowId);
		if (!connection) {
			return;
		}
		connection.dispose();
		this.connections.delete(windowId);
		void removeWindowDescriptor(this.registryDirectory, windowId);
		this.emit();
	}

	private emit(): void {
		const state = this.getState();
		for (const listener of this.listeners) {
			listener(state);
		}
	}
}

class WindowConnection {
	private request: http.ClientRequest | undefined;
	private response: http.IncomingMessage | undefined;
	private state: MonitorState | undefined;
	private connected = false;
	private buffer = '';
	private eventClientCount = 0;
	private watched: readonly string[] = [];
	private forwardedViewers: string | undefined;
	private reconnectAttempt = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(
		private descriptor: WindowDescriptor,
		private readonly reconnectDelaysMs: readonly number[],
		private readonly onChange: () => void,
		private readonly onDead: () => void,
	) {}

	get localPort(): number {
		return this.descriptor.localPort;
	}

	get windowId(): string {
		return this.descriptor.windowId;
	}

	updateDescriptor(descriptor: WindowDescriptor): boolean {
		const changed = descriptor.workspaceName !== this.descriptor.workspaceName
			|| JSON.stringify(descriptor.workspaceFolders) !== JSON.stringify(this.descriptor.workspaceFolders);
		this.descriptor = descriptor;
		return changed;
	}

	getState(): GatewayWindowState {
		const state = this.state ?? {
			version: 1 as const,
			windowId: this.descriptor.windowId,
			workspaceName: this.descriptor.workspaceName,
			workspaceFolders: this.descriptor.workspaceFolders,
			startedAt: this.descriptor.startedAt,
			models: [],
			sessions: [],
			outboundMessages: [],
		};
		return {
			...state,
			connected: this.connected,
			heartbeatAt: this.descriptor.heartbeatAt,
		};
	}

	connect(): void {
		if (this.disposed || this.request || this.response) {
			return;
		}
		this.buffer = '';
		const request = http.get({
			host: '127.0.0.1',
			port: this.descriptor.localPort,
			path: '/api/events?relay=1&v=2',
		}, response => {
			this.response = response;
			if (response.statusCode !== 200) {
				response.resume();
				this.handleDisconnect();
				return;
			}
			this.connected = true;
			this.reconnectAttempt = 0;
			this.forwardedViewers = undefined;
			this.forwardViewers();
			this.onChange();
			response.setEncoding('utf8');
			response.on('data', chunk => this.handleData(String(chunk)));
			response.on('close', () => this.handleDisconnect());
			response.on('error', () => this.handleDisconnect());
		});
		this.request = request;
		request.on('error', () => this.handleDisconnect());
	}

	setViewers(count: number, watched: readonly string[]): void {
		this.eventClientCount = count;
		this.watched = watched;
		if (this.connected) {
			this.forwardViewers();
		}
	}

	async postJson<T = void>(route: string, value: unknown): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), relayRequestTimeoutMs);
		try {
			const response = await fetch(`http://127.0.0.1:${this.descriptor.localPort}${route}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(value),
				signal: controller.signal,
			});
			const text = await response.text();
			const result = text ? JSON.parse(text) as { error?: string } & T : undefined;
			if (!response.ok) {
				throw new MonitorRequestError(response.status, result?.error || `Window bridge returned ${response.status}.`);
			}
			return result as T;
		} catch (error) {
			if (error instanceof MonitorRequestError) {
				throw error;
			}
			throw new MonitorRequestError(503, 'The selected VS Code window could not be reached.');
		} finally {
			clearTimeout(timer);
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.request?.destroy();
		this.response?.destroy();
		this.request = undefined;
		this.response = undefined;
		this.connected = false;
	}

	private handleData(chunk: string): void {
		this.buffer += chunk;
		let boundary: number;
		while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
			const event = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			const lines = event.split('\n');
			const eventName = lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message';
			const dataLine = lines.find(line => line.startsWith('data: '));
			if (!dataLine) {
				continue;
			}
			try {
				const payload = JSON.parse(dataLine.slice(6)) as unknown;
				if (eventName === 'patch') {
					if (!this.state || !isPatch(payload)) {
						throw new Error('patch without a base state');
					}
					this.acceptState(applyPatch(this.state, payload));
				} else if (eventName === 'snapshot' || eventName === 'state') {
					this.acceptState(payload);
				}
			} catch {
				// The stream is out of sync (malformed frame or inapplicable patch): reconnect for a snapshot.
				this.handleDisconnect();
				return;
			}
		}
	}

	private acceptState(value: unknown): void {
		const state = value as MonitorState;
		if (state.version === 1 && state.windowId === this.descriptor.windowId) {
			this.state = state;
			this.onChange();
		}
	}

	private handleDisconnect(): void {
		const wasConnected = this.connected;
		this.request?.destroy();
		this.response?.destroy();
		this.request = undefined;
		this.response = undefined;
		this.connected = false;
		if (this.disposed) {
			return;
		}
		if (wasConnected) {
			this.onChange();
		}
		this.scheduleReconnect();
	}

	/** Bounded reconnects; when they run out the window is reported dead. */
	private scheduleReconnect(): void {
		if (this.reconnectTimer) {
			return;
		}
		const delay = this.reconnectDelaysMs[this.reconnectAttempt];
		if (delay === undefined) {
			this.onDead();
			return;
		}
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
		this.reconnectTimer.unref();
	}

	private forwardViewers(): void {
		const payload = { count: this.eventClientCount, watched: this.watched };
		const key = JSON.stringify(payload);
		if (key === this.forwardedViewers) {
			return;
		}
		this.forwardedViewers = key;
		void this.postJson('/api/clients', payload).catch(() => {
			this.forwardedViewers = undefined;
		});
	}
}