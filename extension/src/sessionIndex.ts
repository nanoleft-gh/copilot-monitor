import { DatabaseSync } from 'node:sqlite';
import type { ChatPermissionLevel } from './protocol';

/**
 * Reads the chat session list VS Code maintains in its state database
 * (`chat.ChatSessionStore.index`). This is the cheapest possible source for the session
 * list: one small row, no session file is touched.
 *
 * The database is opened read-only and closed immediately after each read so the
 * connection never blocks VS Code's WAL checkpoints.
 */

export const sessionIndexStorageKey = 'chat.ChatSessionStore.index';

export type IndexResponseState = 'complete' | 'cancelled' | 'failed' | 'unknown';

export interface SessionIndexEntry {
	readonly sessionId: string;
	readonly title: string;
	readonly lastMessageDate: number;
	readonly created?: number;
	readonly lastRequestStarted?: number;
	readonly lastRequestEnded?: number;
	readonly lastResponseState: IndexResponseState;
	readonly permissionLevel: ChatPermissionLevel;
	readonly hasPendingEdits: boolean;
	readonly isEmpty: boolean;
	readonly isExternal: boolean;
}

export interface SessionIndexSnapshot {
	readonly entries: readonly SessionIndexEntry[];
	/** Cheap identity of the raw stored value, for change detection. */
	readonly revision: string;
}

/**
 * Returns `undefined` only when the database cannot be read right now (missing, locked,
 * no table); a readable database without an index yields an empty snapshot.
 */
export function readSessionIndex(databasePath: string): SessionIndexSnapshot | undefined {
	let raw: string | undefined;
	try {
		const database = new DatabaseSync(databasePath, { readOnly: true });
		try {
			const row = database
				.prepare('SELECT value FROM ItemTable WHERE key = ?')
				.get(sessionIndexStorageKey) as { value?: unknown } | undefined;
			raw = typeof row?.value === 'string' ? row.value : undefined;
		} finally {
			database.close();
		}
	} catch {
		return undefined;
	}
	if (raw === undefined) {
		return { entries: [], revision: 'empty' };
	}
	return parseSessionIndex(raw) ?? { entries: [], revision: `invalid:${raw.length}:${hashString(raw)}` };
}

export function parseSessionIndex(raw: string): SessionIndexSnapshot | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
		return undefined;
	}
	const entries: SessionIndexEntry[] = [];
	for (const candidate of Object.values(value.entries)) {
		const entry = toEntry(candidate);
		if (entry) {
			entries.push(entry);
		}
	}
	entries.sort((left, right) => right.lastMessageDate - left.lastMessageDate);
	return { entries, revision: `${raw.length}:${hashString(raw)}` };
}

function toEntry(candidate: unknown): SessionIndexEntry | undefined {
	if (!isRecord(candidate)) {
		return undefined;
	}
	const sessionId = candidate.sessionId;
	const title = candidate.title;
	const lastMessageDate = candidate.lastMessageDate;
	if (typeof sessionId !== 'string' || typeof title !== 'string' || typeof lastMessageDate !== 'number') {
		return undefined;
	}
	const timing = isRecord(candidate.timing) ? candidate.timing : undefined;
	return {
		sessionId,
		title,
		lastMessageDate,
		created: numberValue(timing?.created),
		lastRequestStarted: numberValue(timing?.lastRequestStarted),
		lastRequestEnded: numberValue(timing?.lastRequestEnded),
		lastResponseState: toResponseState(candidate.lastResponseState),
		permissionLevel: toPermissionLevel(candidate.permissionLevel),
		hasPendingEdits: candidate.hasPendingEdits === true,
		isEmpty: candidate.isEmpty === true,
		isExternal: candidate.isExternal === true,
	};
}

// Mirrors VS Code's ResponseModelState enum; Pending/NeedsInput are persisted as Cancelled.
function toResponseState(value: unknown): IndexResponseState {
	switch (value) {
		case 1: return 'complete';
		case 2: return 'cancelled';
		case 3: return 'failed';
		default: return 'unknown';
	}
}

function toPermissionLevel(value: unknown): ChatPermissionLevel {
	return value === 'autoApprove' || value === 'autopilot' ? value : 'default';
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
