export type JsonObject = Record<string, unknown>;

interface InitialEntry {
	readonly kind: 0;
	readonly v: unknown;
}

interface SetEntry {
	readonly kind: 1;
	readonly k: readonly (string | number)[];
	readonly v: unknown;
}

interface PushEntry {
	readonly kind: 2;
	readonly k: readonly (string | number)[];
	readonly v?: readonly unknown[];
	readonly i?: number;
}

interface DeleteEntry {
	readonly kind: 3;
	readonly k: readonly (string | number)[];
}

type MutationEntry = InitialEntry | SetEntry | PushEntry | DeleteEntry;

export interface MutationLogSnapshot {
	readonly state: JsonObject;
	readonly complete: boolean;
}

export interface TranscriptSupplementTurn {
	readonly userText: string;
	readonly assistantText: string;
	readonly thinking: string;
	readonly completedAt?: number;
}

export interface TranscriptSupplement {
	readonly turns: readonly TranscriptSupplementTurn[];
	readonly complete: boolean;
}

export interface TranscriptActivity {
	readonly id: string;
	readonly label: string;
	readonly status: 'running' | 'completed' | 'waiting';
	readonly toolId?: string;
	readonly command?: string;
	readonly cwd?: string;
	readonly output?: string;
	readonly outputTruncated?: boolean;
	readonly outputLineCount?: number;
	readonly exitCode?: number;
	readonly durationMs?: number;
	readonly canApprove?: boolean;
}

export interface TranscriptTurn {
	readonly id: string;
	readonly timestamp: number;
	readonly userText: string;
	readonly thinking: string;
	readonly thinkingTitle: string;
	readonly assistantText: string;
	readonly activities: readonly TranscriptActivity[];
	readonly status: 'working' | 'completed' | 'cancelled';
	readonly completedAt?: number;
}

export interface Transcript {
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'idle' | 'working';
	readonly turns: readonly TranscriptTurn[];
}

export function parseMutationLog(content: string): JsonObject {
	return parseMutationLogSnapshot(content).state;
}

export function parseMutationLogSnapshot(content: string): MutationLogSnapshot {
	const lines = content.split(/\r?\n/);
	let state: unknown;
	let entryCount = 0;
	let complete = true;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}

		let entry: MutationEntry;
		try {
			entry = JSON.parse(line) as MutationEntry;
		} catch (error) {
			if (index === lines.length - 1) {
				complete = false;
				break;
			}
			throw error;
		}

		entryCount++;
		if (entry.kind === 0) {
			state = entry.v;
			continue;
		}

		if (!isObject(state)) {
			throw new Error('Chat session log is missing an initial object entry.');
		}

		switch (entry.kind) {
			case 1:
				setAtPath(state, entry.k, entry.v);
				break;
			case 2:
				pushAtPath(state, entry.k, entry.v, entry.i);
				break;
			case 3:
				setAtPath(state, entry.k, undefined);
				break;
			default:
				throw new Error('Unsupported chat session log entry.');
		}
	}

	if (entryCount === 0 || !isObject(state)) {
		throw new Error('Chat session log is empty or invalid.');
	}

	return { state, complete };
}

export function normalizeTranscript(state: JsonObject): Transcript {
	const requests = Array.isArray(state.requests) ? state.requests : [];
	const turns = requests.flatMap((request, index) => {
		return isObject(request) ? [normalizeTurn(request, index)] : [];
	});
	const firstUserText = turns.find(turn => turn.userText.trim())?.userText.trim();
	const customTitle = stringValue(state.customTitle)?.trim();

	return {
		sessionId: stringValue(state.sessionId) ?? '',
		title: customTitle || summarize(firstUserText || 'Copilot chat', 72),
		status: turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
		turns,
	};
}

