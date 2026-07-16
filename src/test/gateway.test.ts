import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { GatewayBackend, GatewayServer } from '../gatewayServer';
import { GatewayCoordinator } from '../gatewayCoordinator';
import { GatewayCreateSessionRequest, GatewayModelConfigurationRequest, GatewayModelSelectionRequest, GatewayPermissionLevelRequest, GatewayRenameSessionRequest, GatewaySelectSessionRequest, GatewaySendMessageRequest, GatewayState, GatewayToolDecisionRequest } from '../protocol';

const emptyState: GatewayState = { version: 2, gatewayStartedAt: 1, windows: [] };

class TestGatewayBackend implements GatewayBackend {
	messages: GatewaySendMessageRequest[] = [];
	selections: GatewaySelectSessionRequest[] = [];
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

	async selectSession(request: GatewaySelectSessionRequest): Promise<void> {
		this.selections.push(request);
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
		});
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;
		try {
			const health = await fetch(`${baseUrl}/api/health`).then(response => response.json());
			assert.deepEqual(health, {
				service: 'githubcopilot-monitor-gateway', registryId: 'registry-1', apiVersion: 3,
				capabilities: ['sessionRename', 'sessionCreate', 'sessionPermission'],
			});
			const page = await fetch(`${baseUrl}/`);
			assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' 'unsafe-inline'/);
			assert.deepEqual(await fetch(`${baseUrl}/api/state`).then(response => response.json()), emptyState);
			const mermaid = await fetch(`${baseUrl}/assets/mermaid.min.js`);
			assert.equal(mermaid.status, 200);
			assert.match(mermaid.headers.get('content-type') ?? '', /text\/javascript/);
			assert.equal(await mermaid.text(), 'globalThis.mermaid = {};');
			assert.equal(await fetch(`${baseUrl}/assets/icon.svg`).then(response => response.text()), '<svg/>');
			const abortController = new AbortController();
			const events = await fetch(`${baseUrl}/api/events`, { signal: abortController.signal });
			assert.equal(events.status, 200);
			assert.equal(backend.clientCounts.at(-1), 1);
			abortController.abort();

			const message = { windowId: 'w2', id: 'm1', sessionResource: 's2', text: 'Hello' };
			assert.equal((await fetch(`${baseUrl}/api/messages`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
			})).status, 202);
			assert.deepEqual(backend.messages, [message]);

			const selection = { windowId: 'w1', sessionResource: 's1' };
			assert.equal((await fetch(`${baseUrl}/api/sessions/select`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection),
			})).status, 204);
			assert.deepEqual(backend.selections, [selection]);

			const decision = { windowId: 'w1', sessionResource: 's1', requestId: 'r1', toolCallId: 't1', decision: 'allow' };
			assert.equal((await fetch(`${baseUrl}/api/tools/decision`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(decision),
			})).status, 204);
			assert.deepEqual(backend.toolDecisions, [decision]);

			const modelSelection = { windowId: 'w1', sessionResource: 's1', modelId: 'copilot/gpt-test' };
			assert.equal((await fetch(`${baseUrl}/api/models/select`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modelSelection),
			})).status, 204);
			assert.deepEqual(backend.modelSelections, [modelSelection]);

			const modelConfiguration = {
				windowId: 'w2', sessionResource: 's2', modelId: 'copilot/gpt-test', key: 'contextSize', value: 922000,
			};
			assert.equal((await fetch(`${baseUrl}/api/models/configure`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modelConfiguration),
			})).status, 204);
			assert.deepEqual(backend.modelConfigurations, [modelConfiguration]);

			const rename = { windowId: 'w1', sessionResource: 's1', title: 'Renamed' };
			assert.equal((await fetch(`${baseUrl}/api/sessions/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rename) })).status, 204);
			assert.deepEqual(backend.renames, [rename]);
			const created = { windowId: 'w2', sourceSessionResource: 's2' };
			const createdResponse = await fetch(`${baseUrl}/api/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(created) });
			assert.equal(createdResponse.status, 201);
			assert.deepEqual(await createdResponse.json(), { sessionResource: 'new-session' });
			assert.deepEqual(backend.created, [created]);
			const permission = { windowId: 'w1', sessionResource: 's1', permissionLevel: 'autopilot' } as const;
			assert.equal((await fetch(`${baseUrl}/api/sessions/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(permission) })).status, 204);
			assert.deepEqual(backend.permissions, [permission]);
		} finally {
			await server.stop();
		}
	});
});

describe('GatewayCoordinator', () => {
	it('elects one port owner and fails over on the same port', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-gateway-'));
		const port = await findFreePort();
		const options = {
			registryDirectory: root,
			registryId: 'registry-failover',
			port,
			advertisedHost: '127.0.0.1',
			html: '<!doctype html>',
			mermaidScript: 'globalThis.mermaid = {};',
			retryIntervalMs: 25,
		};
		const first = new GatewayCoordinator(options);
		const second = new GatewayCoordinator(options);
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