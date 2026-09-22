import type { ModelConfigurationValue } from './protocol';

export interface NativeChatInputState {
	readonly modelId?: string;
	readonly configuration: Readonly<Record<string, ModelConfigurationValue>>;
}

export interface NativeChatInputStateSnapshot {
	readonly rawModelId?: string;
	readonly rawConfiguration?: string;
	readonly state: NativeChatInputState;
	/** Every model's stored effort/context choices, so switching models can apply VS Code's own value. */
	readonly configurations: Readonly<Record<string, Readonly<Record<string, ModelConfigurationValue>>>>;
}

export function parseNativeChatInputState(rows: readonly { key: string; value: string }[]): NativeChatInputState {
	return createNativeChatInputStateSnapshot(rows).state;
}

export function createNativeChatInputStateSnapshot(rows: readonly { key: string; value: string }[]): NativeChatInputStateSnapshot {
	const values = new Map(rows.map(row => [row.key, row.value]));
	const modelId = values.get('chat.currentLanguageModel.panel');
	const rawConfiguration = values.get('chat.modelConfiguration.panel');
	const configurations: Record<string, Readonly<Record<string, ModelConfigurationValue>>> = {};
	if (rawConfiguration) {
		try {
			const parsed = JSON.parse(rawConfiguration) as unknown;
			if (isRecord(parsed)) {
				for (const [key, entry] of Object.entries(parsed)) {
					if (isRecord(entry)) {
						configurations[key] = Object.fromEntries(
							Object.entries(entry)
								.filter((pair): pair is [string, ModelConfigurationValue] => ['string', 'number', 'boolean'].includes(typeof pair[1])),
						);
					}
				}
			}
		} catch {
			// Ignore a partially written or invalid storage value.
		}
	}
	return {
		rawModelId: modelId,
		rawConfiguration,
		state: { modelId, configuration: (modelId && configurations[modelId]) || {} },
		configurations,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}