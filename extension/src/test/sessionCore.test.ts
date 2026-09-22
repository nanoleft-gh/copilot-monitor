import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SessionCore } from '../sessionCore';
import { sessionIndexStorageKey } from '../sessionIndex';
import { localSessionResource } from '../sessionResource';

const sessionA = 'aaaaaaaa-0000-4000-8000-000000000001';
const sessionB = 'bbbbbbbb-0000-4000-8000-000000000002';
const base = 1_800_000_000_000;

interface Fixture {
	root: string;
	sessions: string;
	transcripts: string;
	debugLogs: string;
	database: string;
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-core-'));
	const sessions = path.join(root, 'chatSessions');
	const copilot = path.join(root, 'GitHub.copilot-chat');
	const transcripts = path.join(copilot, 'transcripts');
	const debugLogs = path.join(copilot, 'debug-logs');
	await fs.mkdir(sessions, { recursive: true });
	await fs.mkdir(transcripts, { recursive: true });
	await fs.mkdir(debugLogs, { recursive: true });
	return { root, sessions, transcripts, debugLogs, database: path.join(root, 'state.vscdb') };
}

function writeIndex(fixture: Fixture, entries: Record<string, unknown>): void {
	const database = new DatabaseSync(fixture.database);
	try {
		database.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
		database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(sessionIndexStorageKey, JSON.stringify({ version: 1, entries }));
	} finally {
		database.close();
	}
}

function indexEntry(sessionId: string, title: string, lastMessageDate: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { sessionId, title, lastMessageDate, lastResponseState: 1, permissionLevel: 'default', ...extra };
}

function request(index: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { requestId: `request-${index}`, timestamp: base + index * 1000, message: { text, parts: [] }, modelId: 'copilot/gpt-5', response: [], ...extra };
}

function initialLine(sessionId: string, requests: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ kind: 0, v: { version: 3, sessionId, creationDate: base, inputState: { selectedModel: { identifier: 'copilot/gpt-5', metadata: { name: 'GPT-5' } }, permissionLevel: 'default' }, requests, ...extra } }) + '\n';
}

