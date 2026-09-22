import {
	ChatModelDescriptor,
	ModelConfigurationField,
	ModelConfigurationValue,
	SessionModelState,
} from './protocol';
import type { JsonObject } from './transcript';

/**
 * VS Code keeps the exact model list its picker shows under this application-scoped storage
 * key (`chatInputPart.ts`). It is the only source that knows every model the user can pick,
 * including newly rolled-out ones, and it carries VS Code's own `configurationSchema`.
 */
export const cachedLanguageModelsStorageKey = 'chat.cachedLanguageModels.v2';

/** One entry of the cached list, in the shape VS Code also persists as `inputState.selectedModel`. */
export interface CachedLanguageModel {
	readonly identifier: string;
	readonly metadata: JsonObject;
}

export interface ModelCatalog {
	readonly models: readonly ChatModelDescriptor[];
	/** Raw entries by identifier, for reproducing VS Code's `selectedModel` value. */
	readonly entries: ReadonlyMap<string, CachedLanguageModel>;
}

export const emptyModelCatalog: ModelCatalog = { models: [], entries: new Map() };

/**
 * Parses the stored `chat.cachedLanguageModels.v2` value into the models a local panel chat
 * can select. Mirrors VS Code's `filterModelsForSession` for a local session: no session-type
 * target and not explicitly hidden. Returns `undefined` for an unparseable value.
 */
export function parseCachedLanguageModels(raw: string): ModelCatalog | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries = new Map<string, CachedLanguageModel>();
	const models: ChatModelDescriptor[] = [];
	for (const candidate of value) {
		if (!isObject(candidate) || !isObject(candidate.metadata)) {
			continue;
		}
		const identifier = stringValue(candidate.identifier);
		const metadata = candidate.metadata;
		if (!identifier || entries.has(identifier)
			|| metadata.targetChatSessionType !== undefined
			|| metadata.isUserSelectable === false) {
			continue;
		}
		const id = stringValue(metadata.id);
		const name = stringValue(metadata.name);
		const vendor = stringValue(metadata.vendor);
		if (!id || !name || !vendor) {
			continue;
		}
		entries.set(identifier, { identifier, metadata });
		const capabilities = isObject(metadata.capabilities) ? metadata.capabilities : undefined;
		const auth = isObject(metadata.auth) ? metadata.auth : undefined;
		const extension = isObject(metadata.extension) ? metadata.extension : undefined;
		models.push({
			identifier,
			id,
			name,
			vendor,
			providerName: stringValue(auth?.providerLabel) ?? stringValue(extension?.value) ?? vendor,
			family: stringValue(metadata.family) ?? id,
			version: stringValue(metadata.version) ?? id,
			category: stringValue(metadata.category),
			preview: /preview/i.test(name) || /preview/i.test(stringValue(metadata.detail) ?? ''),
			maxInputTokens: numberValue(metadata.maxInputTokens),
			maxOutputTokens: numberValue(metadata.maxOutputTokens),
			supportsVision: capabilities?.vision === true,
			supportsTools: capabilities?.toolCalling === true,
			configurationFields: parseConfigurationSchema(isObject(metadata.configurationSchema) ? metadata.configurationSchema : undefined, {}),
		});
	}
	models.sort((left, right) => {
		if ((left.id === 'auto') !== (right.id === 'auto')) {
			return left.id === 'auto' ? -1 : 1;
		}
		return left.name.localeCompare(right.name);
	});
	return { models, entries };
}

/** Builds the `inputState.selectedModel` value VS Code would persist for a cached model. */
export function selectedModelValue(entry: CachedLanguageModel, configuration: Readonly<Record<string, ModelConfigurationValue>>): JsonObject {
	return { identifier: entry.identifier, metadata: entry.metadata, modelConfiguration: { ...configuration } };
}

export function parseSessionModelState(state: JsonObject): SessionModelState | undefined {
	const inputState = isObject(state.inputState) ? state.inputState : undefined;
	const selectedModel = isObject(inputState?.selectedModel) ? inputState.selectedModel : undefined;
	const metadata = isObject(selectedModel?.metadata) ? selectedModel.metadata : undefined;
	const selectedModelId = stringValue(selectedModel?.identifier);
	const requests = Array.isArray(state.requests) ? state.requests : [];
	let lastUsedModelId: string | undefined;
	for (let index = requests.length - 1; index >= 0; index--) {
		const request = isObject(requests[index]) ? requests[index] : undefined;
		lastUsedModelId = stringValue(request?.modelId);
		if (lastUsedModelId) {
			break;
		}
	}
	if (!selectedModelId && !lastUsedModelId) {
		return undefined;
	}

	const rawConfiguration = isObject(selectedModel?.modelConfiguration)
		? selectedModel.modelConfiguration
		: isObject(inputState?.modelConfiguration) ? inputState.modelConfiguration : undefined;
	const configuration = readConfiguration(rawConfiguration);
	const configurationSchema = isObject(metadata?.configurationSchema) ? metadata.configurationSchema : undefined;
	return {
		selectedModelId,
		selectedModelName: stringValue(metadata?.name),
		lastUsedModelId,
		configuration,
		configurationFields: parseConfigurationSchema(configurationSchema, configuration),
		configurationWritable: true,
	};
}

