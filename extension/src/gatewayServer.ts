import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
	apiCapabilities,
	apiVersion,
	CreateSessionResult,
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
	HistoryPageResult,
	MonitorRequestError,
	SendMessageResult,
} from './protocol';
import { StateStreamHub } from './stateStream';
import { authCookie, clearedAuthCookie, presentedToken, requestIsHttps, tokensMatch } from './gatewayAuth';

const maximumRequestBytes = 64 * 1024;
/** Minimum spacing between re-reads of the secret file triggered by rejected tokens. */
const secretRefreshIntervalMs = 2_000;

export interface GatewayBackend {
	getState(): GatewayState;
	onDidChange(listener: (state: GatewayState) => void): { dispose(): void };
	sendMessage(request: GatewaySendMessageRequest): Promise<SendMessageResult>;
	editTurn(request: GatewayEditTurnRequest): Promise<SendMessageResult>;
	selectSession(request: GatewaySelectSessionRequest): Promise<void>;
	syncSession(request: GatewaySyncSessionRequest): Promise<void>;
	loadHistory(request: GatewayHistoryPageRequest): Promise<HistoryPageResult>;
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
	readonly hostId?: string;
	readonly leaseNonce?: string;
	readonly ownerId?: string;
	readonly html: string;
	readonly mermaidScript?: string;
	readonly iconSvg?: string;
	/** Bearer token required on every `/api/*` route except health and auth; re-read after a mismatch so a reset converges. */
	readonly readPairingSecret: () => Promise<string>;
	readonly secretRefreshIntervalMs?: number;
	/** Every URL a client may reach this gateway through (LAN addresses, tunnels); re-read per health request. */
	readonly getEndpoints?: (port: number) => readonly string[];
}

export interface GatewayAddress {
	readonly host: string;
	readonly port: number;
	readonly url: string;
}

export class GatewayServer {
	private readonly server: http.Server;
	private readonly streams: StateStreamHub<GatewayState>;
	private readonly backendSubscription: { dispose(): void };
	private address: GatewayAddress | undefined;
	private pairingSecret = '';
	private secretRefreshedAt = 0;

	constructor(
		private readonly backend: GatewayBackend,
		private readonly options: GatewayServerOptions,
	) {
		this.server = http.createServer((request, response) => void this.handleRequest(request, response));
		this.streams = new StateStreamHub<GatewayState>(() => backend.getState(), {
			onDidChangeViewerCount: count => backend.setEventClientCount?.(count),
		});
		this.backendSubscription = backend.onDidChange(state => this.streams.broadcast(state));
	}

	async start(): Promise<GatewayAddress> {
		if (this.address) {
			return this.address;
		}
		this.pairingSecret = await this.options.readPairingSecret();
		this.secretRefreshedAt = Date.now();
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
		return this.address;
	}

	async stop(): Promise<void> {
		this.backendSubscription.dispose();
		this.streams.closeAll();
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
				const port = this.address?.port ?? this.options.port;
				this.sendJson(response, 200, {
					service: 'githubcopilot-monitor-gateway',
					registryId: this.options.registryId,
					...(this.options.hostId ? { hostId: this.options.hostId } : {}),
					...(this.options.leaseNonce ? { leaseNonce: this.options.leaseNonce } : {}),
					...(this.options.ownerId ? { ownerId: this.options.ownerId } : {}),
					apiVersion,
					capabilities: apiCapabilities,
					authRequired: true,
					authorized: await this.isAuthorized(request),
					endpoints: this.options.getEndpoints?.(port) ?? [],
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/auth') {
				// Browsers cannot attach headers to EventSource, so the dashboard trades the secret for a cookie once.
				const body = await this.readJsonBody(request) as { token?: unknown };
				const token = typeof body.token === 'string' ? body.token : undefined;
				if (!await this.isAuthorized({ headers: { authorization: token ? `Bearer ${token}` : undefined } })) {
					response.setHeader('Set-Cookie', clearedAuthCookie());
					throw new MonitorRequestError(401, 'This pairing code is not valid for this computer.');
				}
				response.setHeader('Set-Cookie', authCookie(this.pairingSecret, requestIsHttps(request)));
				this.sendJson(response, 204, undefined);
				return;
			}
			if (url.pathname.startsWith('/api/') && !await this.isAuthorized(request)) {
				throw new MonitorRequestError(401, 'Not paired with this computer. Scan its pairing code again.');
			}
			if (request.method === 'GET' && url.pathname === '/api/state') {
				this.sendJson(response, 200, this.backend.getState());
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/events') {
				this.streams.open(request, response, {
					protocol: StateStreamHub.protocolFromQuery(url.searchParams.get('v')),
					countsAsViewer: true,
				});
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/presence') {
				// Follower windows hold this stream open; its closure tells them the gateway is gone.
				// It carries no state and is not a viewer.
				const client = this.streams.open(request, response, { protocol: 'none', countsAsViewer: false });
				client.write(`event: gateway\ndata: ${JSON.stringify({ registryId: this.options.registryId, leaseNonce: this.options.leaseNonce ?? null })}\n\n`);
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
			if (request.method === 'POST' && url.pathname === '/api/turns/edit') {
				const body = await this.readJsonBody(request) as Partial<GatewayEditTurnRequest>;
				const result = await this.backend.editTurn({
					windowId: typeof body.windowId === 'string' ? body.windowId : '',
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
			if (request.method === 'POST' && url.pathname === '/api/sessions/sync') {
				const body = await this.readJsonBody(request) as Partial<GatewaySyncSessionRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				if (!windowId || !sessionResource) {
					throw new MonitorRequestError(400, 'Window id and session resource are required.');
				}
				await this.backend.syncSession({ windowId, sessionResource });
				this.sendJson(response, 204, undefined);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/sessions/history') {
				const body = await this.readJsonBody(request) as Partial<GatewayHistoryPageRequest>;
				const windowId = typeof body.windowId === 'string' ? body.windowId : '';
				const sessionResource = typeof body.sessionResource === 'string' ? body.sessionResource : '';
				const sessionRevision = typeof body.sessionRevision === 'string' ? body.sessionRevision : '';
				if (!windowId || !sessionResource || !sessionRevision) {
					throw new MonitorRequestError(400, 'Window id, session resource, and revision are required.');
				}
				const result = await this.backend.loadHistory({
					windowId,
					sessionResource,
					sessionRevision,
					before: typeof body.before === 'number' ? body.before : 0,
					limit: typeof body.limit === 'number' ? body.limit : undefined,
				});
				this.sendJson(response, 200, result);
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
					...(typeof body.id === 'string' ? { id: body.id } : {}),
					...(typeof body.sourceSessionResource === 'string' ? { sourceSessionResource: body.sourceSessionResource } : {}),
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

	private async isAuthorized(request: Pick<http.IncomingMessage, 'headers'>): Promise<boolean> {
		const token = presentedToken(request);
		if (tokensMatch(this.pairingSecret, token)) {
			return true;
		}
		if (!token || Date.now() - this.secretRefreshedAt < (this.options.secretRefreshIntervalMs ?? secretRefreshIntervalMs)) {
			return false;
		}
		this.secretRefreshedAt = Date.now();
		try {
			this.pairingSecret = await this.options.readPairingSecret();
		} catch {
			return false;
		}
		return tokensMatch(this.pairingSecret, token);
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