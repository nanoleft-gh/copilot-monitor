import type { JsonObject } from './transcript';

/**
 * Live view of a session assembled from the event streams Copilot Chat writes while it
 * works: the hook transcript (`transcripts/<id>.jsonl`, full text, flushed at every hook
 * boundary) and the debug log (`debug-logs/<id>/main.jsonl`, 5 KB previews, flushed every
 * few seconds). Both feed the same accumulator so the merge step is source-agnostic.
 */

export type LiveToolStatus = 'requested' | 'running' | 'completed' | 'failed';

export interface LiveToolCall {
	readonly id: string;
	readonly name: string;
	readonly argsPreview: string;
	readonly status: LiveToolStatus;
	readonly requestedAt: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
}

export interface LiveTurn {
	/** Ordinal of the user message within this source (0-based). */
	readonly index: number;
	readonly userText: string;
	readonly startedAt: number;
	readonly assistantText: string;
	readonly thinking: string;
	readonly rounds: number;
	readonly tools: readonly LiveToolCall[];
	/** `completed` once a round ended without requesting tools (the final answer). */
	readonly status: 'working' | 'completed';
	readonly completedAt?: number;
	/** Text came from a truncating source (debug log caps attributes at 5 000 chars). */
	readonly textTruncated: boolean;
}

interface MutableTurn {
	index: number;
	userText: string;
	startedAt: number;
	assistantParts: string[];
	thinkingParts: string[];
	rounds: number;
	tools: LiveToolCall[];
	status: 'working' | 'completed';
	completedAt?: number;
	textTruncated: boolean;
	/** Tool requests made in the round currently open; empty when the last round was final. */
	openRoundToolCount: number;
}

const maximumArgsPreviewChars = 400;
const defaultMaximumLiveTurns = 8;

export class LiveTurnAccumulator {
	private readonly turnsInternal: MutableTurn[] = [];
	private sessionId: string | undefined;

	constructor(private readonly maximumTurns = defaultMaximumLiveTurns) {}

	get turns(): readonly LiveTurn[] {
		return this.turnsInternal.map(toLiveTurn);
	}

	get latest(): LiveTurn | undefined {
		const last = this.turnsInternal.at(-1);
		return last ? toLiveTurn(last) : undefined;
	}

	get observedSessionId(): string | undefined {
		return this.sessionId;
	}

	reset(): void {
		this.turnsInternal.length = 0;
		this.sessionId = undefined;
	}

