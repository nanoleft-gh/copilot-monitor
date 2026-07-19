import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionModelConfigurationMutation, createSessionValueMutation, updateProfileModelConfiguration } from '../modelConfigurationUpdate';
import { parseMutationLog } from '../transcript';

describe('model configuration update', () => {
	it('appends an exact selected-model mutation while preserving metadata and other values', () => {
		const state = {
			inputState: {
				selectedModel: {
					identifier: 'copilot/gpt-test',
					metadata: { id: 'gpt-test', name: 'GPT Test' },
					modelConfiguration: { reasoningEffort: 'medium', contextSize: 272000 },
				},
			},
		};
		const mutation = createSessionModelConfigurationMutation(state, 'copilot/gpt-test', 'reasoningEffort', 'max');
		const content = [
			JSON.stringify({ kind: 0, v: state }),
			JSON.stringify(mutation),
		].join('\n');
		const updated = parseMutationLog(content);
		assert.deepEqual(updated.inputState, {
			selectedModel: {
				identifier: 'copilot/gpt-test',
				metadata: { id: 'gpt-test', name: 'GPT Test' },
				modelConfiguration: { reasoningEffort: 'max', contextSize: 272000 },
			},
		});
	});

	it('rejects a stale model selection', () => {
		assert.throws(
			() => createSessionModelConfigurationMutation({
				inputState: { selectedModel: { identifier: 'copilot/model-a' } },
			}, 'copilot/model-b', 'reasoningEffort', 'high'),
			/persisted session model no longer matches/,
		);
	});

	it('creates exact title and permission mutations', () => {
		const content = [
			JSON.stringify({ kind: 0, v: { customTitle: 'Old', inputState: { permissionLevel: 'default' } } }),
			JSON.stringify(createSessionValueMutation(['customTitle'], 'Renamed')),
			JSON.stringify(createSessionValueMutation(['inputState', 'permissionLevel'], 'autopilot')),
		].join('\n');
		const updated = parseMutationLog(content);
		assert.equal(updated.customTitle, 'Renamed');
		assert.deepEqual(updated.inputState, { permissionLevel: 'autopilot' });
	});

	it('updates one profile model and preserves unrelated settings', () => {
		const updated = updateProfileModelConfiguration([{
			name: 'Copilot',
			vendor: 'copilot',
			settings: {
				'gpt-test': { reasoningEffort: 'medium', contextSize: 272000 },
				'other-model': { reasoningEffort: 'high' },
			},
		}], {
			vendor: 'copilot',
			modelId: 'gpt-test',
			groupName: 'Copilot',
			key: 'contextSize',
			value: 922000,
			defaultValue: 272000,
		});
		assert.deepEqual(updated[0].settings, {
			'gpt-test': { reasoningEffort: 'medium', contextSize: 922000 },
			'other-model': { reasoningEffort: 'high' },
		});
	});

	it('removes a default override without removing other model settings', () => {
		const updated = updateProfileModelConfiguration([{
			name: 'Copilot',
			vendor: 'copilot',
			settings: {
				'gpt-test': { reasoningEffort: 'max' },
				'other-model': { contextSize: 922000 },
			},
		}], {
			vendor: 'copilot',
			modelId: 'gpt-test',
			groupName: 'Copilot',
			key: 'reasoningEffort',
			value: 'medium',
			defaultValue: 'medium',
		});
		assert.deepEqual(updated[0].settings, {
			'other-model': { contextSize: 922000 },
		});
	});
});