export function parseCopilotTranscriptLog(content: string): TranscriptSupplement {
	const turns: Array<{
		userText: string;
		assistantText: string;
		thinking: string;
		completedAt?: number;
	}> = [];
	const lines = content.split(/\r?\n/);
	let complete = true;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}

		let event: JsonObject;
		try {
			const value = JSON.parse(line) as unknown;
			if (!isObject(value)) {
				continue;
			}
			event = value;
		} catch (error) {
			if (index === lines.length - 1) {
				complete = false;
				break;
			}
			throw error;
		}

		const type = stringValue(event.type);
		const data = isObject(event.data) ? event.data : undefined;
		if (type === 'user.message') {
			turns.push({
				userText: cleanUserText(stringValue(data?.content) ?? ''),
				assistantText: '',
				thinking: '',
			});
			continue;
		}

		const turn = turns.at(-1);
		if (!turn) {
			continue;
		}
		if (type === 'assistant.message') {
			turn.assistantText = stringValue(data?.content)?.trim() ?? turn.assistantText;
			turn.thinking = stringValue(data?.reasoningText)?.trim() ?? turn.thinking;
		} else if (type === 'assistant.turn_end') {
			const timestamp = stringValue(event.timestamp);
			const completedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
			if (Number.isFinite(completedAt)) {
				turn.completedAt = completedAt;
			}
		}
	}

	return { turns, complete };
}

export function mergeTranscriptSupplement(transcript: Transcript, supplement: TranscriptSupplement): Transcript {
	let supplementIndex = 0;
	const turns = transcript.turns.map(turn => {
		while (supplementIndex < supplement.turns.length
			&& supplement.turns[supplementIndex].userText.trim() !== turn.userText.trim()) {
			supplementIndex++;
		}
		const supplementalTurn = supplement.turns[supplementIndex];
		if (!supplementalTurn) {
			return turn;
		}
		supplementIndex++;

		return {
			...turn,
			thinking: supplementalTurn.thinking || turn.thinking,
			assistantText: supplementalTurn.assistantText || turn.assistantText,
			status: supplementalTurn.completedAt === undefined ? turn.status : 'completed' as const,
			completedAt: supplementalTurn.completedAt ?? turn.completedAt,
		};
	});

	return {
		...transcript,
		status: turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
		turns,
	};
}

function normalizeTurn(request: JsonObject, index: number): TranscriptTurn {
	const response = Array.isArray(request.response) ? request.response : [];
	const markdown: string[] = [];
	const thinking: string[] = [];
	const activities: TranscriptActivity[] = [];
	let thinkingTitle = '';

	for (let partIndex = 0; partIndex < response.length; partIndex++) {
		const part = response[partIndex];
		if (!isObject(part)) {
			continue;
		}

		const kind = stringValue(part.kind);
		if (!kind && markdownValue(part.value)) {
			markdown.push(markdownValue(part.value)!);
			continue;
		}

		if (kind === 'thinking') {
			const value = markdownValue(part.value);
			if (value) {
				thinking.push(value);
			}
			const title = stringValue(part.generatedTitle);
			if (title) {
				thinkingTitle = title;
			}
			continue;
		}

		if (kind === 'progressMessage') {
			const value = markdownValue(part.content) ?? markdownValue(part.value);
			if (value) {
				activities.push({
					id: `progress-${partIndex}`,
					label: value,
					status: 'running',
				});
			}
			continue;
		}

		if (kind === 'toolInvocationSerialized') {
			const toolSpecificData = isObject(part.toolSpecificData) ? part.toolSpecificData : undefined;
			const terminalData = toolSpecificData?.kind === 'terminal' ? toolSpecificData : undefined;
			const terminalState = isObject(terminalData?.terminalCommandState) ? terminalData.terminalCommandState : undefined;
			const terminalOutput = isObject(terminalData?.terminalCommandOutput) ? terminalData.terminalCommandOutput : undefined;
			const confirmation = isObject(terminalData?.confirmation) ? terminalData.confirmation : undefined;
			const waiting = part.isConfirmed === undefined
				&& confirmation !== undefined
				&& terminalState === undefined
				&& part.resultDetails === undefined;
			const terminalCompleted = numberValue(terminalState?.exitCode) !== undefined;
			const complete = terminalData ? terminalCompleted : part.isComplete === true;
			const label = complete
				? markdownValue(part.pastTenseMessage) ?? markdownValue(part.invocationMessage)
				: markdownValue(part.invocationMessage) ?? markdownValue(part.pastTenseMessage);
			const toolId = stringValue(part.toolId);
			const activity: TranscriptActivity = {
				id: stringValue(part.toolCallId) ?? `tool-${partIndex}`,
				label: label || toolId || 'Tool activity',
				status: waiting ? 'waiting' : complete ? 'completed' : 'running',
				...(toolId ? { toolId } : {}),
			};
			if (terminalData) {
				const commandLine = isObject(terminalData.commandLine) ? terminalData.commandLine : undefined;
				const cwd = isObject(terminalData.cwd) ? terminalData.cwd : undefined;
				const outputText = stringValue(terminalOutput?.text);
				activities.push({
					...activity,
					command: stringValue(commandLine?.forDisplay) ?? stringValue(commandLine?.original),
					cwd: stringValue(cwd?.fsPath) ?? stringValue(cwd?.path),
					output: outputText ? stripAnsi(outputText) : undefined,
					outputTruncated: terminalOutput?.truncated === true,
					outputLineCount: numberValue(terminalOutput?.lineCount),
					exitCode: numberValue(terminalState?.exitCode),
					durationMs: numberValue(terminalState?.duration),
					canApprove: waiting,
				});
			} else {
				activities.push(activity);
			}
		}
	}

	const message = isObject(request.message) ? request.message : undefined;
	const modelState = isObject(request.modelState) ? request.modelState : undefined;
	const stateValue = numberValue(modelState?.value);
	const status = stateValue === 1 ? 'completed' : stateValue !== undefined && stateValue > 1 ? 'cancelled' : 'working';

	return {
		id: stringValue(request.requestId) ?? `request-${index}`,
		timestamp: numberValue(request.timestamp) ?? 0,
		userText: cleanUserText(stringValue(message?.text) ?? ''),
		thinking: thinking.join('').replace(/\n{3,}/g, '\n\n').trim(),
		thinkingTitle: thinkingTitle.trim(),
		assistantText: markdown.join('\n\n').trim(),
		activities,
		status,
		completedAt: numberValue(modelState?.completedAt),
	};
}

