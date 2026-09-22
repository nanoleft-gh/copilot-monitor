import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { GatewayBackend, GatewayServer } from '../gatewayServer';
import { GatewayCoordinator } from '../gatewayCoordinator';
import { GatewayCreateSessionRequest, GatewayEditTurnRequest, GatewayHistoryPageRequest, GatewayModelConfigurationRequest, GatewayModelSelectionRequest, GatewayPermissionLevelRequest, GatewayRenameSessionRequest, GatewaySelectSessionRequest, GatewaySendMessageRequest, GatewayState, GatewaySyncSessionRequest, GatewayToolDecisionRequest, RemoteAccessStatus, RemoteAccessUpdateRequest } from '../protocol';

const emptyState: GatewayState = { version: 2, gatewayStartedAt: 1, windows: [] };
const secret = 'test-secret-0123456789abcdefghijklmnopqrstuv';
const readPairingSecret = async () => secret;
const authorized = { Authorization: `Bearer ${secret}` };
const jsonHeaders = { ...authorized, 'Content-Type': 'application/json' };

class TestGatewayBackend implements GatewayBackend {
	messages: GatewaySendMessageRequest[] = [];
	edits: GatewayEditTurnRequest[] = [];
	selections: GatewaySelectSessionRequest[] = [];
	syncs: GatewaySyncSessionRequest[] = [];
	historyRequests: GatewayHistoryPageRequest[] = [];
	clientCounts: number[] = [];
	toolDecisions: GatewayToolDecisionRequest[] = [];
	modelSelections: GatewayModelSelectionRequest[] = [];
	modelConfigurations: GatewayModelConfigurationRequest[] = [];
	renames: GatewayRenameSessionRequest[] = [];
	created: GatewayCreateSessionRequest[] = [];
	permissions: GatewayPermissionLevelRequest[] = [];
	private listener: ((state: GatewayState) => void) | undefined;

	getState(): GatewayState {
		return emptyState;
	}

	onDidChange(listener: (state: GatewayState) => void): { dispose(): void } {
		this.listener = listener;
		return { dispose: () => this.listener = undefined };
	}

	async sendMessage(request: GatewaySendMessageRequest) {
		this.messages.push(request);
		return { id: request.id, accepted: true as const };
	}

	async editTurn(request: GatewayEditTurnRequest) {
		this.edits.push(request);
		return { id: request.id, accepted: true as const };
	}

	async selectSession(request: GatewaySelectSessionRequest): Promise<void> {
		this.selections.push(request);
	}

	async syncSession(request: GatewaySyncSessionRequest): Promise<void> {
		this.syncs.push(request);
	}

	async loadHistory(request: GatewayHistoryPageRequest) {
		this.historyRequests.push(request);
		return { turns: [], totalCount: 80, start: 0, end: 40, hasEarlier: false, revision: request.sessionRevision };
	}

	setEventClientCount(count: number): void {
		this.clientCounts.push(count);
	}

	async decideTool(request: GatewayToolDecisionRequest): Promise<void> {
		this.toolDecisions.push(request);
	}

	async selectModel(request: GatewayModelSelectionRequest): Promise<void> {
		this.modelSelections.push(request);
	}

	async configureModel(request: GatewayModelConfigurationRequest): Promise<void> {
		this.modelConfigurations.push(request);
	}

	async renameSession(request: GatewayRenameSessionRequest): Promise<void> { this.renames.push(request); }
	async createSession(request: GatewayCreateSessionRequest) {
		this.created.push(request);
		return { sessionResource: 'new-session' };
	}
	async setPermissionLevel(request: GatewayPermissionLevelRequest): Promise<void> { this.permissions.push(request); }
}

