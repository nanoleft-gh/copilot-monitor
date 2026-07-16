import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	ChatModelDescriptor,
	ModelConfigurationField,
	ModelConfigurationOption,
	ModelConfigurationValue,
	SessionModelState,
} from './protocol';
import type { JsonObject } from './transcript';

export interface ModelCatalogSnapshot {
	readonly models: readonly ChatModelDescriptor[];
	readonly revision: string;
}

const effortDescriptions: Readonly<Record<string, string>> = {
	none: 'No reasoning applied',
	minimal: 'Minimal reasoning for fastest responses',
	low: 'Faster responses with less reasoning',
	medium: 'Balanced reasoning and speed',
	high: 'Greater reasoning depth but slower',
	xhigh: 'Highest reasoning depth but slowest',
	max: 'Absolute maximum capability with no constraints',
};

const effortLabels: Readonly<Record<string, string>> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	max: 'Max',
};

export async function readLatestModelCatalog(directories: readonly string[]): Promise<ModelCatalogSnapshot | undefined> {
	const candidates: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
	for (const directory of directories) {
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const filePath = entry.isDirectory()
				? path.join(directory, entry.name, 'models.json')
				: entry.isFile() && entry.name === 'models.json' ? path.join(directory, entry.name) : undefined;
			if (!filePath) {
				continue;
			}
			try {
				const stat = await fs.stat(filePath);
				candidates.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {
				continue;
			}
		}
	}

	for (const candidate of candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
		try {
			const content = await fs.readFile(candidate.filePath, 'utf8');
			const stat = await fs.stat(candidate.filePath);
			if (stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs || Buffer.byteLength(content) !== stat.size) {
				continue;
			}
			const value = JSON.parse(content) as unknown;
			if (!Array.isArray(value)) {
				continue;
			}
			return {
				models: parseModelCatalog(value),
				revision: `${candidate.filePath}:${stat.size}:${stat.mtimeMs}`,
			};
		} catch {
			continue;
		}
	}
	return undefined;
}

export function parseModelCatalog(value: unknown): ChatModelDescriptor[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const models: ChatModelDescriptor[] = [createAutoModel()];
	for (const candidate of value) {
		if (!isObject(candidate)
			|| candidate.model_picker_enabled !== true
			|| stringValue(isObject(candidate.policy) ? candidate.policy.state : undefined) === 'disabled') {
			continue;
		}
		const id = stringValue(candidate.id);
		const name = stringValue(candidate.name);
		if (!id || !name) {
			continue;
		}

		const capabilities = isObject(candidate.capabilities) ? candidate.capabilities : undefined;
		const limits = isObject(capabilities?.limits) ? capabilities.limits : undefined;
		const supports = isObject(capabilities?.supports) ? capabilities.supports : undefined;
		const family = stringValue(capabilities?.family) ?? id;
		models.push({
			identifier: `copilot/${id}`,
			id,
			name,
			vendor: 'copilot',
			providerName: stringValue(candidate.vendor) ?? 'GitHub Copilot',
			family,
			version: stringValue(candidate.version) ?? id,
			category: stringValue(candidate.model_picker_category),
			preview: candidate.preview === true,
			maxInputTokens: numberValue(limits?.max_prompt_tokens),
			maxOutputTokens: numberValue(limits?.max_output_tokens),
			supportsVision: supports?.vision === true,
			supportsTools: supports?.tool_calls === true,
			configurationFields: createConfigurationFields(candidate, family),
		});
	}

	return models.sort((left, right) => {
		if (left.id === 'auto') {
			return -1;
		}
		if (right.id === 'auto') {
			return 1;
		}
		return left.name.localeCompare(right.name);
	});
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

function createAutoModel(): ChatModelDescriptor {
	return {
		identifier: 'copilot/auto',
		id: 'auto',
		name: 'Auto',
		vendor: 'copilot',
		providerName: 'GitHub Copilot',
		family: 'auto',
		version: 'auto',
		preview: false,
		supportsVision: true,
		supportsTools: true,
		configurationFields: [],
	};
}

function createConfigurationFields(model: Record<string, unknown>, family: string): ModelConfigurationField[] {
	const capabilities = isObject(model.capabilities) ? model.capabilities : undefined;
	const limits = isObject(capabilities?.limits) ? capabilities.limits : undefined;
	const supports = isObject(capabilities?.supports) ? capabilities.supports : undefined;
	const fields: ModelConfigurationField[] = [];
	const efforts = Array.isArray(supports?.reasoning_effort)
		? supports.reasoning_effort.filter((effort): effort is string => typeof effort === 'string')
		: [];
	if (efforts.length > 1) {
		const defaultValue = efforts.includes(family.toLowerCase().startsWith('claude') ? 'high' : 'medium')
			? family.toLowerCase().startsWith('claude') ? 'high' : 'medium'
			: efforts[0];
		fields.push({
			key: 'reasoningEffort',
			title: 'Thinking Effort',
			group: 'navigation',
			defaultValue,
			options: efforts.map(value => ({
				value,
				label: effortLabels[value] ?? capitalize(value),
				description: effortDescriptions[value] ?? value,
				isDefault: value === defaultValue,
			})),
		});
	}

	const billing = isObject(model.billing) ? model.billing : undefined;
	const tokenPrices = isObject(billing?.token_prices) ? billing.token_prices : undefined;
	const defaultPricing = isObject(tokenPrices?.default) ? tokenPrices.default : undefined;
	const longContext = isObject(tokenPrices?.long_context) ? tokenPrices.long_context : undefined;
	const defaultMax = numberValue(defaultPricing?.context_max);
	const fullMax = numberValue(limits?.max_prompt_tokens);
	if (defaultMax !== undefined && fullMax !== undefined && defaultMax < fullMax) {
		const options: ModelConfigurationOption[] = longContext
			? [
				{ value: defaultMax, label: formatTokenCount(defaultMax), description: 'Default recommended context size', isDefault: true },
				{ value: fullMax, label: formatTokenCount(fullMax), description: 'Longer sessions', isDefault: false },
			]
			: [{ value: fullMax, label: formatTokenCount(fullMax), description: 'Longer sessions', isDefault: true }];
		fields.push({
			key: 'contextSize',
			title: 'Context Size',
			group: 'tokens',
			defaultValue: options.find(option => option.isDefault)?.value,
			options,
		});
	}
	return fields;
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

function formatTokenCount(value: number): string {
	if (value >= 900_000) {
		return `${Math.round(value / 1_000_000)}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 1_000)}K`;
	}
	return String(value);
}

function capitalize(value: string): string {
	return value ? value[0].toUpperCase() + value.slice(1) : value;
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