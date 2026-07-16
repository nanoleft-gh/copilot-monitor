import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
	CreateSessionResult,
	GatewayCreateSessionRequest,
	GatewayPermissionLevelRequest,
	GatewayRenameSessionRequest,
	GatewayModelSelectionRequest,
	GatewayModelConfigurationRequest,
	GatewaySelectSessionRequest,
	GatewaySendMessageRequest,
	GatewayState,
	GatewayToolDecisionRequest,
	MonitorRequestError,
	SendMessageResult,
} from './protocol';

const maximumRequestBytes = 64 * 1024;

interface EventClient {
	readonly response: http.ServerResponse;
	waitingForDrain: boolean;
	pendingState?: string;
}

export interface GatewayBackend {
	getState(): GatewayState;
	onDidChange(listener: (state: GatewayState) => void): { dispose(): void };
	sendMessage(request: GatewaySendMessageRequest): Promise<SendMessageResult>;
	selectSession(request: GatewaySelectSessionRequest): Promise<void>;
	selectModel(request: GatewayModelSelectionRequest): Promise<void>;
	configureModel(request: GatewayModelConfigurationRequest): Promise<void>;
	renameSession(request: GatewayRenameSessionRequest): Promise<void>;
	createSession(request: GatewayCreateSessionRequest): Promise<CreateSessionResult>;
	setPermissionLevel(request: GatewayPermissionLevelRequest): Promise<void>;
	decideTool(request: GatewayToolDecisionRequest): Promise<void>;
	setEventClientCount?(count: number): void;
}

export interface GatewayServerOptions {
	readonly host: string;
	readonly advertisedHost: string;
	readonly port: number;
	readonly registryId: string;
	readonly html: string;
	readonly mermaidScript?: string;
	readonly iconSvg?: string;
}

export interface GatewayAddress {
	readonly host: string;
	readonly port: number;
	readonly url: string;
}

export class GatewayServer {
	private readonly server: http.Server;
	private readonly eventClients = new Set<EventClient>();
	private readonly backendSubscription: { dispose(): void };
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private address: GatewayAddress | undefined;

	constructor(
		private readonly backend: GatewayBackend,
		private readonly options: GatewayServerOptions,
	) {
		this.server = http.createServer((request, response) => void this.handleRequest(request, response));
		this.backendSubscription = backend.onDidChange(state => this.broadcastState(state));
	}