describe('GatewayServer', () => {
	it('exposes remote access control to authenticated windows only', async () => {
		let status: RemoteAccessStatus = { enabled: false, provider: 'devtunnel', tunnel: { status: 'inactive' }, ngrok: { hasAuthtoken: false } };
		const updates: RemoteAccessUpdateRequest[] = [];
		const server = new GatewayServer(new TestGatewayBackend(), {
			host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, registryId: 'registry-remote', html: '<!doctype html>', readPairingSecret,
			remoteAccess: {
				get: async () => status,
				update: async request => {
					updates.push(request);
					status = { ...status, enabled: request.enabled ?? status.enabled, ...(request.manualUrl ? { manualUrl: request.manualUrl } : {}), tunnel: { status: 'active', url: 'https://abc-43121.inc1.devtunnels.ms/' } };
					return status;
				},
			},
		});
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;
		try {
			assert.equal((await fetch(`${baseUrl}/api/remote-access`)).status, 401);
			assert.deepEqual(await fetch(`${baseUrl}/api/remote-access`, { headers: authorized }).then(response => response.json()), { enabled: false, provider: 'devtunnel', tunnel: { status: 'inactive' }, ngrok: { hasAuthtoken: false } });
			const updated = await fetch(`${baseUrl}/api/remote-access`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ enabled: true, retry: true, manualUrl: 'https://pc.tail.ts.net/' }) });
			assert.equal(updated.status, 200);
			assert.deepEqual(updates, [{ enabled: true, retry: true, manualUrl: 'https://pc.tail.ts.net/' }]);
			assert.equal(((await updated.json()) as RemoteAccessStatus).tunnel.status, 'active');
			assert.equal((await fetch(`${baseUrl}/api/remote-access`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ manualUrl: 5 }) })).status, 400);
		} finally {
			await server.stop();
		}
		const bare = new GatewayServer(new TestGatewayBackend(), { host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, registryId: 'registry-bare', html: '', readPairingSecret });
		const bareAddress = await bare.start();
		try {
			assert.equal((await fetch(`http://127.0.0.1:${bareAddress.port}/api/remote-access`, { headers: authorized })).status, 501);
		} finally {
			await bare.stop();
		}
	});
	it('requires the pairing secret on every API route except health, and issues a cookie for browsers', async () => {
		let current = secret;
		const server = new GatewayServer(new TestGatewayBackend(), {
			host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0, registryId: 'registry-auth', html: '<!doctype html>',
			readPairingSecret: async () => current,
			secretRefreshIntervalMs: 0,
			getEndpoints: port => [`http://10.0.0.5:${port}/`, 'https://example-43121.devtunnels.ms/'],
		});
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;
		try {
			const health = await fetch(`${baseUrl}/api/health`).then(response => response.json()) as Record<string, unknown>;
			assert.equal(health.authRequired, true);
			assert.equal(health.authorized, false);
			assert.deepEqual(health.endpoints, [`http://10.0.0.5:${address.port}/`, 'https://example-43121.devtunnels.ms/']);
			assert.equal((await fetch(`${baseUrl}/api/state`)).status, 401);
			assert.equal((await fetch(`${baseUrl}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
			assert.equal((await fetch(`${baseUrl}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
			assert.equal((await fetch(`${baseUrl}/api/state`, { headers: authorized })).status, 200);
			assert.equal((await fetch(`${baseUrl}/`)).status, 200, 'the dashboard shell itself is public');

			const rejected = await fetch(`${baseUrl}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
			assert.equal(rejected.status, 401);
			const accepted = await fetch(`${baseUrl}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
			assert.equal(accepted.status, 204);
			const cookie = accepted.headers.get('set-cookie') ?? '';
			assert.match(cookie, /^cm_auth=/);
			assert.match(cookie, /HttpOnly/);
			assert.match(cookie, /SameSite=Strict/);
			assert.doesNotMatch(cookie, /Secure/, 'plain-HTTP LAN dashboards cannot use Secure cookies');
			const viaTunnel = await fetch(`${baseUrl}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ token: secret }) });
			assert.match(viaTunnel.headers.get('set-cookie') ?? '', /Secure/);
			const cookieOnly = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie.split(';')[0] } }).then(response => response.json()) as Record<string, unknown>;
			assert.equal(cookieOnly.authorized, true);
			assert.equal((await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie.split(';')[0] } })).status, 200);

			// A reset from another window: the server re-reads the secret when a token it does not know shows up.
			current = 'rotated-secret-0123456789abcdefghijklmnopqrs';
			assert.equal((await fetch(`${baseUrl}/api/state`, { headers: { Authorization: `Bearer ${current}` } })).status, 200);
			assert.equal((await fetch(`${baseUrl}/api/state`, { headers: authorized })).status, 401);
		} finally {
			await server.stop();
		}
	});

	it('serves one tokenless endpoint and routes window-aware requests', async () => {
		const backend = new TestGatewayBackend();
		const server = new GatewayServer(backend, {
			host: '127.0.0.1',
			advertisedHost: '127.0.0.1',
			port: 0,
			registryId: 'registry-1',
			html: '<!doctype html><title>Gateway</title>',
			mermaidScript: 'globalThis.mermaid = {};',
			iconSvg: '<svg/>',
			readPairingSecret,
		});
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;
		try {
			const health = await fetch(`${baseUrl}/api/health`).then(response => response.json());
			assert.deepEqual(health, {
				service: 'githubcopilot-monitor-gateway', registryId: 'registry-1', apiVersion: 4,
				capabilities: ['sessionRename', 'sessionCreate', 'sessionPermission', 'turnEdit', 'sessionSync', 'eventsV2', 'remoteAccess'],
				authRequired: true, authorized: false, endpoints: [],
			});
			const page = await fetch(`${baseUrl}/`);
			assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' 'unsafe-inline'/);
			assert.deepEqual(await fetch(`${baseUrl}/api/state`, { headers: authorized }).then(response => response.json()), { ...emptyState, endpoints: [] });
			const mermaid = await fetch(`${baseUrl}/assets/mermaid.min.js`);
			assert.equal(mermaid.status, 200);
			assert.match(mermaid.headers.get('content-type') ?? '', /text\/javascript/);
			assert.equal(await mermaid.text(), 'globalThis.mermaid = {};');
			assert.equal(await fetch(`${baseUrl}/assets/icon.svg`).then(response => response.text()), '<svg/>');
			const abortController = new AbortController();
			const events = await fetch(`${baseUrl}/api/events`, { signal: abortController.signal, headers: authorized });
			assert.equal(events.status, 200);
			assert.equal(backend.clientCounts.at(-1), 1);
			abortController.abort();

			const message = { windowId: 'w2', id: 'm1', sessionResource: 's2', text: 'Hello' };
			assert.equal((await fetch(`${baseUrl}/api/messages`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(message),
			})).status, 202);
			assert.deepEqual(backend.messages, [message]);

			const edit = { windowId: 'w2', id: 'e1', sessionResource: 's2', sessionRevision: 'rev-1', requestId: 'r1', text: 'Edited' };
			assert.equal((await fetch(`${baseUrl}/api/turns/edit`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(edit) })).status, 202);
			assert.deepEqual(backend.edits, [edit]);

			const selection = { windowId: 'w1', sessionResource: 's1' };
			assert.equal((await fetch(`${baseUrl}/api/sessions/select`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(selection),
			})).status, 204);
			assert.deepEqual(backend.selections, [selection]);

			assert.equal((await fetch(`${baseUrl}/api/sessions/sync`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(selection),
			})).status, 204);
			assert.deepEqual(backend.syncs, [selection]);

			const history = { windowId: 'w1', sessionResource: 's1', sessionRevision: 'rev-1', before: 40, limit: 40 };
			const historyResponse = await fetch(`${baseUrl}/api/sessions/history`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(history),
			});
			assert.equal(historyResponse.status, 200);
			assert.equal((await historyResponse.json() as { revision: string }).revision, 'rev-1');
			assert.deepEqual(backend.historyRequests, [history]);

			const decision = { windowId: 'w1', sessionResource: 's1', requestId: 'r1', toolCallId: 't1', decision: 'allow' };
			assert.equal((await fetch(`${baseUrl}/api/tools/decision`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(decision),
			})).status, 204);
			assert.deepEqual(backend.toolDecisions, [decision]);

			const modelSelection = { windowId: 'w1', sessionResource: 's1', modelId: 'copilot/gpt-test' };
			assert.equal((await fetch(`${baseUrl}/api/models/select`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(modelSelection),
			})).status, 204);
			assert.deepEqual(backend.modelSelections, [modelSelection]);

			const modelConfiguration = {
				windowId: 'w2', sessionResource: 's2', modelId: 'copilot/gpt-test', key: 'contextSize', value: 922000,
			};
			assert.equal((await fetch(`${baseUrl}/api/models/configure`, {
				method: 'POST', headers: jsonHeaders, body: JSON.stringify(modelConfiguration),
			})).status, 204);
			assert.deepEqual(backend.modelConfigurations, [modelConfiguration]);

			const rename = { windowId: 'w1', sessionResource: 's1', title: 'Renamed' };
			assert.equal((await fetch(`${baseUrl}/api/sessions/rename`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(rename) })).status, 204);
			assert.deepEqual(backend.renames, [rename]);
			const created = { id: 'new-1', windowId: 'w2', sourceSessionResource: 's2' };
			const createdResponse = await fetch(`${baseUrl}/api/sessions/new`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(created) });
			assert.equal(createdResponse.status, 201);
			assert.deepEqual(await createdResponse.json(), { sessionResource: 'new-session' });
			assert.deepEqual(backend.created, [created]);
			const permission = { windowId: 'w1', sessionResource: 's1', permissionLevel: 'autopilot' } as const;
			assert.equal((await fetch(`${baseUrl}/api/sessions/permission`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(permission) })).status, 204);
			assert.deepEqual(backend.permissions, [permission]);
		} finally {
			await server.stop();
		}
	});
});

describe('GatewayCoordinator', () => {
	it('falls back dynamically when the preferred port belongs to another application', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-gateway-'));
		const occupied = http.createServer((_request, response) => response.end('occupied'));
		await new Promise<void>((resolve, reject) => {
			occupied.once('error', reject);
			occupied.listen(0, '0.0.0.0', resolve);
		});
		const occupiedAddress = occupied.address();
		const preferredPort = typeof occupiedAddress === 'object' && occupiedAddress ? occupiedAddress.port : 0;
		const options = {
			registryDirectory: root,
			registryId: 'registry-dynamic',
			leaseDirectory: root,
			hostId: 'host-dynamic',
			port: preferredPort,
			advertisedHost: '127.0.0.1',
			html: '<!doctype html>',
			mermaidScript: 'globalThis.mermaid = {};',
			retryIntervalMs: 25,
			readPairingSecret,
		};
		const first = new GatewayCoordinator({ ...options, ownerId: 'window-1' });
		const second = new GatewayCoordinator({ ...options, ownerId: 'window-2' });
		try {
			const firstAddress = await first.start();
			const secondAddress = await second.start();
			assert.notEqual(firstAddress.port, preferredPort);
			assert.equal(secondAddress.port, firstAddress.port);
			assert.equal(Number(first.isLeader) + Number(second.isLeader), 1);
			const health = await fetch(`http://127.0.0.1:${firstAddress.port}/api/health`).then(response => response.json()) as { hostId: string };
			assert.equal(health.hostId, 'host-dynamic');
		} finally {
			await first.stop();
			await second.stop();
			await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('elects one port owner and fails over on the same port', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-gateway-'));
		const port = await findFreePort();
		const options = {
			registryDirectory: root,
			registryId: 'registry-failover',
			leaseDirectory: root,
			hostId: 'host-failover',
			port,
			advertisedHost: '127.0.0.1',
			html: '<!doctype html>',
			mermaidScript: 'globalThis.mermaid = {};',
			retryIntervalMs: 25,
			readPairingSecret,
		};
		const first = new GatewayCoordinator({ ...options, ownerId: 'window-1' });
		const second = new GatewayCoordinator({ ...options, ownerId: 'window-2' });
		try {
			await first.start();
			await second.start();
			assert.equal(Number(first.isLeader) + Number(second.isLeader), 1);
			const leader = first.isLeader ? first : second;
			const follower = first.isLeader ? second : first;
			await leader.stop();
			await waitFor(() => follower.isLeader, 2_000);
			const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(response => response.json()) as { registryId: string };
			assert.equal(health.registryId, 'registry-failover');
		} finally {
			await first.stop();
			await second.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('recovers a missing lease without replacing the healthy preferred gateway', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-gateway-'));
		const port = await findFreePort();
		const options = {
			registryDirectory: root,
			registryId: 'registry-converge',
			leaseDirectory: root,
			hostId: 'host-converge',
			port,
			advertisedHost: '127.0.0.1',
			html: '<!doctype html>',
			mermaidScript: 'globalThis.mermaid = {};',
			readPairingSecret,
		};
		const first = new GatewayCoordinator({ ...options, ownerId: 'window-1', retryIntervalMs: 25 });
		const second = new GatewayCoordinator({ ...options, ownerId: 'window-2', retryIntervalMs: 25 });
		try {
			assert.equal((await first.start()).port, port);
			await fs.rm(path.join(root, 'gateway.json'), { force: true });
			const secondAddress = await second.start();
			assert.equal(secondAddress.port, port);
			assert.equal(first.isLeader, true);
			assert.equal(second.isLeader, false);
			assert.equal((await first.resolveAddress()).port, port);
			assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
			const restoredLease = JSON.parse(await fs.readFile(path.join(root, 'gateway.json'), 'utf8')) as { port: number; nonce: string };
			assert.equal(restoredLease.port, port);
			assert.ok(restoredLease.nonce);
		} finally {
			await first.stop();
			await second.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('revalidates a follower address after the gateway lease changes', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-gateway-'));
		const port = await findFreePort();
		const options = {
			registryDirectory: root,
			registryId: 'registry-revalidate',
			leaseDirectory: root,
			hostId: 'host-revalidate',
			port,
			advertisedHost: '127.0.0.1',
			html: '<!doctype html>',
			mermaidScript: 'globalThis.mermaid = {};',
			retryIntervalMs: 25,
			readPairingSecret,
		};
		const leader = new GatewayCoordinator({ ...options, ownerId: 'window-1' });
		const follower = new GatewayCoordinator({ ...options, ownerId: 'window-2' });
		const blocker = http.createServer();
		try {
			assert.equal((await leader.start()).port, port);
			assert.equal((await follower.start()).port, port);
			await leader.stop();
			await new Promise<void>((resolve, reject) => {
				blocker.once('error', reject);
				blocker.listen(port, '0.0.0.0', resolve);
			});
			await waitFor(() => follower.isLeader, 2_000);
			const current = await follower.resolveAddress();
			assert.notEqual(current.port, port);
			assert.equal((await fetch(`http://127.0.0.1:${current.port}/api/health`)).status, 200);
		} finally {
			await leader.stop();
			await follower.stop();
			if (blocker.listening) {
				await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
			}
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

async function findFreePort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for gateway failover.');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}