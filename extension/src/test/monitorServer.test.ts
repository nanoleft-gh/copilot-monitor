import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MonitorBackend, MonitorServer } from '../monitorServer';
import { CreateSessionRequest, EditTurnRequest, ModelConfigurationRequest, ModelSelectionRequest, MonitorRequestError, MonitorState, PermissionLevelRequest, RenameSessionRequest, SendMessageRequest, ToolDecisionRequest } from '../protocol';

const initialState: MonitorState = {
	version: 1,
	windowId: 'window-1',
	workspaceName: 'test-workspace',
	workspaceFolders: ['C:\\test-workspace'],
	startedAt: 1,
	models: [],
	sessions: [],
	outboundMessages: [],
};

class TestBackend implements MonitorBackend {
	state = initialState;
	requests: SendMessageRequest[] = [];
	edits: EditTurnRequest[] = [];
	selectedSessions: string[] = [];
	toolDecisions: ToolDecisionRequest[] = [];
	modelSelections: ModelSelectionRequest[] = [];
	modelConfigurations: ModelConfigurationRequest[] = [];
	renames: RenameSessionRequest[] = [];
	created: CreateSessionRequest[] = [];
	permissions: PermissionLevelRequest[] = [];
	eventClientCounts: number[] = [];
	private listener: ((state: MonitorState) => void) | undefined;

	getState(): MonitorState {
		return this.state;
	}

	onDidChange(listener: (state: MonitorState) => void): { dispose(): void } {
		this.listener = listener;
		return { dispose: () => this.listener = undefined };
	}

	async sendMessage(request: SendMessageRequest) {
		if (request.sessionResource === 'stale') {
			throw new MonitorRequestError(409, 'Stale session.');
		}
		this.requests.push(request);
		return { id: request.id, accepted: true as const };
	}
	async editTurn(request: EditTurnRequest) { this.edits.push(request); return { id: request.id, accepted: true as const }; }

	setEventClientCount(count: number): void {
		this.eventClientCounts.push(count);
	}

	async selectSession(sessionResource: string): Promise<void> {
		this.selectedSessions.push(sessionResource);
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

	emit(state: MonitorState): void {
		this.state = state;
		this.listener?.(state);
	}
}

describe('MonitorServer', () => {
	it('serves state, streams SSE, and routes messages without authentication', async () => {
		const backend = new TestBackend();
		const server = new MonitorServer(backend, {
			host: '127.0.0.1',
			port: 0,
			html: '<!doctype html><title>Monitor</title>',
			mermaidScript: 'globalThis.mermaid = {};',
			iconSvg: '<svg/>',
		});
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;

		try {
			const page = await fetch(`${baseUrl}/`);
			assert.equal(page.status, 200);
			assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' 'unsafe-inline'/);
			assert.match(await page.text(), /<title>Monitor<\/title>/);
			const mermaid = await fetch(`${baseUrl}/assets/mermaid.min.js`);
			assert.equal(mermaid.status, 200);
			assert.match(mermaid.headers.get('content-type') ?? '', /text\/javascript/);
			assert.equal(mermaid.headers.get('x-content-type-options'), 'nosniff');
			assert.equal(await mermaid.text(), 'globalThis.mermaid = {};');
			const icon = await fetch(`${baseUrl}/assets/icon.svg`);
			assert.match(icon.headers.get('content-type') ?? '', /image\/svg\+xml/);
			assert.equal(await icon.text(), '<svg/>');

			const stateResponse = await fetch(`${baseUrl}/api/state`);
			assert.deepEqual(await stateResponse.json(), initialState);

			const abortController = new AbortController();
			const events = await fetch(`${baseUrl}/api/events`, { signal: abortController.signal });
			const reader = events.body!.getReader();
			const firstEvent = new TextDecoder().decode((await reader.read()).value);
			assert.match(firstEvent, /event: state/);
			assert.match(firstEvent, /"windowId":"window-1"/);
			assert.equal(backend.eventClientCounts.at(-1), 1);
			backend.emit({ ...initialState, workspaceName: 'updated-workspace' });
			const updatedEvent = new TextDecoder().decode((await reader.read()).value);
			assert.match(updatedEvent, /"workspaceName":"updated-workspace"/);
			abortController.abort();

			const message = { id: 'message-1', sessionResource: 'session-1', text: 'Continue' };
			const messageResponse = await fetch(`${baseUrl}/api/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(message),
			});
			assert.equal(messageResponse.status, 202);
			assert.deepEqual(backend.requests, [message]);

			const edit = { id: 'edit-1', sessionResource: 'session-1', sessionRevision: 'revision-1', requestId: 'request-1', text: 'Edited' };
			const editResponse = await fetch(`${baseUrl}/api/turns/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
			assert.equal(editResponse.status, 202);
			assert.deepEqual(backend.edits, [edit]);

			const selectResponse = await fetch(`${baseUrl}/api/sessions/select`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionResource: 'session-2' }),
			});
			assert.equal(selectResponse.status, 204);
			assert.deepEqual(backend.selectedSessions, ['session-2']);

			const toolDecision = { sessionResource: 'session-2', requestId: 'request-2', toolCallId: 'tool-2', decision: 'allow' };
			const decisionResponse = await fetch(`${baseUrl}/api/tools/decision`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(toolDecision),
			});
			assert.equal(decisionResponse.status, 204);
			assert.deepEqual(backend.toolDecisions, [toolDecision]);

			const modelSelection = { sessionResource: 'session-2', modelId: 'copilot/gpt-test' };
			const modelResponse = await fetch(`${baseUrl}/api/models/select`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(modelSelection),
			});
			assert.equal(modelResponse.status, 204);
			assert.deepEqual(backend.modelSelections, [modelSelection]);

			const modelConfiguration = {
				sessionResource: 'session-2', modelId: 'copilot/gpt-test', key: 'reasoningEffort', value: 'max',
			};
			const modelConfigurationResponse = await fetch(`${baseUrl}/api/models/configure`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(modelConfiguration),
			});
			assert.equal(modelConfigurationResponse.status, 204);
			assert.deepEqual(backend.modelConfigurations, [modelConfiguration]);

			assert.equal((await fetch(`${baseUrl}/api/sessions/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionResource: 'session-2', title: 'Renamed' }) })).status, 204);
			assert.deepEqual(backend.renames, [{ sessionResource: 'session-2', title: 'Renamed' }]);
			const newResponse = await fetch(`${baseUrl}/api/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceSessionResource: 'session-2' }) });
			assert.equal(newResponse.status, 201);
			assert.deepEqual(await newResponse.json(), { sessionResource: 'new-session' });
			assert.equal((await fetch(`${baseUrl}/api/sessions/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionResource: 'session-2', permissionLevel: 'autopilot' }) })).status, 204);
			assert.deepEqual(backend.permissions, [{ sessionResource: 'session-2', permissionLevel: 'autopilot' }]);

			const staleResponse = await fetch(`${baseUrl}/api/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...message, sessionResource: 'stale' }),
			});
			assert.equal(staleResponse.status, 409);
			assert.deepEqual(await staleResponse.json(), { error: 'Stale session.' });
		} finally {
			await server.stop();
		}
	});
});