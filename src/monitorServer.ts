import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { CreateSessionRequest, CreateSessionResult, ModelConfigurationRequest, ModelSelectionRequest, MonitorRequestError, MonitorState, PermissionLevelRequest, RenameSessionRequest, SelectSessionRequest, SendMessageRequest, SendMessageResult, ToolDecisionRequest } from './protocol';

const maximumRequestBytes = 64 * 1024;

interface EventClient {
	readonly response: http.ServerResponse;
	readonly countsAsDashboard: boolean;
	waitingForDrain: boolean;
	pendingState?: string;
}

export interface MonitorBackend {
	getState(): MonitorState;
	onDidChange(listener: (state: MonitorState) => void): { dispose(): void };
	sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
	selectSession?(sessionResource: string): Promise<void>;
	selectModel?(request: ModelSelectionRequest): Promise<void>;
	configureModel?(request: ModelConfigurationRequest): Promise<void>;
	renameSession?(request: RenameSessionRequest): Promise<void>;
	createSession?(request: CreateSessionRequest): Promise<CreateSessionResult>;
	setPermissionLevel?(request: PermissionLevelRequest): Promise<void>;
	decideTool?(request: ToolDecisionRequest): Promise<void>;
	setEventClientCount?(count: number): void;
}

export interface MonitorServerOptions {
	readonly host: string;
	readonly advertisedHost?: string;
	readonly port: number;
	readonly html?: string;
	readonly mermaidScript?: string;
	readonly iconSvg?: string;
}

export interface MonitorServerAddress {
	readonly host: string;
	readonly port: number;
	readonly url: string;
}

export class MonitorServer {
	private readonly server: http.Server;
	private readonly eventClients = new Set<EventClient>();
	private readonly backendSubscription: { dispose(): void };
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private address: MonitorServerAddress | undefined;

	constructor(
		private readonly backend: MonitorBackend,
		private readonly options: MonitorServerOptions,
	) {
		this.server = http.createServer((request, response) => void this.handleRequest(request, response));
		this.backendSubscription = backend.onDidChange(state => this.broadcastState(state));
	}