	async start(): Promise<GatewayAddress> {
		if (this.address) {
			return this.address;
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				this.server.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				this.server.off('error', onError);
				resolve();
			};
			this.server.once('error', onError);
			this.server.once('listening', onListening);
			this.server.listen(this.options.port, this.options.host);
		});

		const info = this.server.address() as AddressInfo;
		this.address = {
			host: this.options.host,
			port: info.port,
			url: `http://${this.options.advertisedHost}:${info.port}/`,
		};
		this.heartbeatTimer = setInterval(() => {
			for (const client of this.eventClients) {
				if (!client.waitingForDrain) {
					client.response.write(': heartbeat\n\n');
				}
			}
		}, 15_000);
		this.heartbeatTimer.unref();
		return this.address;
	}

	async stop(): Promise<void> {
		this.backendSubscription.dispose();
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		for (const client of this.eventClients) {
			client.response.end();
		}
		this.eventClients.clear();
		this.backend.setEventClientCount?.(0);
		if (this.server.listening) {
			await new Promise<void>((resolve, reject) => {
				this.server.close(error => error ? reject(error) : resolve());
			});
		}
		this.address = undefined;
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.method === 'GET' && url.pathname === '/') {
				this.sendHtml(response);
				return;
			}
			if (request.method === 'GET' && url.pathname === '/assets/mermaid.min.js') {
				if (!this.options.mermaidScript) {
					this.sendJson(response, 404, { error: 'Not found.' });
					return;
				}
				this.sendJavaScript(response, this.options.mermaidScript);
				return;
			}
			if (request.method === 'GET' && url.pathname === '/assets/icon.svg') {
				if (!this.options.iconSvg) {return this.sendJson(response, 404, { error: 'Not found.' });}
				this.sendSvg(response, this.options.iconSvg);
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/health') {
				this.sendJson(response, 200, {
					service: 'githubcopilot-monitor-gateway',
					registryId: this.options.registryId,
					apiVersion: 3,
					capabilities: ['sessionRename', 'sessionCreate', 'sessionPermission'],
				});
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/state') {
				this.sendJson(response, 200, this.backend.getState());
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/events') {
				this.openEventStream(request, response);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/messages') {
				const body = await this.readJsonBody(request) as Partial<GatewaySendMessageRequest>;
				const result = await this.backend.sendMessage({
					windowId: typeof body.windowId === 'string' ? body.windowId : '',
					id: typeof body.id === 'string' ? body.id : '',
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					text: typeof body.text === 'string' ? body.text : '',
				});
				this.sendJson(response, 202, result);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/select') {
				const body = await this.readJsonBody(request) as Partial<GatewaySelectSessionRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				if (!windowId || !sessionResource) {
					throw new MonitorRequestError(400, 'Window id and session resource are required.');
				}
				await this.backend.selectSession({ windowId, sessionResource });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/rename') {
				const body = await this.readJsonBody(request) as Partial<GatewayRenameSessionRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const title = typeof body.title === 'string' ? body.title : '';
				if (!windowId || !sessionResource || !title) {throw new MonitorRequestError(400, 'Window id, session resource, and title are required.');}
				await this.backend.renameSession({ windowId, sessionResource, title });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/new') {
				const body = await this.readJsonBody(request) as Partial<GatewayCreateSessionRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				if (!windowId) {throw new MonitorRequestError(400, 'Window id is required.');}
				const result = await this.backend.createSession({
					windowId,
					sourceSessionResource: typeof body.sourceSessionResource === 'string' ? body.sourceSessionResource : undefined,
				});
				this.sendJson(response, 201, result);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/permission') {
				const body = await this.readJsonBody(request) as Partial<GatewayPermissionLevelRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const permissionLevel = body.permissionLevel === 'default' || body.permissionLevel === 'autoApprove' || body.permissionLevel === 'autopilot'
					? body.permissionLevel : undefined;
				if (!windowId || !sessionResource || !permissionLevel) {throw new MonitorRequestError(400, 'Window id, session resource, and approval mode are required.');}
				await this.backend.setPermissionLevel({ windowId, sessionResource, permissionLevel });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/tools/decision') {
				const body = await this.readJsonBody(request) as Partial<GatewayToolDecisionRequest>;
				const decision = body.decision === 'allow' || body.decision === 'skip' ? body.decision : undefined;
				if (!decision) {
					throw new MonitorRequestError(400, 'A valid tool decision is required.');
				}
				await this.backend.decideTool({
					windowId: typeof body.windowId === 'string' ? body.windowId : '',
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					requestId: typeof body.requestId === 'string' ? body.requestId : '',
					toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : '',
					decision,
				});
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/models/select') {
				const body = await this.readJsonBody(request) as Partial<GatewayModelSelectionRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const modelId = typeof body.modelId === 'string' ? body.modelId : '';
				if (!windowId || !sessionResource || !modelId) {
					throw new MonitorRequestError(400, 'Window id, session resource, and model id are required.');
				}
				await this.backend.selectModel({ windowId, sessionResource, modelId });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/models/configure') {
				const body = await this.readJsonBody(request) as Partial<GatewayModelConfigurationRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const modelId = typeof body.modelId === 'string' ? body.modelId : '';
				const key = typeof body.key === 'string' ? body.key : '';
				const value = typeof body.value === 'string' || typeof body.value === 'number' || typeof body.value === 'boolean'
					? body.value
					: undefined;
				if (!windowId || !sessionResource || !modelId || !key || value === undefined) {
					throw new MonitorRequestError(400, 'Window id, session resource, model id, configuration key, and value are required.');
				}
				await this.backend.configureModel({ windowId, sessionResource, modelId, key, value });
				this.sendJson(response, 204, undefined);
				return;
			}
			this.sendJson(response, 404, { error: 'Not found.' });
		} catch (error) {
			const statusCode = error instanceof MonitorRequestError ? error.statusCode : 500;
			this.sendJson(response, statusCode, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private sendHtml(response: http.ServerResponse): void {
		response.writeHead(200, {
			'Cache-Control': 'no-store',
			'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'DENY',
		});
		response.end(this.options.html);
	}

	private sendJavaScript(response: http.ServerResponse, value: string): void {
		response.writeHead(200, {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/javascript; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(value);
	}

	private sendSvg(response: http.ServerResponse, value: string): void {
		response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'image/svg+xml; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
		response.end(value);
	}

	private sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
		if (response.headersSent) {
			response.end();
			return;
		}
		response.writeHead(statusCode, {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
		});
		response.end(JSON.stringify(value));
	}

	private openEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
		response.writeHead(200, {
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'Content-Type': 'text/event-stream; charset=utf-8',
			'X-Accel-Buffering': 'no',
		});
		response.flushHeaders();
		const client: EventClient = { response, waitingForDrain: false };
		this.eventClients.add(client);
		this.backend.setEventClientCount?.(this.eventClients.size);
		this.writeState(client, JSON.stringify(this.backend.getState()));
		request.on('close', () => {
			this.eventClients.delete(client);
			this.backend.setEventClientCount?.(this.eventClients.size);
		});
	}

	private broadcastState(state: GatewayState): void {
		const serialized = JSON.stringify(state);
		for (const client of this.eventClients) {
			this.writeState(client, serialized);
		}
	}

	private writeState(client: EventClient, serializedState: string): void {
		if (client.waitingForDrain) {
			client.pendingState = serializedState;
			return;
		}
		if (client.response.write(`event: state\ndata: ${serializedState}\n\n`)) {
			return;
		}
		client.waitingForDrain = true;
		client.response.once('drain', () => {
			if (!this.eventClients.has(client)) {
				return;
			}
			client.waitingForDrain = false;
			const pendingState = client.pendingState;
			client.pendingState = undefined;
			if (pendingState !== undefined) {
				this.writeState(client, pendingState);
			}
		});
	}

	private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > maximumRequestBytes) {
				throw new MonitorRequestError(413, 'Request body is too large.');
			}
			chunks.push(buffer);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new MonitorRequestError(400, 'Request body must be valid JSON.');
		}
	}
}