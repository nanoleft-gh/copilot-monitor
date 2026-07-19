import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { mergeConfigurationFields, mergeSessionModelState, parseModelCatalog, parseSessionModelState, readLatestModelCatalog, withNativeModelState, withSelectedModel } from '../modelCatalog';

describe('model catalog', () => {
	it('filters picker models and derives effort/context options', () => {
		const catalog = parseModelCatalog([
			{
				id: 'gpt-test', name: 'GPT Test', vendor: 'OpenAI', version: '1', model_picker_enabled: true,
				capabilities: {
					family: 'gpt-test', limits: { max_prompt_tokens: 922000, max_output_tokens: 128000 },
					supports: { reasoning_effort: ['none', 'medium', 'max'], vision: true, tool_calls: true },
				},
				billing: { token_prices: { default: { context_max: 272000 }, long_context: { context_max: 922000 } } },
			},
			{ id: 'hidden', name: 'Hidden', model_picker_enabled: false },
		]);

		assert.equal(catalog[0].identifier, 'copilot/auto');
		assert.equal(catalog.length, 2);
		const model = catalog[1];
		assert.equal(model.identifier, 'copilot/gpt-test');
		assert.deepEqual(model.configurationFields.map(field => [field.key, field.defaultValue]), [
			['reasoningEffort', 'medium'],
			['contextSize', 272000],
		]);
		assert.deepEqual(model.configurationFields[1].options.map(option => option.label), ['272K', '1M']);
	});

	it('extracts persisted selected model, last used model, and exact configuration', () => {
		const state = parseSessionModelState({
			inputState: {
				selectedModel: {
					identifier: 'copilot/gpt-test',
					metadata: {
						name: 'GPT Test',
						configurationSchema: { properties: {
							reasoningEffort: { title: 'Thinking Effort', group: 'navigation', enum: ['low', 'high'], enumItemLabels: ['Low', 'High'], default: 'low' },
						} },
					},
					modelConfiguration: { reasoningEffort: 'high' },
				},
			},
			requests: [{ modelId: 'copilot/gpt-old' }, { modelId: 'copilot/gpt-test' }],
		});

		assert.equal(state?.selectedModelId, 'copilot/gpt-test');
		assert.equal(state?.lastUsedModelId, 'copilot/gpt-test');
		assert.equal(state?.configuration.reasoningEffort, 'high');
		assert.equal(state?.configurationFields[0].value, 'high');
		assert.equal(state?.configurationWritable, true);
	});

	it('creates an immediate default model overlay after web selection', () => {
		const model = parseModelCatalog([{
			id: 'model-a', name: 'Model A', vendor: 'Provider', version: '1', model_picker_enabled: true,
			capabilities: { family: 'model-a', limits: {}, supports: { reasoning_effort: ['low', 'medium'] } },
		}]).find(candidate => candidate.id === 'model-a')!;
		const selected = withSelectedModel(undefined, model);
		assert.equal(selected.selectedModelId, 'copilot/model-a');
		assert.equal(selected.configuration.reasoningEffort, 'medium');
	});

	it('reads the newest stable model snapshot and skips an invalid newer file', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-models-'));
		try {
			const validDirectory = path.join(root, 'valid');
			const invalidDirectory = path.join(root, 'invalid');
			await fs.mkdir(validDirectory);
			await fs.mkdir(invalidDirectory);
			const validPath = path.join(validDirectory, 'models.json');
			const invalidPath = path.join(invalidDirectory, 'models.json');
			await fs.writeFile(validPath, JSON.stringify([{ id: 'model-a', name: 'Model A', model_picker_enabled: true }]));
			await fs.writeFile(invalidPath, '{');
			await fs.utimes(validPath, new Date(1_000), new Date(1_000));
			await fs.utimes(invalidPath, new Date(2_000), new Date(2_000));

			const snapshot = await readLatestModelCatalog([root]);
			assert.deepEqual(snapshot?.models.map(model => model.id), ['auto', 'model-a']);
			assert.match(snapshot?.revision ?? '', /valid.*models\.json/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('keeps persisted selection and configuration when a hot export only has last-used model state', () => {
		const persisted = parseSessionModelState({
			inputState: { selectedModel: {
				identifier: 'copilot/gpt-test',
				metadata: { name: 'GPT Test' },
				modelConfiguration: { reasoningEffort: 'high' },
			} },
		});
		const live = parseSessionModelState({ requests: [{ modelId: 'copilot/gpt-test' }] });
		const merged = mergeSessionModelState(persisted, live);
		assert.equal(merged?.selectedModelId, 'copilot/gpt-test');
		assert.equal(merged?.lastUsedModelId, 'copilot/gpt-test');
		assert.equal(merged?.configuration.reasoningEffort, 'high');
	});

	it('overlays native selected model configuration on the exact session state', () => {
		const model = parseModelCatalog([{
			id: 'model-a', name: 'Model A', vendor: 'Provider', version: '1', model_picker_enabled: true,
			capabilities: { family: 'model-a', limits: {}, supports: { reasoning_effort: ['low', 'high'] } },
		}]).find(candidate => candidate.id === 'model-a')!;
		const state = withNativeModelState(undefined, model, { reasoningEffort: 'high' });
		assert.equal(state.selectedModelId, 'copilot/model-a');
		assert.equal(state.configuration.reasoningEffort, 'high');
		assert.equal(state.configurationFields[0].value, 'high');
	});

	it('merges partial session schemas with catalog fields by key', () => {
		const fields = mergeConfigurationFields(
			[
				{ key: 'reasoningEffort', title: 'Catalog effort', defaultValue: 'medium', options: [{ value: 'medium', label: 'Medium', isDefault: true }] },
				{ key: 'contextSize', title: 'Context Size', defaultValue: 200_000, options: [{ value: 200_000, label: '200K', isDefault: true }, { value: 936_000, label: '936K', isDefault: false }] },
			],
			[
				{ key: 'reasoningEffort', title: 'Thinking Effort', value: 'high', options: [{ value: 'medium', label: 'Medium', isDefault: false }, { value: 'high', label: 'High', isDefault: true }] },
			],
			{ reasoningEffort: 'high', contextSize: 936_000 },
		);

		assert.deepEqual(fields.map(field => [field.key, field.value]), [
			['reasoningEffort', 'high'],
			['contextSize', 936_000],
		]);
		assert.equal(fields[0].title, 'Thinking Effort');
		assert.deepEqual(fields[0].options.map(option => option.value), ['medium', 'high']);
	});
});