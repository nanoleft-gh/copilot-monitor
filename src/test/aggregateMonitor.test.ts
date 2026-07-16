import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AggregateMonitor } from '../aggregateMonitor';
import { MonitorBackend, MonitorServer } from '../monitorServer';
import { CreateSessionRequest, ModelConfigurationRequest, ModelSelectionRequest, MonitorState, PermissionLevelRequest, RenameSessionRequest, SendMessageRequest, ToolDecisionRequest } from '../protocol';
import { WindowRegistry } from '../windowRegistry';

class TestWindowBackend implements MonitorBackend {
	requests: SendMessageRequest[] = [];
	selected: string[] = [];
	toolDecisions: ToolDecisionRequest[] = [];
	modelSelections: ModelSelectionRequest[] = [];
	modelConfigurations: ModelConfigurationRequest[] = [];
	renames: RenameSessionRequest[] = [];
	created: CreateSessionRequest[] = [];
	permissions: PermissionLevelRequest[] = [];
	eventClientCounts: number[] = [];
	private readonly listeners = new Set<(state: MonitorState) => void>();

	constructor(readonly state: MonitorState) {}

	getState(): MonitorState {
		return this.state;
	}

	onDidChange(listener: (state: MonitorState) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async sendMessage(request: SendMessageRequest) {
		this.requests.push(request);
		return { id: request.id, accepted: true as const };
	}

	async selectSession(resource: string): Promise<void> {
		this.selected.push(resource);
	}

	setEventClientCount(count: number): void {
		this.eventClientCounts.push(count);
	}

	async decideTool(request: ToolDecisionRequest): Promise<void> {
		this.toolDecisions.push(request);
	}

	async selectModel(request: ModelSelectionRequest): Promise<void> {
		this.modelSelections.push(request);
	}

	async configureModel(request: ModelConfigurationRequest): Promise<void> {
		this.modelConfigurations.push(request);
	}
	async renameSession(request: RenameSessionRequest): Promise<void> { this.renames.push(request); }
	async createSession(request: CreateSessionRequest) { this.created.push(request); return { sessionResource: 'new-session' }; }
	async setPermissionLevel(request: PermissionLevelRequest): Promise<void> { this.permissions.push(request); }
}

describe('AggregateMonitor', () => {
	it('aggregates two windows and routes commands by exact window id', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-aggregate-'));
		const firstBackend = new TestWindowBackend(createState('window-1', 'Workspace One'));
		const secondBackend = new TestWindowBackend(createState('window-2', 'Workspace Two'));
		const firstServer = new MonitorServer(firstBackend, { host: '127.0.0.1', port: 0 });
		const secondServer = new MonitorServer(secondBackend, { host: '127.0.0.1', port: 0 });
		const firstRegistry = new WindowRegistry(root, 'window-1');
		const secondRegistry = new WindowRegistry(root, 'window-2');
		const aggregate = new AggregateMonitor(root, 25);

		try {
			const firstAddress = await firstServer.start();
			const secondAddress = await secondServer.start();
			await firstRegistry.start(descriptor(firstAddress.port, 'Workspace One', 1));
			await secondRegistry.start(descriptor(secondAddress.port, 'Workspace Two', 2));
			await aggregate.start();

			await waitFor(() => aggregate.getState().windows.every(window => window.connected), 2_000);
			assert.equal(firstBackend.eventClientCounts.at(-1), 0);
			assert.equal(secondBackend.eventClientCounts.at(-1), 0);
			aggregate.setEventClientCount(2);
			await waitFor(() => firstBackend.eventClientCounts.at(-1) === 2 && secondBackend.eventClientCounts.at(-1) === 2, 2_000);
			assert.deepEqual(
				aggregate.getState().windows.map(window => [window.windowId, window.workspaceName]),
				[['window-1', 'Workspace One'], ['window-2', 'Workspace Two']],
			);

			await aggregate.sendMessage({ windowId: 'window-2', id: 'm1', sessionResource: 'session-2', text: 'Hello' });
			assert.equal(firstBackend.requests.length, 0);
			assert.deepEqual(secondBackend.requests, [{ id: 'm1', sessionResource: 'session-2', text: 'Hello' }]);

			await aggregate.selectSession({ windowId: 'window-1', sessionResource: 'session-1' });
			assert.deepEqual(firstBackend.selected, ['session-1']);
			assert.equal(secondBackend.selected.length, 0);

			await aggregate.decideTool({
				windowId: 'window-2',
				sessionResource: 'session-2',
				requestId: 'request-2',
				toolCallId: 'call-2',
				decision: 'skip',
			});
			assert.equal(firstBackend.toolDecisions.length, 0);
			assert.deepEqual(secondBackend.toolDecisions, [{
				sessionResource: 'session-2', requestId: 'request-2', toolCallId: 'call-2', decision: 'skip',
			}]);

			await aggregate.selectModel({ windowId: 'window-1', sessionResource: 'session-1', modelId: 'copilot/gpt-test' });
			assert.deepEqual(firstBackend.modelSelections, [{ sessionResource: 'session-1', modelId: 'copilot/gpt-test' }]);
			assert.equal(secondBackend.modelSelections.length, 0);

			await aggregate.configureModel({
				windowId: 'window-2', sessionResource: 'session-2', modelId: 'copilot/gpt-test', key: 'contextSize', value: 922000,
			});
			assert.equal(firstBackend.modelConfigurations.length, 0);
			assert.deepEqual(secondBackend.modelConfigurations, [{
				sessionResource: 'session-2', modelId: 'copilot/gpt-test', key: 'contextSize', value: 922000,
			}]);

			await aggregate.renameSession({ windowId: 'window-1', sessionResource: 'session-1', title: 'Renamed' });
			assert.deepEqual(firstBackend.renames, [{ sessionResource: 'session-1', title: 'Renamed' }]);
			assert.deepEqual(await aggregate.createSession({ windowId: 'window-2', sourceSessionResource: 'session-2' }), { sessionResource: 'new-session' });
			assert.deepEqual(secondBackend.created, [{ sourceSessionResource: 'session-2' }]);
			await aggregate.setPermissionLevel({ windowId: 'window-1', sessionResource: 'session-1', permissionLevel: 'autoApprove' });
			assert.deepEqual(firstBackend.permissions, [{ sessionResource: 'session-1', permissionLevel: 'autoApprove' }]);

			await secondRegistry.stop();
			await waitFor(() => aggregate.getState().windows.length === 1, 2_000);
			assert.equal(aggregate.getState().windows[0].windowId, 'window-1');
		} finally {
			aggregate.dispose();
			await firstRegistry.stop();
			await secondRegistry.stop();
			await firstServer.stop();
			await secondServer.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function createState(windowId: string, workspaceName: string): MonitorState {
	return {
		version: 1,
		windowId,
		workspaceName,
		workspaceFolders: [`C:\\code\\${windowId}`],
		startedAt: windowId === 'window-1' ? 1 : 2,
		models: [],
		sessions: [],
		outboundMessages: [],
	};
}

function descriptor(localPort: number, workspaceName: string, startedAt: number) {
	return {
		localPort,
		workspaceName,
		workspaceFolders: [`C:\\code\\${workspaceName}`],
		startedAt,
		pid: process.pid,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for aggregate state.');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}