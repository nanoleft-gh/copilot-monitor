import * as http from 'node:http';
import {
	GatewayCreateSessionRequest,
	GatewayPermissionLevelRequest,
	GatewayRenameSessionRequest,
	GatewayModelSelectionRequest,
	GatewayModelConfigurationRequest,
	GatewaySelectSessionRequest,
	GatewaySendMessageRequest,
	GatewayState,
	GatewayToolDecisionRequest,
	GatewayWindowState,
	MonitorRequestError,
	MonitorState,
	SendMessageResult,
	CreateSessionResult,
} from './protocol';
import { readActiveWindowDescriptors, WindowDescriptor } from './windowRegistry';

const defaultScanIntervalMs = 1_000;
const relayRequestTimeoutMs = 15_000;

export class AggregateMonitor {
	private readonly listeners = new Set<(state: GatewayState) => void>();
	private readonly connections = new Map<string, WindowConnection>();
	private readonly gatewayStartedAt = Date.now();
	private scanTimer: NodeJS.Timeout | undefined;
	private scanRunning = false;
	private eventClientCount = 0;

	constructor(
		private readonly registryDirectory: string,
		private readonly scanIntervalMs = defaultScanIntervalMs,
	) {}

	async start(): Promise<void> {
		await this.scan();
		this.scanTimer = setInterval(() => void this.scan(), this.scanIntervalMs);
		this.scanTimer.unref();
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

	async selectSession(request: GatewaySelectSessionRequest): Promise<void> {
		const connection = this.connections.get(request.windowId);
		if (!connection) {
			throw new MonitorRequestError(404, 'The selected VS Code window is no longer available.');
		}
		await connection.postJson('/api/sessions/select', {
			sessionResource: request.sessionResource,
		});
	}

	async renameSession(request: GatewayRenameSessionRequest): Promise<void> {
		const connection = this.requireConnection(request.windowId);
		await connection.postJson('/api/sessions/rename', { sessionResource: request.sessionResource, title: request.title });
	}

	async createSession(request: GatewayCreateSessionRequest): Promise<CreateSessionResult> {
		const connection = this.requireConnection(request.windowId);
		return connection.postJson<CreateSessionResult>('/api/sessions/new', { sourceSessionResource: request.sourceSessionResource });
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
		for (const connection of this.connections.values()) {
			connection.setEventClientCount(count);
		}
	}

	dispose(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = undefined;
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

	private async scan(): Promise<void> {
		if (this.scanRunning) {
			return;
		}
		this.scanRunning = true;
		try {
			const descriptors = await readActiveWindowDescriptors(this.registryDirectory);
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
					const connection = new WindowConnection(descriptor, () => this.emit());
					this.connections.set(descriptor.windowId, connection);
					connection.setEventClientCount(this.eventClientCount);
					connection.connect();
					changed = true;
				} else {
					changed = current.updateDescriptor(descriptor) || changed;
					current.connect();
				}
			}

			if (changed) {
				this.emit();
			}
		} finally {
			this.scanRunning = false;
		}
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

	constructor(
		private descriptor: WindowDescriptor,
		private readonly onChange: () => void,
	) {}

	get localPort(): number {
		return this.descriptor.localPort;
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
		if (this.request || this.response) {
			return;
		}
		this.buffer = '';
		const request = http.get({
			host: '127.0.0.1',
			port: this.descriptor.localPort,
			path: '/api/events?relay=1',
		}, response => {
			this.response = response;
			if (response.statusCode !== 200) {
				response.resume();
				this.handleDisconnect();
				return;
			}
			this.connected = true;
			this.forwardEventClientCount();
			this.onChange();
			response.setEncoding('utf8');
			response.on('data', chunk => this.handleData(String(chunk)));
			response.on('close', () => this.handleDisconnect());
			response.on('error', () => this.handleDisconnect());
		});
		this.request = request;
		request.on('error', () => this.handleDisconnect());
	}

	setEventClientCount(count: number): void {
		this.eventClientCount = count;
		if (this.connected) {
			this.forwardEventClientCount();
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
			const dataLine = event.split('\n').find(line => line.startsWith('data: '));
			if (!dataLine) {
				continue;
			}
			try {
				const state = JSON.parse(dataLine.slice(6)) as MonitorState;
				if (state.version === 1 && state.windowId === this.descriptor.windowId) {
					this.state = state;
					this.onChange();
				}
			} catch {
				// Ignore malformed or partially received events.
			}
		}
	}

	private handleDisconnect(): void {
		const wasConnected = this.connected;
		this.request?.destroy();
		this.response?.destroy();
		this.request = undefined;
		this.response = undefined;
		this.connected = false;
		if (wasConnected) {
			this.onChange();
		}
	}

	private forwardEventClientCount(): void {
		void this.postJson('/api/clients', { count: this.eventClientCount }).catch(() => undefined);
	}
}