function setAtPath(state: JsonObject, path: readonly (string | number)[], value: unknown): void {
	if (path.length === 0) {
		return;
	}

	let current: JsonObject | unknown[] = state;
	for (let index = 0; index < path.length - 1; index++) {
		const next: unknown = readContainerValue(current, path[index]);
		if (!isObject(next) && !Array.isArray(next)) {
			throw new Error(`Invalid chat session mutation path: ${path.join('.')}`);
		}
		current = next;
	}

	writeContainerValue(current, path[path.length - 1], value);
}

function pushAtPath(
	state: JsonObject,
	path: readonly (string | number)[],
	values: readonly unknown[] | undefined,
	startIndex: number | undefined,
): void {
	if (path.length === 0) {
		throw new Error('Invalid root array mutation.');
	}

	let current: JsonObject | unknown[] = state;
	for (let index = 0; index < path.length - 1; index++) {
		const next: unknown = readContainerValue(current, path[index]);
		if (!isObject(next) && !Array.isArray(next)) {
			throw new Error(`Invalid chat session mutation path: ${path.join('.')}`);
		}
		current = next;
	}

	const key = path[path.length - 1];
	const existing = readContainerValue(current, key);
	const array = Array.isArray(existing) ? existing : [];
	if (startIndex !== undefined) {
		array.length = startIndex;
	}
	if (values?.length) {
		array.push(...values);
	}
	writeContainerValue(current, key, array);
}

function readContainerValue(container: JsonObject | unknown[], key: string | number): unknown {
	return Array.isArray(container) ? container[Number(key)] : container[String(key)];
}

function writeContainerValue(container: JsonObject | unknown[], key: string | number, value: unknown): void {
	if (Array.isArray(container)) {
		container[Number(key)] = value;
	} else {
		container[String(key)] = value;
	}
}

function cleanUserText(value: string): string {
	return value.replace(/^User:\s*/i, '').trim();
}

function markdownValue(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (isObject(value) && typeof value.value === 'string') {
		return value.value;
	}
	return undefined;
}

function summarize(value: string, length: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function stripAnsi(value: string): string {
	return value
		.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
		.replace(/\r\n/g, '\n')
		.trimEnd();
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}