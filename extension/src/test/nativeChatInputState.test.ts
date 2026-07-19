import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNativeChatInputStateSnapshot, parseNativeChatInputState } from '../nativeChatInputState';

describe('parseNativeChatInputState', () => {
	it('returns configuration only for the current native model', () => {
		assert.deepEqual(parseNativeChatInputState([
			{ key: 'chat.currentLanguageModel.panel', value: 'copilot/model-b' },
			{ key: 'chat.modelConfiguration.panel', value: JSON.stringify({
				'copilot/model-a': { reasoningEffort: 'low' },
				'copilot/model-b': { reasoningEffort: 'high', contextSize: 922000, ignored: { nested: true } },
			}) },
		]), {
			modelId: 'copilot/model-b',
			configuration: { reasoningEffort: 'high', contextSize: 922000 },
		});
	});

	it('tolerates malformed configuration JSON', () => {
		assert.deepEqual(parseNativeChatInputState([
			{ key: 'chat.currentLanguageModel.panel', value: 'copilot/model-b' },
			{ key: 'chat.modelConfiguration.panel', value: '{' },
		]), { modelId: 'copilot/model-b', configuration: {} });
	});

	it('retains exact raw values for cheap change detection', () => {
		const rawConfiguration = '{ "copilot/model-b": { "reasoningEffort": "high" } }';
		assert.deepEqual(createNativeChatInputStateSnapshot([
			{ key: 'chat.modelConfiguration.panel', value: rawConfiguration },
			{ key: 'chat.currentLanguageModel.panel', value: 'copilot/model-b' },
		]), {
			rawModelId: 'copilot/model-b',
			rawConfiguration,
			state: {
				modelId: 'copilot/model-b',
				configuration: { reasoningEffort: 'high' },
			},
		});
	});
});