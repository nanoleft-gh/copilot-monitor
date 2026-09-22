import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeConfigurationFields, mergeSessionModelState, parseCachedLanguageModels, parseSessionModelState, selectedModelValue, withNativeModelState, withSelectedModel } from '../modelCatalog';

/** Shape of one `chat.cachedLanguageModels.v2` entry as VS Code stores it. */
function cachedEntry(id: string, overrides: Record<string, unknown> = {}, vendor = 'copilot') {
	return {
		identifier: `${vendor}/${id}`,
		metadata: {
			extension: { value: 'GitHub.copilot-chat', _lower: 'github.copilot-chat' },
			id,
			vendor,
			name: overrides.name ?? id.toUpperCase(),
			family: id,
			version: id,
			maxInputTokens: 935_793,
			maxOutputTokens: 64_000,
			auth: { providerLabel: 'GitHub Copilot', accountLabel: 'user' },
			isUserSelectable: true,
			capabilities: { vision: true, toolCalling: true, agentMode: true },
			configurationSchema: {
				properties: {
					reasoningEffort: { type: 'string', title: 'Thinking Effort', enum: ['low', 'high'], enumItemLabels: ['Low', 'High'], enumDescriptions: ['Fast', 'Deep'], default: 'high', group: 'navigation' },
					contextSize: { type: 'number', title: 'Context Size', enum: [936_000], enumItemLabels: ['1M'], default: 936_000, group: 'tokens' },
				},
			},
			...overrides,
		},
	};
}

describe('model catalog', () => {
	it('lists exactly the models VS Code shows for a local panel chat, Auto first, with VS Code\'s configuration schema', () => {
		const catalog = parseCachedLanguageModels(JSON.stringify([
			cachedEntry('claude-fable-5.1', { name: 'Claude Fable 5.1' }),
			cachedEntry('auto', { name: 'Auto', configurationSchema: undefined }),
			cachedEntry('gpt-4o-mini', { isUserSelectable: false }),
			cachedEntry('claude-fable-5.1', { targetChatSessionType: 'copilotcli' }, 'copilotcli'),
			cachedEntry('claude-fable-5.1', { name: 'duplicate' }),
			{ identifier: 'broken' },
			cachedEntry('nameless', { name: undefined }),
		]))!;

		assert.deepEqual(catalog.models.map(model => model.identifier), ['copilot/auto', 'copilot/claude-fable-5.1']);
		const fable = catalog.models[1];
		assert.equal(fable.name, 'Claude Fable 5.1');
		assert.equal(fable.providerName, 'GitHub Copilot');
		assert.equal(fable.maxInputTokens, 935_793);
		assert.equal(fable.supportsTools, true);
		assert.deepEqual(fable.configurationFields.map(field => [field.key, field.defaultValue, field.value]), [
			['reasoningEffort', 'high', 'high'],
			['contextSize', 936_000, 936_000],
		]);
		assert.deepEqual(fable.configurationFields[0].options.map(option => [option.value, option.label, option.isDefault]), [['low', 'Low', false], ['high', 'High', true]]);
		assert.deepEqual(catalog.models[0].configurationFields, []);
		assert.ok(catalog.entries.has('copilot/claude-fable-5.1'));
		assert.equal(catalog.entries.size, 2);
	});

	it('rejects values that are not a model list', () => {
		assert.equal(parseCachedLanguageModels('{'), undefined);
		assert.equal(parseCachedLanguageModels('{"a":1}'), undefined);
		assert.deepEqual(parseCachedLanguageModels('[]')?.models, []);
	});

	it('reproduces the selectedModel value VS Code persists from a cached entry', () => {
		const catalog = parseCachedLanguageModels(JSON.stringify([cachedEntry('gpt-test')]))!;
		const value = selectedModelValue(catalog.entries.get('copilot/gpt-test')!, { reasoningEffort: 'low' });
		assert.equal(value.identifier, 'copilot/gpt-test');
		assert.deepEqual(value.modelConfiguration, { reasoningEffort: 'low' });
		assert.deepEqual((value.metadata as { id: string }).id, 'gpt-test');
		// The persisted-state parser understands what we wrote.
		const state = parseSessionModelState({ inputState: { selectedModel: value } });
		assert.equal(state?.selectedModelId, 'copilot/gpt-test');
		assert.equal(state?.configurationFields[0].value, 'low');
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
		const model = parseCachedLanguageModels(JSON.stringify([cachedEntry('model-a')]))!.models[0];
		const selected = withSelectedModel(undefined, model);
		assert.equal(selected.selectedModelId, 'copilot/model-a');
		assert.equal(selected.configuration.reasoningEffort, 'high');
		assert.equal(selected.configuration.contextSize, 936_000);
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
		const model = parseCachedLanguageModels(JSON.stringify([cachedEntry('model-a')]))!.models[0];
		const state = withNativeModelState(undefined, model, { reasoningEffort: 'low' });
		assert.equal(state.selectedModelId, 'copilot/model-a');
		assert.equal(state.configuration.reasoningEffort, 'low');
		assert.equal(state.configurationFields[0].value, 'low');
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
