import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { indexProgressiveTranscript, loadProgressiveTranscriptPage } from '../progressiveTranscript';

describe('progressive transcript', () => {
	it('indexes real titles and loads bounded pages by turn offset', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-progressive-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			const lines = [
				event('session.start', { sessionId: 'session-1' }, 'start', 0),
				event('user.message', { content: 'First real prompt' }, 'u1', 1),
				event('assistant.message', { content: 'First answer' }, 'a1', 2),
				event('assistant.turn_end', {}, 'e1', 3),
				event('user.message', { content: 'Second prompt' }, 'u2', 4),
				event('assistant.message', { content: 'Second answer' }, 'a2', 5),
				event('assistant.turn_end', {}, 'e2', 6),
				event('user.message', { content: 'Third prompt' }, 'u3', 7),
				event('assistant.message', { content: 'Third answer' }, 'a3', 8),
				event('assistant.turn_end', {}, 'e3', 9),
			];
			await fs.writeFile(filePath, `${lines.join('\n')}\n`);
			const index = await indexProgressiveTranscript(filePath);
			assert.equal(index.title, 'First real prompt');
			assert.equal(index.sessionId, 'session-1');
			assert.equal(index.turnOffsets.length, 3);
			const page = await loadProgressiveTranscriptPage(index, 1, 2);
			assert.deepEqual(page.turns.map(turn => [turn.id, turn.userText, turn.assistantText]), [
				['u2', 'Second prompt', 'Second answer'],
				['u3', 'Third prompt', 'Third answer'],
			]);
			assert.equal(page.hasEarlier, true);
			assert.equal(page.totalCount, 3);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('collapses duplicate replayed prompts and completes a turn when the next begins', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-progressive-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			await fs.writeFile(filePath, `${[
				event('user.message', { content: 'Repeated prompt' }, 'u1', 1),
				event('user.message', { content: 'Repeated prompt' }, 'u2', 2),
				event('assistant.message', { content: 'Answer' }, 'a2', 3),
				event('user.message', { content: 'Next prompt' }, 'u3', 4),
			].join('\n')}\n`);
			const index = await indexProgressiveTranscript(filePath);
			assert.equal(index.turnOffsets.length, 2);
			const page = await loadProgressiveTranscriptPage(index, 0, 40);
			assert.deepEqual(page.turns.map(turn => [turn.id, turn.status, turn.assistantText]), [
				['u2', 'completed', 'Answer'],
				['u3', 'working', ''],
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reports a partial page boundary when the byte budget is reached', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-progressive-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			await fs.writeFile(filePath, `${[
				event('user.message', { content: 'First prompt' }, 'u1', 1),
				event('assistant.message', { content: 'x'.repeat(500) }, 'a1', 2),
				event('user.message', { content: 'Second prompt' }, 'u2', 3),
				event('assistant.message', { content: 'Second answer' }, 'a2', 4),
			].join('\n')}\n`);
			const index = await indexProgressiveTranscript(filePath);
			const firstPage = await loadProgressiveTranscriptPage(index, 0, 40, 180);
			assert.equal(firstPage.start, 0);
			assert.equal(firstPage.end, 1);
			const nextPage = await loadProgressiveTranscriptPage(index, firstPage.end, 40);
			assert.equal(nextPage.turns[0].userText, 'Second prompt');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

function event(type: string, data: unknown, id: string, second: number): string {
	return JSON.stringify({ type, data, id, timestamp: new Date(second * 1000).toISOString() });
}