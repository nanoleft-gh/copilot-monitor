import { parseSessionModelState } from './modelCatalog';
import type { ChatPermissionLevel, SessionModelState } from './protocol';
import { JsonObject, normalizeRequestTurn, TranscriptTurn } from './transcript';

/**
 * Sparse, incremental projection of a VS Code chat session mutation log
 * (`chatSessions/<id>.jsonl`). Applies entries with the exact semantics of VS Code's
 * `ObjectMutationLog._applySet/_applyPush` but materialises only what the monitor
 * displays: title, input state, and per-request turns.
 *
 * Memory model: raw request objects are retained only for the newest `retainedRawTurns`
 * requests so they can be re-normalised after streaming mutations; older requests are
 * compacted to a bounded `TranscriptTurn` and their raw object is dropped.
 */

export interface SessionLogProjectionOptions {
	readonly retainedRawTurns?: number;
	readonly compactedAssistantTextChars?: number;
	readonly compactedThinkingChars?: number;
	readonly compactedOutputChars?: number;
}

export interface SessionLogSnapshot {
	readonly sessionId: string;
	readonly title: string | undefined;
	readonly turnCount: number;
	readonly status: 'idle' | 'working';
	readonly model: SessionModelState | undefined;
	readonly permissionLevel: ChatPermissionLevel;
	/** True once an Initial entry (or a skipped oversized one) has been seen. */
	readonly initialised: boolean;
	/** The Initial entry was too large to parse; only later mutations are reflected. */
	readonly oversized: boolean;
	/** A mutation touched a compacted request; a full replay is needed for exactness. */
	readonly needsFullReload: boolean;
}

interface Slot {
	raw: JsonObject | undefined;
	turn: TranscriptTurn | undefined;
}

const defaultRetainedRawTurns = 40;
const defaultCompactedAssistantTextChars = 64 * 1024;
const defaultCompactedThinkingChars = 4 * 1024;
const defaultCompactedOutputChars = 2 * 1024;

export class SessionLogProjection {
	private sessionId = '';
	private customTitle: string | undefined;
	private inputState: JsonObject = {};
	private lastModelId: string | undefined;
	private slots: Slot[] = [];
	private initialised = false;
	private oversized = false;
	private needsFullReload = false;

	constructor(private readonly options: SessionLogProjectionOptions = {}) {}

	reset(): void {
		this.sessionId = '';
		this.customTitle = undefined;
		this.inputState = {};
		this.lastModelId = undefined;
		this.slots = [];
		this.initialised = false;
		this.oversized = false;
		this.needsFullReload = false;
	}

	/** The tailer skipped the Initial entry because it exceeded the line budget. */
	markInitialSkipped(): void {
		this.reset();
		this.initialised = true;
		this.oversized = true;
	}

	/**
	 * Apply one JSONL entry. Returns whether anything visible changed.
	 * Throws on malformed JSON so the caller can resynchronise the tailer.
	 */
	applyLine(line: string): boolean {
		const entry = JSON.parse(line) as JsonObject;
		const kind = entry.kind;
		if (kind === 0) {
			this.applyInitial(entry.v);
			return true;
		}
		if (!this.initialised) {
			throw new Error('Chat session log is missing an initial object entry.');
		}
		const path = Array.isArray(entry.k) ? entry.k as readonly (string | number)[] : undefined;
		if (!path || path.length === 0) {
			return false;
		}
		switch (kind) {
			case 1:
				return this.applySet(path, entry.v);
			case 3:
				return this.applySet(path, undefined);
			case 2:
				return this.applyPush(path, Array.isArray(entry.v) ? entry.v : undefined, typeof entry.i === 'number' ? entry.i : undefined);
			default:
				throw new Error('Unsupported chat session log entry.');
		}
	}

	get snapshot(): SessionLogSnapshot {
		const stateLike: JsonObject = {
			inputState: this.inputState,
			requests: this.lastModelId ? [{ modelId: this.lastModelId }] : [],
		};
		return {
			sessionId: this.sessionId,
			title: this.customTitle,
			turnCount: this.slots.length,
			status: this.hasWorkingTurn() ? 'working' : 'idle',
			model: parseSessionModelState(stateLike),
			permissionLevel: parsePermissionLevel(this.inputState),
			initialised: this.initialised,
			oversized: this.oversized,
			needsFullReload: this.needsFullReload,
		};
	}

