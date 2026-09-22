import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MonitorBackend, MonitorServer } from '../monitorServer';
import { CreateSessionRequest, EditTurnRequest, ModelConfigurationRequest, ModelSelectionRequest, MonitorRequestError, MonitorState, PermissionLevelRequest, RenameSessionRequest, SendMessageRequest, ToolDecisionRequest } from '../protocol';
import { applyPatch } from '../stateDelta';

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
			const newResponse = await fetch(`${baseUrl}/api/sessions/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'new-1', sourceSessionResource: 'session-2' }) });
			assert.equal(newResponse.status, 201);
			assert.deepEqual(await newResponse.json(), { sessionResource: 'new-session' });
			assert.deepEqual(backend.created, [{ id: 'new-1', sourceSessionResource: 'session-2' }]);
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

	it('streams a snapshot followed by patches on /api/events?v=2 and skips no-op emits', async () => {
		const backend = new TestBackend();
		const server = new MonitorServer(backend, { host: '127.0.0.1', port: 0 });
		const address = await server.start();
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const abortController = new AbortController();
		try {
			const health = await fetch(`${baseUrl}/api/health`).then(response => response.json()) as { capabilities: string[] };
			assert.ok(health.capabilities.includes('eventsV2'));

			const events = await fetch(`${baseUrl}/api/events?v=2`, { signal: abortController.signal });
			const frames = sseFrames(events.body!.getReader());
			const snapshot = await frames.next();
			assert.equal(snapshot.event, 'snapshot');
			assert.equal(snapshot.id, '1');
			assert.deepEqual(JSON.parse(snapshot.data), initialState);
			assert.equal(backend.eventClientCounts.at(-1), 1);

			// Same content, different object: nothing is sent.
			backend.emit({ ...initialState });
			const session = {
				resource: 's1', sessionId: 's1', title: 'Chat', status: 'working' as const, revision: 'r1', permissionLevel: 'default' as const,
				turns: [{ id: 't1', editable: false, timestamp: 1, userText: 'Hi', thinking: '', thinkingTitle: '', assistantText: 'Hel', activities: [], blocks: [], status: 'working' as const }],
			};
			backend.emit({ ...initialState, sessions: [session], activeSessionResource: 's1' });
			const first = await frames.next();
			assert.equal(first.event, 'patch');
			assert.equal(first.id, '2');
			let mirrored = applyPatch(initialState, JSON.parse(first.data));
			assert.deepEqual(mirrored, backend.state);

			// Streaming text arrives as an append, not a resend.
			backend.emit({ ...backend.state, sessions: [{ ...session, turns: [{ ...session.turns[0], assistantText: 'Hello, world' }] }] });
			const second = await frames.next();
			assert.equal(second.event, 'patch');
			assert.match(second.data, /\["\+","lo, world"\]/);
			assert.doesNotMatch(second.data, /"userText"/);
			mirrored = applyPatch(mirrored, JSON.parse(second.data));
			assert.deepEqual(mirrored, backend.state);

			// A v1 client on the same server still gets full states.
			const legacy = await fetch(`${baseUrl}/api/events`, { signal: abortController.signal });
			const legacyFrames = sseFrames(legacy.body!.getReader());
			const legacyFirst = await legacyFrames.next();
			assert.equal(legacyFirst.event, 'state');
			assert.deepEqual(JSON.parse(legacyFirst.data), backend.state);
			assert.equal(backend.eventClientCounts.at(-1), 2);
		} finally {
			abortController.abort();
			await server.stop();
		}
	});
});

interface SseFrame { event: string; id?: string; data: string }

/** Minimal SSE parser over a fetch body reader. */
function sseFrames(reader: ReadableStreamDefaultReader<Uint8Array>): { next(): Promise<SseFrame> } {
	const decoder = new TextDecoder();
	let buffer = '';
	const queue: SseFrame[] = [];
	return {
		async next() {
			while (queue.length === 0) {
				const { value, done } = await reader.read();
				if (done) {
					throw new Error('stream ended');
				}
				buffer += decoder.decode(value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf('\n\n')) >= 0) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					if (raw.startsWith(':')) {
						continue;
					}
					const lines = raw.split('\n');
					queue.push({
						event: lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'message',
						id: lines.find(line => line.startsWith('id: '))?.slice(4),
						data: lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'),
					});
				}
			}
			return queue.shift()!;
		},
	};
}