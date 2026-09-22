import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { indexPagedMutationHistory, loadPagedMutationHistory } from '../pagedMutationHistory';
import { indexPagedMutationHistoryInWorker, loadPagedMutationHistoryInWorker } from '../pagedMutationHistoryWorkerClient';

describe('paged mutation history', () => {
	it('replays truncation and discards giant result fields', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-paged-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			const request = (id: string, text: string) => ({ requestId: id, timestamp: 1, message: { text }, response: [], modelState: { value: 0 }, result: { giant: 'x'.repeat(2 * 1024 * 1024) } });
			await fs.writeFile(filePath, `${[
				JSON.stringify({ kind: 0, v: { sessionId: 'session-1', requests: [] } }),
				JSON.stringify({ kind: 2, k: ['requests'], i: 5, v: [request('old', 'Old branch')] }),
				JSON.stringify({ kind: 2, k: ['requests'], i: 2, v: [request('new', 'New branch')] }),
				JSON.stringify({ kind: 2, k: ['requests', 2, 'response'], v: [{ value: 'New answer' }] }),
				JSON.stringify({ kind: 1, k: ['requests', 2, 'modelState'], v: { value: 1, completedAt: 2 } }),
			].join('\n')}\n`);
			const index = await indexPagedMutationHistory(filePath);
			assert.deepEqual(index.requests.map(value => (value.message as { text: string }).text), ['New branch']);
			const page = await loadPagedMutationHistory(index, 0, 40, 'revision');
			assert.equal(page.turns[0].assistantText, 'New answer');
			assert.equal(page.turns[0].status, 'completed');
			assert.equal(JSON.stringify(index).includes('x'.repeat(100)), false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('sanitizes requests from a giant initial snapshot', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-paged-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			await fs.writeFile(filePath, `${JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'session-initial',
					customTitle: 'Real title',
					requests: [{
						requestId: 'initial-request',
						timestamp: 10,
						message: { text: 'Initial prompt' },
						response: [{ value: 'Initial answer' }],
						modelState: { value: 1, completedAt: 11 },
						result: { giant: 'x'.repeat(2 * 1024 * 1024) },
					}],
				},
			})}\n`);
			const index = await indexPagedMutationHistory(filePath);
			assert.equal(index.title, 'Real title');
			assert.equal(JSON.stringify(index).includes('x'.repeat(100)), false);
			const page = await loadPagedMutationHistory(index, 0, 40, 'revision');
			assert.equal(page.turns[0].userText, 'Initial prompt');
			assert.equal(page.turns[0].assistantText, 'Initial answer');
			assert.equal(page.turns[0].status, 'completed');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('builds and transfers an index through the worker thread', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-paged-worker-'));
		const filePath = path.join(root, 'chat.jsonl');
		try {
			await fs.writeFile(filePath, `${JSON.stringify({ kind: 0, v: { sessionId: 'worker-session', requests: [] } })}\n`);
			const index = await indexPagedMutationHistoryInWorker(filePath);
			assert.equal(index.sessionId, 'worker-session');
			assert.equal(index.rangesByRequest instanceof Map, true);
			const page = await loadPagedMutationHistoryInWorker(index, 0, 40, 'worker-revision');
			assert.equal(page.revision, 'worker-revision');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('cancels worker indexing when the extension host disposes', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			indexPagedMutationHistoryInWorker('unused.jsonl', controller.signal),
			/operation was cancelled/,
		);
	});
});