	/** Turns in `[start, end)`; compacted turns for old requests, exact turns for retained ones. */
	turns(start: number, end: number): TranscriptTurn[] {
		const result: TranscriptTurn[] = [];
		const from = Math.max(0, start);
		const to = Math.min(this.slots.length, end);
		for (let index = from; index < to; index++) {
			const turn = this.turnAt(index);
			if (turn) {
				result.push(turn);
			}
		}
		return result;
	}

	/** The newest `count` turns. */
	tail(count: number): { turns: TranscriptTurn[]; start: number } {
		const start = Math.max(0, this.slots.length - count);
		return { turns: this.turns(start, this.slots.length), start };
	}

	private applyInitial(value: unknown): void {
		this.reset();
		this.initialised = true;
		if (!isObject(value)) {
			return;
		}
		this.sessionId = stringValue(value.sessionId) ?? '';
		this.customTitle = stringValue(value.customTitle)?.trim() || undefined;
		this.inputState = isObject(value.inputState) ? value.inputState : {};
		const requests = Array.isArray(value.requests) ? value.requests : [];
		this.slots = requests.map(request => ({ raw: isObject(request) ? request : {}, turn: undefined }));
		this.compactOldSlots();
		this.updateLastModelId();
	}

	private applySet(path: readonly (string | number)[], value: unknown): boolean {
		const head = path[0];
		if (head === 'customTitle') {
			this.customTitle = typeof value === 'string' ? value.trim() || undefined : undefined;
			return true;
		}
		if (head === 'inputState') {
			if (path.length === 1) {
				this.inputState = isObject(value) ? value : {};
			} else {
				writePath(this.inputState, path.slice(1), value);
			}
			return true;
		}
		if (head === 'sessionId' && typeof value === 'string') {
			this.sessionId = value;
			return true;
		}
		if (head !== 'requests') {
			return false;
		}
		if (path.length === 1) {
			const requests = Array.isArray(value) ? value : [];
			this.slots = requests.map(request => ({ raw: isObject(request) ? request : {}, turn: undefined }));
			this.compactOldSlots();
			this.updateLastModelId();
			return true;
		}
		const index = toIndex(path[1]);
		if (index === undefined) {
			return false;
		}
		if (path.length === 2) {
			this.ensureSlot(index);
			this.slots[index] = { raw: isObject(value) ? value : {}, turn: undefined };
			this.compactOldSlots();
			this.updateLastModelId();
			return true;
		}
		const slot = this.ensureSlot(index);
		if (!slot.raw) {
			this.noteCompactedMutation(path[2]);
			return false;
		}
		writePath(slot.raw, path.slice(2), value);
		slot.turn = undefined;
		if (path[2] === 'modelId') {
			this.updateLastModelId();
		}
		return isVisibleRequestField(path[2]);
	}

	private applyPush(path: readonly (string | number)[], values: readonly unknown[] | undefined, startIndex: number | undefined): boolean {
		const head = path[0];
		if (head === 'inputState') {
			pushPath(this.inputState, path.slice(1), values, startIndex);
			return true;
		}
		if (head !== 'requests') {
			return false;
		}
		if (path.length === 1) {
			if (startIndex !== undefined) {
				this.slots.length = Math.min(this.slots.length, Math.max(0, startIndex));
			}
			for (const request of values ?? []) {
				this.slots.push({ raw: isObject(request) ? request : {}, turn: undefined });
			}
			this.compactOldSlots();
			this.updateLastModelId();
			return true;
		}
		const index = toIndex(path[1]);
		if (index === undefined || path.length < 3) {
			return false;
		}
		const slot = this.ensureSlot(index);
		if (!slot.raw) {
			this.noteCompactedMutation(path[2]);
			return false;
		}
		pushPath(slot.raw, path.slice(2), values, startIndex);
		slot.turn = undefined;
		return isVisibleRequestField(path[2]);
	}

	private ensureSlot(index: number): Slot {
		while (this.slots.length <= index) {
			this.slots.push({ raw: {}, turn: undefined });
		}
		return this.slots[index];
	}

	private noteCompactedMutation(field: string | number): void {
		if (isVisibleRequestField(field)) {
			this.needsFullReload = true;
		}
	}

	private turnAt(index: number): TranscriptTurn | undefined {
		const slot = this.slots[index];
		if (!slot) {
			return undefined;
		}
		if (!slot.turn) {
			slot.turn = slot.raw ? normalizeRequestTurn(slot.raw, index) : undefined;
		}
		return slot.turn;
	}

	private hasWorkingTurn(): boolean {
		// Only the newest request can be in flight; older ones are sealed by VS Code.
		const last = this.slots.length - 1;
		return last >= 0 && this.turnAt(last)?.status === 'working';
	}