function transcriptLine(type: string, data: Record<string, unknown>, at: number): string {
	return JSON.stringify({ type, data, id: `${type}-${at}`, timestamp: new Date(at).toISOString(), parentId: null }) + '\n';
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for the core to update.');
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

describe('SessionCore', () => {
	let fixture: Fixture;
	const cores: SessionCore[] = [];

	function createCore(now?: () => number): SessionCore {
		const core = new SessionCore({
			paths: {
				sessionDirectories: [fixture.sessions],
				transcriptDirectories: [fixture.transcripts],
				debugLogDirectories: [fixture.debugLogs],
				indexDatabasePath: fixture.database,
			},
			fileDebounceMs: 10,
			indexDebounceMs: 20,
			activityWindowMs: 300,
			retainedTurns: 5,
			now,
		});
		cores.push(core);
		return core;
	}

	beforeEach(async () => {
		fixture = await createFixture();
	});

	afterEach(async () => {
		for (const core of cores.splice(0)) {
			core.dispose();
		}
		await fs.rm(fixture.root, { recursive: true, force: true });
	});

	it('does no work and holds no state until a viewer connects', async () => {
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'hello')]));
		const core = createCore();
		assert.deepEqual(core.getState().sessions, []);
		await core.setViewerCount(1);
		assert.equal(core.getState().sessions.length, 1);
		await core.setViewerCount(0);
		assert.equal(core.viewers, 0);
	});

	it('lists sessions from the index with metadata only, newest first, and reads turns only for the selected one', async () => {
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'question A'), request(1, 'second A')], { customTitle: 'Projected A' }));
		await fs.writeFile(path.join(fixture.sessions, `${sessionB}.jsonl`), initialLine(sessionB, [request(0, 'question B')]));
		writeIndex(fixture, {
			[sessionA]: indexEntry(sessionA, 'Index title A', base + 10_000, { permissionLevel: 'autoApprove' }),
			[sessionB]: indexEntry(sessionB, 'Index title B', base + 20_000),
		});
		const core = createCore();
		await core.setViewerCount(1);
		const state = core.getState();
		assert.deepEqual(state.sessions.map(session => session.sessionId), [sessionB, sessionA]);
		// Newest session is selected automatically and carries turns; the other is metadata only.
		assert.equal(state.activeSessionResource, localSessionResource(sessionB));
		const [active, other] = state.sessions;
		assert.equal(active.title, 'Index title B');
		assert.equal(active.turns.length, 1);
		assert.equal(active.turns[0].userText, 'question B');
		assert.equal(active.turnCount, 1);
		assert.equal(active.model?.selectedModelId, 'copilot/gpt-5');
		assert.deepEqual(other.turns, []);
		assert.equal(other.title, 'Index title A');
		assert.equal(other.permissionLevel, 'autoApprove');
		assert.equal(other.status, 'idle');

		await core.selectSession(sessionA);
		const selected = core.getState().sessions.find(session => session.sessionId === sessionA)!;
		assert.equal(selected.title, 'Projected A');
		assert.equal(selected.turns.length, 2);
		assert.equal(core.requestIndexOf(sessionA, 'request-1'), 1);
		assert.deepEqual(core.getState().sessions.find(session => session.sessionId === sessionB)!.turns, []);
	});

	it('derives a title from the file head when the index does not know the session yet', async () => {
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'What is the meaning of this stack trace?')]));
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionB);
		const summary = core.getState().sessions[0];
		assert.equal(summary.title, 'What is the meaning of this stack trace?');
		assert.equal(summary.isEmpty, false);
	});

	it('reports empty chats and does not auto-select one over a chat with content', async () => {
		const sessionC = 'cccccccc-0000-4000-8000-000000000003';
		// A is a blank chat VS Code indexed; B has content; C is a brand-new blank chat not indexed yet.
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, []));
		await fs.writeFile(path.join(fixture.sessions, `${sessionB}.jsonl`), initialLine(sessionB, [request(0, 'real question')]));
		await fs.writeFile(path.join(fixture.sessions, `${sessionC}.jsonl`), initialLine(sessionC, []));
		writeIndex(fixture, {
			[sessionA]: indexEntry(sessionA, 'New Chat', base + 30_000, { isEmpty: true }),
			[sessionB]: indexEntry(sessionB, 'Real', base + 20_000, { isEmpty: false }),
		});
		const core = createCore();
		await core.setViewerCount(1);
		const state = core.getState();
		assert.equal(state.activeSessionResource, localSessionResource(sessionB), 'newest non-empty chat is selected');
		const byId = new Map(state.sessions.map(session => [session.sessionId, session]));
		assert.equal(byId.get(sessionA)?.isEmpty, true);
		assert.equal(byId.get(sessionA)?.turnCount, 0);
		assert.equal(byId.get(sessionB)?.isEmpty, false);
		assert.equal(byId.get(sessionB)?.turnCount, 1);
		assert.equal(byId.get(sessionC)?.isEmpty, true, 'unindexed blank chat is detected from its log head');

		// The blank chat receives its first request: the projection knows before the index does.
		await core.selectSession(sessionA);
		assert.equal(core.getState().sessions.find(session => session.sessionId === sessionA)?.isEmpty, true);
		await fs.appendFile(path.join(fixture.sessions, `${sessionA}.jsonl`), JSON.stringify({ kind: 2, k: ['requests'], v: [request(0, 'now it has content', { modelState: { value: 1 } })], i: 0 }) + '\n');
		await waitFor(() => core.getState().sessions.find(session => session.sessionId === sessionA)?.isEmpty === false);
		assert.equal(core.getState().sessions.find(session => session.sessionId === sessionA)?.turnCount, 1);
	});

	it('follows appended mutations and transcript progress through file events', async () => {
		const sessionPath = path.join(fixture.sessions, `${sessionA}.jsonl`);
		await fs.writeFile(sessionPath, initialLine(sessionA, [request(0, 'first', { modelState: { value: 1 } })]));
		const core = createCore();
		let changes = 0;
		core.onDidChange(() => changes++);
		await core.setViewerCount(1);
		await core.selectSession(sessionA);

		await fs.appendFile(sessionPath, JSON.stringify({ kind: 2, k: ['requests'], v: [request(1, 'second')] }) + '\n');
		await waitFor(() => core.getState().sessions[0].turns.length === 2);
		assert.equal(core.getState().sessions[0].turns[1].status, 'working');

		// Copilot flushes its transcript before the mutation log catches up: the live overlay shows progress.
		const transcriptPath = path.join(fixture.transcripts, `${sessionA}.jsonl`);
		const now = base + 1000;
		await fs.writeFile(transcriptPath,
			transcriptLine('user.message', { content: 'first' }, base)
			+ transcriptLine('user.message', { content: 'second' }, now)
			+ transcriptLine('assistant.turn_start', { turnId: '0' }, now + 1)
			+ transcriptLine('assistant.message', { content: 'Working on it', toolRequests: [{ toolCallId: 'c1', name: 'read_file', arguments: '{}' }] }, now + 2)
			+ transcriptLine('assistant.turn_end', { turnId: '0' }, now + 3));
		await waitFor(() => core.getState().sessions[0].turns[1]?.assistantText === 'Working on it');
		const turn = core.getState().sessions[0].turns[1];
		assert.deepEqual(turn.activities.map(activity => [activity.toolId, activity.status]), [['read_file', 'running']]);
		assert.equal(core.getState().sessions[0].status, 'working');

		// The final answer arrives in the transcript, then VS Code persists the sealed request.
		await fs.appendFile(transcriptPath,
			transcriptLine('assistant.turn_start', { turnId: '1' }, now + 4)
			+ transcriptLine('tool.execution_start', { toolCallId: 'c1', toolName: 'read_file', arguments: {} }, now + 5)
			+ transcriptLine('tool.execution_complete', { toolCallId: 'c1', success: true }, now + 6)
			+ transcriptLine('assistant.message', { content: 'Working on it\n\nAll done.', toolRequests: [] }, now + 7)
			+ transcriptLine('assistant.turn_end', { turnId: '1' }, now + 8));
		await waitFor(() => core.getState().sessions[0].turns[1]?.status === 'completed');
		await fs.appendFile(sessionPath,
			JSON.stringify({ kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'All done.' }] }) + '\n'
			+ JSON.stringify({ kind: 1, k: ['requests', 1, 'modelState'], v: { value: 1, completedAt: now + 9 } }) + '\n');
		await waitFor(() => core.getState().sessions[0].turns[1]?.completedAt === now + 9);
		assert.ok(changes > 0);
		assert.equal(core.getState().sessions[0].status, 'idle');
	});

	it('marks a non-selected session as working while its transcript is being written, then idle again', async () => {
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'a')]));
		await fs.writeFile(path.join(fixture.sessions, `${sessionB}.jsonl`), initialLine(sessionB, [request(0, 'b')]));
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionA);
		await fs.writeFile(path.join(fixture.transcripts, `${sessionB}.jsonl`), transcriptLine('user.message', { content: 'b' }, base));
		await waitFor(() => core.getState().sessions.find(session => session.sessionId === sessionB)?.status === 'working');
		await waitFor(() => core.getState().sessions.find(session => session.sessionId === sessionB)?.status === 'idle', 3_000);
	});

	it('does not report a finished chat as working just because it was opened and then left', async () => {
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'a', { modelState: { value: 1, completedAt: base + 5 } })]));
		await fs.writeFile(path.join(fixture.sessions, `${sessionB}.jsonl`), initialLine(sessionB, [request(0, 'b', { modelState: { value: 1, completedAt: base + 5 } })]));
		// A has an old, complete transcript on disk; replaying it on attach is not activity.
		await fs.writeFile(path.join(fixture.transcripts, `${sessionA}.jsonl`),
			transcriptLine('user.message', { content: 'a' }, base)
			+ transcriptLine('assistant.turn_start', { turnId: '0' }, base + 1)
			+ transcriptLine('assistant.message', { content: 'done', toolRequests: [] }, base + 2)
			+ transcriptLine('assistant.turn_end', { turnId: '0' }, base + 3));
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionA);
		assert.equal(core.getState().sessions.find(session => session.sessionId === sessionA)?.status, 'idle');
		await core.selectSession(sessionB);
		assert.equal(core.getState().sessions.find(session => session.sessionId === sessionA)?.status, 'idle');
		await core.selectSession(sessionA);
		assert.equal(core.getState().sessions.find(session => session.sessionId === sessionA)?.status, 'idle');
	});

	it('picks up the index appearing later and new/removed session files', async () => {
		const core = createCore();
		await core.setViewerCount(1);
		assert.deepEqual(core.getState().sessions, []);

		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, [request(0, 'new chat')]));
		await waitFor(() => core.getState().sessions.length === 1);
		// The create and the write may arrive as separate events; the title converges after the write.
		await waitFor(() => core.getState().sessions[0].title === 'new chat');

		writeIndex(fixture, { [sessionA]: indexEntry(sessionA, 'Titled by index', base) });
		await waitFor(() => core.getState().sessions[0].title === 'Titled by index');

		await fs.rm(path.join(fixture.sessions, `${sessionA}.jsonl`));
		await waitFor(() => core.getState().sessions.length === 0);
	});

	it('pages persisted history from the projection and reports oversized logs', async () => {
		const requests = Array.from({ length: 12 }, (_, index) => request(index, `q${index}`, { response: [{ value: `a${index}` }], modelState: { value: 1 } }));
		await fs.writeFile(path.join(fixture.sessions, `${sessionA}.jsonl`), initialLine(sessionA, requests));
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionA);
		const active = core.getState().sessions[0];
		assert.equal(active.turns.length, 5);
		assert.equal(active.historyStart, 7);
		assert.equal(active.turnCount, 12);
		assert.equal(active.historyTruncated, true);
		const page = core.historyPage(sessionA, 7, 4)!;
		assert.deepEqual(page.turns.map(turn => turn.userText), ['q3', 'q4', 'q5', 'q6']);
		assert.equal(page.hasEarlier, true);
		assert.equal(core.historyPage(sessionB, 7, 4), undefined);
	});

	it('survives a compaction rewrite of the session log', async () => {
		const sessionPath = path.join(fixture.sessions, `${sessionA}.jsonl`);
		await fs.writeFile(sessionPath, initialLine(sessionA, [request(0, 'a')]) + JSON.stringify({ kind: 2, k: ['requests'], v: [request(1, 'b')] }) + '\n');
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionA);
		assert.equal(core.getState().sessions[0].turns.length, 2);
		// VS Code replaces the whole file with a fresh Initial entry after enough mutations.
		await fs.writeFile(sessionPath, initialLine(sessionA, [request(0, 'a'), request(1, 'b'), request(2, 'c')], { customTitle: 'Compacted' }));
		await waitFor(() => core.getState().sessions[0].turns.length === 3);
		assert.equal(core.getState().sessions[0].title, 'Compacted');
	});

	it('tears everything down when the last viewer leaves and rebuilds on return', async () => {
		const sessionPath = path.join(fixture.sessions, `${sessionA}.jsonl`);
		await fs.writeFile(sessionPath, initialLine(sessionA, [request(0, 'a')]));
		const core = createCore();
		await core.setViewerCount(1);
		await core.selectSession(sessionA);
		await core.setViewerCount(0);
		await fs.appendFile(sessionPath, JSON.stringify({ kind: 2, k: ['requests'], v: [request(1, 'b')] }) + '\n');
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepEqual(core.getState().sessions[0].turns, [], 'nothing is held while nobody watches');
		await core.setViewerCount(1);
		assert.equal(core.getState().sessions[0].turns.length, 2);
	});
});