export function withSelectedModel(
	state: SessionModelState | undefined,
	model: ChatModelDescriptor,
): SessionModelState {
	const configuration = Object.fromEntries(
		model.configurationFields
			.filter(field => field.defaultValue !== undefined)
			.map(field => [field.key, field.defaultValue!]),
	);
	return {
		selectedModelId: model.identifier,
		selectedModelName: model.name,
		lastUsedModelId: state?.lastUsedModelId,
		configuration,
		configurationFields: model.configurationFields.map(field => ({
			...field,
			value: field.defaultValue,
		})),
		configurationWritable: true,
	};
}

function parseConfigurationSchema(
	schema: Record<string, unknown> | undefined,
	configuration: Readonly<Record<string, ModelConfigurationValue>>,
): ModelConfigurationField[] {
	const properties = isObject(schema?.properties) ? schema.properties : undefined;
	if (!properties) {
		return [];
	}
	const fields: ModelConfigurationField[] = [];
	for (const [key, raw] of Object.entries(properties)) {
		if (!isObject(raw) || !Array.isArray(raw.enum)) {
			continue;
		}
		const values = raw.enum.filter(isConfigurationValue);
		const labels = Array.isArray(raw.enumItemLabels) ? raw.enumItemLabels : [];
		const descriptions = Array.isArray(raw.enumDescriptions) ? raw.enumDescriptions : [];
		const defaultValue = isConfigurationValue(raw.default) ? raw.default : undefined;
		fields.push({
			key,
			title: stringValue(raw.title) ?? key,
			group: stringValue(raw.group),
			value: configuration[key] ?? defaultValue,
			defaultValue,
			options: values.map((value, index) => ({
				value,
				label: stringValue(labels[index]) ?? String(value),
				description: stringValue(descriptions[index]),
				isDefault: value === defaultValue,
			})),
		});
	}
	return fields;
}

function readConfiguration(value: Record<string, unknown> | undefined): Readonly<Record<string, ModelConfigurationValue>> {
	const result: Record<string, ModelConfigurationValue> = {};
	for (const [key, candidate] of Object.entries(value ?? {})) {
		if (isConfigurationValue(candidate)) {
			result[key] = candidate;
		}
	}
	return result;
}

function isConfigurationValue(value: unknown): value is ModelConfigurationValue {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function mergeSessionModelState(
	persisted: SessionModelState | undefined,
	live: SessionModelState | undefined,
): SessionModelState | undefined {
	if (!persisted || live?.selectedModelId) {
		return live ?? persisted;
	}
	if (!live) {
		return persisted;
	}
	return {
		...persisted,
		lastUsedModelId: live.lastUsedModelId ?? persisted.lastUsedModelId,
	};
}

export function mergeConfigurationFields(
	catalogFields: readonly ModelConfigurationField[],
	sessionFields: readonly ModelConfigurationField[],
	configuration: Readonly<Record<string, ModelConfigurationValue>> = {},
): ModelConfigurationField[] {
	const fields = new Map<string, ModelConfigurationField>();
	for (const field of catalogFields) {
		fields.set(field.key, field);
	}
	for (const field of sessionFields) {
		const catalogField = fields.get(field.key);
		fields.set(field.key, {
			...catalogField,
			...field,
			options: field.options.length > 0 ? field.options : catalogField?.options ?? [],
		});
	}
	return [...fields.values()].map(field => ({
		...field,
		value: configuration[field.key] ?? field.value ?? field.defaultValue,
	}));
}

export function withNativeModelState(
	current: SessionModelState | undefined,
	model: ChatModelDescriptor,
	configuration: Readonly<Record<string, ModelConfigurationValue>>,
): SessionModelState {
	const base = withSelectedModel(current, model);
	const effectiveConfiguration = { ...base.configuration, ...configuration };
	return {
		...base,
		lastUsedModelId: current?.lastUsedModelId,
		configuration: effectiveConfiguration,
		configurationFields: model.configurationFields.map(field => ({
			...field,
			value: effectiveConfiguration[field.key] ?? field.defaultValue,
		})),
	};
}