	private compactOldSlots(): void {
		const retained = this.options.retainedRawTurns ?? defaultRetainedRawTurns;
		const boundary = this.slots.length - retained;
		for (let index = 0; index < boundary; index++) {
			const slot = this.slots[index];
			if (!slot.raw) {
				continue;
			}
			const turn = slot.turn ?? normalizeRequestTurn(slot.raw, index);
			slot.turn = this.compactTurn(turn);
			slot.raw = undefined;
		}
	}

	private compactTurn(turn: TranscriptTurn): TranscriptTurn {
		const assistantChars = this.options.compactedAssistantTextChars ?? defaultCompactedAssistantTextChars;
		const thinkingChars = this.options.compactedThinkingChars ?? defaultCompactedThinkingChars;
		const outputChars = this.options.compactedOutputChars ?? defaultCompactedOutputChars;
		const activities = turn.activities.map(activity => activity.output && activity.output.length > outputChars
			? { ...activity, output: truncate(activity.output, outputChars), outputTruncated: true }
			: activity);
		const blocks = turn.blocks.map(block => {
			if (block.kind === 'text' && block.text.length > assistantChars) {
				return { ...block, text: truncate(block.text, assistantChars) };
			}
			if (block.kind === 'thinking' && block.text.length > thinkingChars) {
				return { ...block, text: truncate(block.text, thinkingChars) };
			}
			if (block.kind === 'activity') {
				const activity = activities.find(candidate => candidate.id === block.activity.id) ?? block.activity;
				return { ...block, activity };
			}
			return block;
		});
		return {
			...turn,
			assistantText: truncate(turn.assistantText, assistantChars),
			thinking: truncate(turn.thinking, thinkingChars),
			activities,
			blocks,
		};
	}

	private updateLastModelId(): void {
		for (let index = this.slots.length - 1; index >= 0; index--) {
			const raw = this.slots[index].raw;
			const modelId = raw ? stringValue(raw.modelId) : undefined;
			if (modelId) {
				this.lastModelId = modelId;
				return;
			}
			if (!raw) {
				break;
			}
		}
	}
}

const visibleRequestFields = new Set(['response', 'modelState', 'message', 'result', 'timestamp', 'requestId']);

function isVisibleRequestField(field: string | number): boolean {
	return visibleRequestFields.has(String(field));
}

function parsePermissionLevel(inputState: JsonObject): ChatPermissionLevel {
	const level = inputState.permissionLevel;
	return level === 'autoApprove' || level === 'autopilot' ? level : 'default';
}

function writePath(root: JsonObject, path: readonly (string | number)[], value: unknown): void {
	if (path.length === 0) {
		return;
	}
	let current: JsonObject | unknown[] = root;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index];
		let next = readContainer(current, key);
		if (!isObject(next) && !Array.isArray(next)) {
			next = typeof path[index + 1] === 'number' ? [] : {};
			writeContainer(current, key, next);
		}
		current = next as JsonObject | unknown[];
	}
	writeContainer(current, path[path.length - 1], value);
}

function pushPath(root: JsonObject, path: readonly (string | number)[], values: readonly unknown[] | undefined, startIndex: number | undefined): void {
	if (path.length === 0) {
		return;
	}
	let current: JsonObject | unknown[] = root;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index];
		let next = readContainer(current, key);
		if (!isObject(next) && !Array.isArray(next)) {
			next = typeof path[index + 1] === 'number' ? [] : {};
			writeContainer(current, key, next);
		}
		current = next as JsonObject | unknown[];
	}
	const key = path[path.length - 1];
	const existing = readContainer(current, key);
	const array = Array.isArray(existing) ? existing : [];
	if (startIndex !== undefined) {
		array.length = Math.max(0, Math.min(array.length, startIndex));
	}
	if (values?.length) {
		array.push(...values);
	}
	writeContainer(current, key, array);
}

function readContainer(container: JsonObject | unknown[], key: string | number): unknown {
	return Array.isArray(container) ? container[Number(key)] : container[String(key)];
}

function writeContainer(container: JsonObject | unknown[], key: string | number, value: unknown): void {
	if (Array.isArray(container)) {
		container[Number(key)] = value;
	} else if (value === undefined) {
		delete container[String(key)];
	} else {
		container[String(key)] = value;
	}
}

function toIndex(value: string | number): number | undefined {
	const index = typeof value === 'number' ? value : Number(value);
	return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
