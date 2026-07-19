import type { ModelConfigurationValue } from './protocol';

export interface NativeChatInputState {
	readonly modelId?: string;
	readonly configuration: Readonly<Record<string, ModelConfigurationValue>>;
}

export interface NativeChatInputStateSnapshot {
	readonly rawModelId?: string;
	readonly rawConfiguration?: string;
	readonly state: NativeChatInputState;
}

export function parseNativeChatInputState(rows: readonly { key: string; value: string }[]): NativeChatInputState {
	return createNativeChatInputStateSnapshot(rows).state;
}

export function createNativeChatInputStateSnapshot(rows: readonly { key: string; value: string }[]): NativeChatInputStateSnapshot {
	const values = new Map(rows.map(row => [row.key, row.value]));
	const modelId = values.get('chat.currentLanguageModel.panel');
	let configuration: Record<string, ModelConfigurationValue> = {};
	const rawConfiguration = values.get('chat.modelConfiguration.panel');
	if (modelId && rawConfiguration) {
		try {
			const parsed = JSON.parse(rawConfiguration) as unknown;
			const modelConfiguration = isRecord(parsed) ? parsed[modelId] : undefined;
			if (isRecord(modelConfiguration)) {
				configuration = Object.fromEntries(
					Object.entries(modelConfiguration)
						.filter((entry): entry is [string, ModelConfigurationValue] => ['string', 'number', 'boolean'].includes(typeof entry[1])),
				);
			}
		} catch {
			// Ignore a partially written or invalid storage value.
		}
	}
	return {
		rawModelId: modelId,
		rawConfiguration,
		state: { modelId, configuration },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}