	async start(): Promise<MonitorServerAddress> {
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
		const displayHost = this.options.advertisedHost ?? (this.options.host === '0.0.0.0' ? '127.0.0.1' : this.options.host);
		this.address = {
			host: this.options.host,
			port: info.port,
			url: `http://${displayHost}:${info.port}/`,
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
		if (!this.server.listening) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
		});
		this.address = undefined;
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		try {
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.method === 'GET' && url.pathname === '/') {
				if (!this.options.html) {
					this.sendJson(response, 404, { error: 'Not found.' });
					return;
				}
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
					service: 'githubcopilot-monitor-window',
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
				this.openEventStream(request, response, url.searchParams.get('relay') !== '1');
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/clients') {
				const body = await this.readJsonBody(request) as { count?: unknown };
				const count = typeof body.count === 'number' && Number.isInteger(body.count) && body.count >= 0
					? body.count
					: undefined;
				if (count === undefined) {
					throw new MonitorRequestError(400, 'A non-negative client count is required.');
				}
				this.backend.setEventClientCount?.(count);
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/messages') {
				const body = await this.readJsonBody(request) as Partial<SendMessageRequest>;
				const result = await this.backend.sendMessage({
					id: typeof body.id === 'string' ? body.id : '',
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					text: typeof body.text === 'string' ? body.text : '',
				});
				this.sendJson(response, 202, result);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/select') {
				const body = await this.readJsonBody(request) as Partial<SelectSessionRequest>;
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				if (!sessionResource) {
					throw new MonitorRequestError(400, 'Session resource is required.');
				}
				if (!this.backend.selectSession) {
					throw new MonitorRequestError(501, 'Session selection is unavailable.');
				}
				await this.backend.selectSession(sessionResource);
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/rename') {
				const body = await this.readJsonBody(request) as Partial<RenameSessionRequest>;
				if (!this.backend.renameSession) {throw new MonitorRequestError(501, 'Chat rename is unavailable.');}
				await this.backend.renameSession({
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					title: typeof body.title === 'string' ? body.title : '',
				});
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/new') {
				const body = await this.readJsonBody(request) as Partial<CreateSessionRequest>;
				if (!this.backend.createSession) {throw new MonitorRequestError(501, 'New chat is unavailable.');}
				const result = await this.backend.createSession({
					sourceSessionResource: typeof body.sourceSessionResource === 'string' ? body.sourceSessionResource : undefined,
				});
				this.sendJson(response, 201, result);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/permission') {
				const body = await this.readJsonBody(request) as Partial<PermissionLevelRequest>;
				const permissionLevel = body.permissionLevel === 'default' || body.permissionLevel === 'autoApprove' || body.permissionLevel === 'autopilot'
					? body.permissionLevel : undefined;
				if (!this.backend.setPermissionLevel) {throw new MonitorRequestError(501, 'Approval mode is unavailable.');}
				if (!permissionLevel) {throw new MonitorRequestError(400, 'A valid approval mode is required.');}
				await this.backend.setPermissionLevel({
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					permissionLevel,
				});
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/tools/decision') {
				const body = await this.readJsonBody(request) as Partial<ToolDecisionRequest>;
				const decision = body.decision === 'allow' || body.decision === 'skip' ? body.decision : undefined;
				if (!this.backend.decideTool || !decision) {
					throw new MonitorRequestError(this.backend.decideTool ? 400 : 501, 'A valid tool decision is required.');
				}
				await this.backend.decideTool({
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					requestId: typeof body.requestId === 'string' ? body.requestId : '',
					toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : '',
					decision,
				});
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/models/select') {
				const body = await this.readJsonBody(request) as Partial<ModelSelectionRequest>;
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const modelId = typeof body.modelId === 'string' ? body.modelId : '';
				if (!this.backend.selectModel) {
					throw new MonitorRequestError(501, 'Model selection is unavailable.');
				}
				if (!sessionResource || !modelId) {
					throw new MonitorRequestError(400, 'Session resource and model id are required.');
				}
				await this.backend.selectModel({ sessionResource, modelId });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/models/configure') {
				const body = await this.readJsonBody(request) as Partial<ModelConfigurationRequest>;
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const modelId = typeof body.modelId === 'string' ? body.modelId : '';
				const key = typeof body.key === 'string' ? body.key : '';
				const value = typeof body.value === 'string' || typeof body.value === 'number' || typeof body.value === 'boolean'
					? body.value
					: undefined;
				if (!this.backend.configureModel) {
					throw new MonitorRequestError(501, 'Model configuration is unavailable.');
				}
				if (!sessionResource || !modelId || !key || value === undefined) {
					throw new MonitorRequestError(400, 'Session resource, model id, configuration key, and value are required.');
				}
				await this.backend.configureModel({ sessionResource, modelId, key, value });
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
		response.end(this.options.html!);
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

	private openEventStream(request: http.IncomingMessage, response: http.ServerResponse, countsAsDashboard: boolean): void {
		response.writeHead(200, {
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'Content-Type': 'text/event-stream; charset=utf-8',
			'X-Accel-Buffering': 'no',
		});
		response.flushHeaders();
		const client: EventClient = { response, countsAsDashboard, waitingForDrain: false };
		this.eventClients.add(client);
		this.updateDashboardClientCount();
		this.writeState(client, JSON.stringify(this.backend.getState()));
		request.on('close', () => {
			this.eventClients.delete(client);
			this.updateDashboardClientCount();
		});
	}

	private updateDashboardClientCount(): void {
		const count = [...this.eventClients].filter(client => client.countsAsDashboard).length;
		this.backend.setEventClientCount?.(count);
	}

	private broadcastState(state: MonitorState): void {
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

		const writable = client.response.write(`event: state\ndata: ${serializedState}\n\n`);
		if (writable) {
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