	/** Apply one line of `transcripts/<id>.jsonl`. Returns whether the visible state changed. */
	applyTranscriptLine(line: string): boolean {
		const entry = parseJsonObject(line);
		if (!entry) {
			return false;
		}
		const type = stringValue(entry.type);
		const data = isObject(entry.data) ? entry.data : {};
		const at = parseIsoTimestamp(entry.timestamp) ?? Date.now();
		switch (type) {
			case 'session.start':
				this.sessionId = stringValue(data.sessionId) ?? this.sessionId;
				return false;
			case 'user.message':
				this.beginTurn(cleanUserText(stringValue(data.content) ?? ''), at);
				return true;
			case 'assistant.turn_start': {
				const turn = this.current();
				if (!turn) {return false;}
				turn.rounds++;
				turn.openRoundToolCount = 0;
				turn.status = 'working';
				return false;
			}
			case 'assistant.message': {
				const turn = this.current();
				if (!turn) {return false;}
				const content = stringValue(data.content)?.trim();
				if (content) {turn.assistantParts.push(content);}
				const reasoning = stringValue(data.reasoningText)?.trim();
				if (reasoning) {turn.thinkingParts.push(reasoning);}
				const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
				for (const request of requests) {
					if (!isObject(request)) {continue;}
					const id = stringValue(request.toolCallId) ?? `tool-${turn.tools.length}`;
					const name = stringValue(request.name) ?? 'tool';
					this.upsertTool(turn, id, name, previewOf(request.arguments), 'requested', at);
				}
				turn.openRoundToolCount = requests.length;
				return true;
			}
			case 'tool.execution_start': {
				const turn = this.current();
				if (!turn) {return false;}
				const id = stringValue(data.toolCallId) ?? `tool-${turn.tools.length}`;
				const name = stringValue(data.toolName) ?? 'tool';
				this.upsertTool(turn, id, name, previewOf(data.arguments), 'running', at);
				return true;
			}
			case 'tool.execution_complete': {
				const turn = this.current();
				if (!turn) {return false;}
				const id = stringValue(data.toolCallId);
				const tool = id ? turn.tools.find(candidate => sameToolId(candidate.id, id)) : undefined;
				if (!tool) {return false;}
				this.replaceTool(turn, tool, { status: data.success === false ? 'failed' : 'completed', completedAt: at });
				return true;
			}
			case 'assistant.turn_end': {
				const turn = this.current();
				if (!turn) {return false;}
				if (turn.openRoundToolCount === 0) {
					turn.status = 'completed';
					turn.completedAt = at;
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	}

	/**
	 * Apply one line of `debug-logs/<id>/main.jsonl`. Callers should skip `llm_request`
	 * lines with {@link sniffDebugLogType} before parsing: they carry the entire prompt.
	 */
	applyDebugLogLine(line: string): boolean {
		const entry = parseJsonObject(line);
		if (!entry) {
			return false;
		}
		const type = stringValue(entry.type);
		const attrs = isObject(entry.attrs) ? entry.attrs : {};
		const at = typeof entry.ts === 'number' ? entry.ts : Date.now();
		this.sessionId = stringValue(entry.sid) ?? this.sessionId;
		switch (type) {
			case 'user_message':
				this.beginTurn(cleanUserText(stringValue(attrs.content) ?? ''), at);
				return true;
			case 'turn_start': {
				const turn = this.current();
				if (!turn) {return false;}
				turn.rounds++;
				turn.openRoundToolCount = 0;
				turn.status = 'working';
				return false;
			}
			case 'agent_response': {
				const turn = this.current();
				if (!turn) {return false;}
				const parsed = parseAgentResponse(stringValue(attrs.response) ?? '');
				if (parsed.text) {turn.assistantParts.push(parsed.text);}
				const reasoning = stringValue(attrs.reasoning)?.trim();
				if (reasoning) {turn.thinkingParts.push(reasoning);}
				if (parsed.truncated) {turn.textTruncated = true;}
				for (const call of parsed.toolCalls) {
					this.upsertTool(turn, call.id, call.name, call.argsPreview, 'requested', at);
				}
				turn.openRoundToolCount = parsed.toolCalls.length;
				return true;
			}
			case 'hook': {
				const turn = this.current();
				if (!turn || stringValue(entry.name) !== 'PreToolUse') {return false;}
				const input = parseJsonObject(stringValue(attrs.input) ?? '');
				const id = input ? stringValue(input.tool_use_id) : undefined;
				const name = input ? stringValue(input.tool_name) : undefined;
				if (!id || !name) {return false;}
				this.upsertTool(turn, id, name, previewOf(input?.tool_input), 'running', at + (typeof entry.dur === 'number' ? entry.dur : 0));
				return true;
			}
			case 'tool_call': {
				const turn = this.current();
				if (!turn) {return false;}
				const name = stringValue(entry.name) ?? 'tool';
				const duration = typeof entry.dur === 'number' ? entry.dur : 0;
				const failed = entry.status === 'error';
				// Completion spans carry no call id: settle the oldest unfinished call with this name.
				const tool = turn.tools.find(candidate => candidate.name === name && candidate.status !== 'completed' && candidate.status !== 'failed');
				if (tool) {
					this.replaceTool(turn, tool, { status: failed ? 'failed' : 'completed', startedAt: tool.startedAt ?? at, completedAt: at + duration });
				} else {
					turn.tools.push({ id: `span-${stringValue(entry.spanId) ?? turn.tools.length}`, name, argsPreview: previewOf(attrs.args), status: failed ? 'failed' : 'completed', requestedAt: at, startedAt: at, completedAt: at + duration });
				}
				return true;
			}
			case 'turn_end': {
				const turn = this.current();
				if (!turn) {return false;}
				if (turn.openRoundToolCount === 0) {
					turn.status = 'completed';
					turn.completedAt = at;
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	}

	private beginTurn(userText: string, at: number): void {
		const last = this.turnsInternal.at(-1);
		// A repeated user message with no assistant activity in between is a replay of the same turn.
		if (last && last.userText === userText && last.rounds === 0 && last.assistantParts.length === 0 && last.tools.length === 0) {
			last.startedAt = at;
			return;
		}
		this.turnsInternal.push({
			index: this.turnsInternal.length === 0 ? 0 : this.turnsInternal[this.turnsInternal.length - 1].index + 1,
			userText,
			startedAt: at,
			assistantParts: [],
			thinkingParts: [],
			rounds: 0,
			tools: [],
			status: 'working',
			textTruncated: false,
			openRoundToolCount: 0,
		});
		if (this.turnsInternal.length > this.maximumTurns) {
			this.turnsInternal.splice(0, this.turnsInternal.length - this.maximumTurns);
		}
	}

	private current(): MutableTurn | undefined {
		return this.turnsInternal.at(-1);
	}

	private upsertTool(turn: MutableTurn, id: string, name: string, argsPreview: string, status: LiveToolStatus, at: number): void {
		const existing = turn.tools.find(candidate => sameToolId(candidate.id, id));
		if (!existing) {
			turn.tools.push({
				id,
				name,
				argsPreview,
				status,
				requestedAt: at,
				...(status === 'running' ? { startedAt: at } : {}),
			});
			return;
		}
		if (rank(status) <= rank(existing.status)) {
			return;
		}
		this.replaceTool(turn, existing, {
			status,
			argsPreview: existing.argsPreview || argsPreview,
			...(status === 'running' ? { startedAt: at } : {}),
		});
	}

	private replaceTool(turn: MutableTurn, tool: LiveToolCall, patch: Partial<LiveToolCall>): void {
		const index = turn.tools.indexOf(tool);
		turn.tools[index] = { ...tool, ...patch };
	}
}

export type DebugLogType = string;

/** Reads the entry type from the first bytes of a debug-log line without parsing it. */
export function sniffDebugLogType(line: string): DebugLogType | undefined {
	const match = /"type":"([a-z_.]+)"/.exec(line.slice(0, 256));
	return match?.[1];
}

/** Debug-log entry types worth parsing; everything else (notably `llm_request`) is skipped. */
export const relevantDebugLogTypes: ReadonlySet<string> = new Set(['user_message', 'turn_start', 'turn_end', 'agent_response', 'tool_call', 'hook']);

interface ParsedAgentResponse {
	readonly text: string;
	readonly toolCalls: readonly { id: string; name: string; argsPreview: string }[];
	readonly truncated: boolean;
}

/** `attrs.response` is a JSON string capped at 5 000 chars, so it may be cut mid-way. */
export function parseAgentResponse(raw: string): ParsedAgentResponse {
	const texts: string[] = [];
	const toolCalls: { id: string; name: string; argsPreview: string }[] = [];
	let truncated = false;
	let messages: unknown;
	try {
		messages = JSON.parse(raw);
	} catch {
		truncated = true;
	}
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!isObject(message) || !Array.isArray(message.parts)) {continue;}
			for (const part of message.parts) {
				if (!isObject(part)) {continue;}
				if (part.type === 'text' && typeof part.content === 'string' && part.content.trim()) {
					texts.push(part.content.trim());
				} else if (part.type === 'tool_call') {
					toolCalls.push({
						id: stringValue(part.id) ?? `tool-${toolCalls.length}`,
						name: stringValue(part.name) ?? 'tool',
						argsPreview: previewOf(part.arguments ?? part.args ?? part.input),
					});
				}
			}
		}
	} else {
		// Best effort on a cut-off payload: recover text and tool names with a tolerant scan.
		for (const match of raw.matchAll(/"type":"text","content":"((?:\\.|[^"\\])*)"?/g)) {
			const text = decodeJsonStringBody(match[1]);
			if (text.trim()) {texts.push(text.trim());}
		}
		for (const match of raw.matchAll(/"type":"tool_call","id":"([^"]*)","name":"([^"]*)"/g)) {
			toolCalls.push({ id: match[1], name: match[2], argsPreview: '' });
		}
	}
	return { text: texts.join('\n\n'), toolCalls, truncated };
}

function decodeJsonStringBody(body: string): string {
	try {
		return JSON.parse(`"${body}"`) as string;
	} catch {
		return body.replace(/\\n/g, '\n').replace(/\\"/g, '"');
	}
}

function toLiveTurn(turn: MutableTurn): LiveTurn {
	return {
		index: turn.index,
		userText: turn.userText,
		startedAt: turn.startedAt,
		assistantText: turn.assistantParts.join('\n\n'),
		thinking: turn.thinkingParts.join('\n\n'),
		rounds: turn.rounds,
		tools: turn.tools,
		status: turn.status,
		completedAt: turn.completedAt,
		textTruncated: turn.textTruncated,
	};
}

function rank(status: LiveToolStatus): number {
	switch (status) {
		case 'requested': return 0;
		case 'running': return 1;
		default: return 2;
	}
}

/** Tool call ids may carry VS Code's `__vscode-N` uniqueness suffix on one side only. */
export function sameToolId(left: string, right: string): boolean {
	return left === right || stripToolIdSuffix(left) === stripToolIdSuffix(right);
}

export function stripToolIdSuffix(id: string): string {
	const marker = id.indexOf('__vscode-');
	return marker < 0 ? id : id.slice(0, marker);
}

function previewOf(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	const text = typeof value === 'string' ? value : safeStringify(value);
	return text.length > maximumArgsPreviewChars ? `${text.slice(0, maximumArgsPreviewChars)}…` : text;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '';
	}
}

function parseJsonObject(line: string): JsonObject | undefined {
	if (!line) {
		return undefined;
	}
	try {
		const value = JSON.parse(line) as unknown;
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanUserText(value: string): string {
	return value.replace(/^User:\s*/i, '').trim();
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
