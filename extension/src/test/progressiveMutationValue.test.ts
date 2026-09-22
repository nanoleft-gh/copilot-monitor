import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { readProgressiveMutationValue } from '../progressiveMutationValue';

describe('readProgressiveMutationValue', () => {
	it('reads and updates one path without retaining oversized history', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-progressive-value-'));
		const filePath = path.join(root, 'session.jsonl');
		try {
			const selectedModel = {
				identifier: 'copilot/gpt-test',
				metadata: { id: 'gpt-test', name: 'GPT Test' },
				modelConfiguration: { reasoningEffort: 'medium', contextSize: 272000 },
			};
			await fs.writeFile(filePath, `${[
				JSON.stringify({ kind: 0, v: { inputState: { selectedModel }, requests: [{ response: 'x'.repeat(17 * 1024 * 1024) }] } }),
				JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel', 'modelConfiguration', 'reasoningEffort'], v: 'max' }),
			].join('\n')}\n`);

			const result = await readProgressiveMutationValue(filePath, ['inputState', 'selectedModel']);

			assert.equal(result.complete, true);
			assert.equal(result.stable, true);
			assert.deepEqual(result.value, {
				...selectedModel,
				modelConfiguration: { reasoningEffort: 'max', contextSize: 272000 },
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('applies replacement and deletion mutations that overlap the target path', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-progressive-value-'));
		const filePath = path.join(root, 'session.jsonl');
		try {
			await fs.writeFile(filePath, `${[
				JSON.stringify({ kind: 0, v: { inputState: { selectedModel: { identifier: 'old' } } } }),
				JSON.stringify({ kind: 1, k: ['inputState'], v: { selectedModel: { identifier: 'new', modelConfiguration: { effort: 'high' } } } }),
				JSON.stringify({ kind: 3, k: ['inputState', 'selectedModel', 'modelConfiguration', 'effort'] }),
			].join('\n')}\n`);

			const result = await readProgressiveMutationValue(filePath, ['inputState', 'selectedModel']);

			assert.deepEqual(result.value, { identifier: 'new', modelConfiguration: {} });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});