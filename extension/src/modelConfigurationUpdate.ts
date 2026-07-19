import type { ModelConfigurationValue } from './protocol';
import type { JsonObject } from './transcript';

export interface SessionModelConfigurationMutation {
	readonly kind: 1;
	readonly k: readonly ['inputState', 'selectedModel'];
	readonly v: JsonObject;
}

export interface ProfileModelConfigurationUpdate {
	readonly vendor: string;
	readonly modelId: string;
	readonly groupName: string;
	readonly key: string;
	readonly value: ModelConfigurationValue;
	readonly defaultValue?: ModelConfigurationValue;
}

export function createSessionModelConfigurationMutation(
	state: JsonObject,
	modelIdentifier: string,
	key: string,
	value: ModelConfigurationValue,
): SessionModelConfigurationMutation {
	const inputState = asObject(state.inputState);
	const selectedModel = asObject(inputState?.selectedModel);
	if (!selectedModel || selectedModel.identifier !== modelIdentifier) {
		throw new Error('The persisted session model no longer matches the requested model.');
	}
	const configuration = readConfiguration(selectedModel.modelConfiguration);
	return {
		kind: 1,
		k: ['inputState', 'selectedModel'],
		v: {
			...selectedModel,
			modelConfiguration: {
				...configuration,
				[key]: value,
			},
		},
	};
}

export function updateProfileModelConfiguration(
	value: unknown,
	update: ProfileModelConfigurationUpdate,
): JsonObject[] {
	if (!Array.isArray(value) || !value.every(item => asObject(item))) {
		throw new Error('The language model configuration file must contain an array of provider groups.');
	}
	const groups = value.map(item => ({ ...asObject(item)! }));
	let groupIndex = groups.findIndex(group => {
		const settings = asObject(group.settings);
		return group.vendor === update.vendor && asObject(settings?.[update.modelId]) !== undefined;
	});
	if (groupIndex < 0) {
		groupIndex = groups.findIndex(group => group.vendor === update.vendor);
	}

	if (groupIndex < 0) {
		if (update.value !== update.defaultValue) {
			groups.push({
				name: update.groupName,
				vendor: update.vendor,
				settings: {
					[update.modelId]: { [update.key]: update.value },
				},
			});
		}
		return groups;
	}

	const group = groups[groupIndex];
	const settings = { ...asObject(group.settings) };
	const modelConfiguration = { ...asObject(settings[update.modelId]) };
	if (update.value === update.defaultValue) {
		delete modelConfiguration[update.key];
	} else {
		modelConfiguration[update.key] = update.value;
	}
	if (Object.keys(modelConfiguration).length > 0) {
		settings[update.modelId] = modelConfiguration;
	} else {
		delete settings[update.modelId];
	}
	if (Object.keys(settings).length > 0) {
		group.settings = settings;
	} else {
		delete group.settings;
	}

	const extraKeys = Object.keys(group).filter(key => !['name', 'vendor', 'range', 'modelsRange', 'settings'].includes(key));
	if (!group.settings && extraKeys.length === 0) {
		groups.splice(groupIndex, 1);
	}
	return groups;
}

function readConfiguration(value: unknown): Record<string, ModelConfigurationValue> {
	const configuration: Record<string, ModelConfigurationValue> = {};
	for (const [key, candidate] of Object.entries(asObject(value) ?? {})) {
		if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
			configuration[key] = candidate;
		}
	}
	return configuration;
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

export interface SessionValueMutation {
	readonly kind: 1;
	readonly k: readonly (string | number)[];
	readonly v: unknown;
}

export function createSessionValueMutation(path: readonly (string | number)[], value: unknown): SessionValueMutation {
	if (path.length === 0 || path.some(segment => typeof segment !== 'string' && typeof segment !== 'number')) {
		throw new Error('A non-empty session mutation path is required.');
	}
	return { kind: 1, k: [...path], v: value };
}