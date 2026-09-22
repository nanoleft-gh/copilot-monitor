import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { apiCapabilities, apiVersion, CreateSessionRequest, CreateSessionResult, EditTurnRequest, EditTurnResult, HistoryPageRequest, HistoryPageResult, ModelConfigurationRequest, ModelSelectionRequest, MonitorRequestError, MonitorState, PermissionLevelRequest, RenameSessionRequest, SelectSessionRequest, SendMessageRequest, SendMessageResult, SyncSessionRequest, ToolDecisionRequest } from './protocol';
import { StateStreamHub } from './stateStream';

const maximumRequestBytes = 64 * 1024;

export interface MonitorBackend {
	getState(): MonitorState;
	onDidChange(listener: (state: MonitorState) => void): { dispose(): void };
	sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
	editTurn?(request: EditTurnRequest): Promise<EditTurnResult>;
	selectSession?(sessionResource: string): Promise<void>;
	syncNow?(sessionResource?: string): Promise<void>;
	loadHistory?(request: HistoryPageRequest): Promise<HistoryPageResult>;
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
	private readonly streams: StateStreamHub<MonitorState>;
	private readonly backendSubscription: { dispose(): void };
	private address: MonitorServerAddress | undefined;

	constructor(
		private readonly backend: MonitorBackend,
		private readonly options: MonitorServerOptions,
	) {
		this.server = http.createServer((request, response) => void this.handleRequest(request, response));
		this.streams = new StateStreamHub<MonitorState>(() => backend.getState(), {
			onDidChangeViewerCount: count => backend.setEventClientCount?.(count),
		});
		this.backendSubscription = backend.onDidChange(state => this.streams.broadcast(state));
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
		return this.address;
	}

	async stop(): Promise<void> {
		this.backendSubscription.dispose();
		this.streams.closeAll();
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
					apiVersion,
					capabilities: apiCapabilities,
				});
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/state') {
				this.sendJson(response, 200, this.backend.getState());
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/events') {
				this.streams.open(request, response, {
					protocol: StateStreamHub.protocolFromQuery(url.searchParams.get('v')),
					countsAsViewer: url.searchParams.get('relay') !== '1',
				});
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
			if (request.method === 'POST' && url.pathname === '/api/turns/edit') {
				const body = await this.readJsonBody(request) as Partial<EditTurnRequest>;
				if (!this.backend.editTurn) {throw new MonitorRequestError(501, 'Historical request editing is unavailable.');}
				const result = await this.backend.editTurn({
					id: typeof body.id === 'string' ? body.id : '',
					sessionResource: typeof body.sessionResource === 'string' ? body.sessionResource : '',
					sessionRevision: typeof body.sessionRevision === 'string' ? body.sessionRevision : '',
					requestId: typeof body.requestId === 'string' ? body.requestId : '',
					text: typeof body.text === 'string' ? body.text : '',
					...(typeof body.sourceText === 'string' ? { sourceText: body.sourceText } : {}),
					...(typeof body.sourceTimestamp === 'number' ? { sourceTimestamp: body.sourceTimestamp } : {}),
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
			if (request.method === 'POST' && url.pathname === '/api/sessions/sync') {
				const body = await this.readJsonBody(request) as Partial<SyncSessionRequest>;
				if (!this.backend.syncNow) {
					throw new MonitorRequestError(501, 'On-demand sync is unavailable.');
				}
				await this.backend.syncNow(typeof body.sessionResource === 'string' ? body.sessionResource : undefined);
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/history') {
				if (!this.backend.loadHistory) {throw new MonitorRequestError(501, 'Progressive history loading is unavailable.');}
				const body = await this.readJsonBody(request) as Partial<HistoryPageRequest>;
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const sessionRevision = typeof body.sessionRevision === 'string' ? body.sessionRevision : '';
				if (!sessionResource || !sessionRevision) {
					throw new MonitorRequestError(400, 'Session resource and revision are required.');
				}
				const result = await this.backend.loadHistory({
					sessionResource,
					sessionRevision,
					before: typeof body.before === 'number' ? body.before : 0,
					limit: typeof body.limit === 'number' ? body.limit : undefined,
				});
				this.sendJson(response, 200, result);
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
					...(typeof body.id === 'string' ? { id: body.id } : {}),
					...(typeof body.sourceSessionResource === 'string' ? { sourceSessionResource: body.sourceSessionResource } : {}),
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