import { DatabaseSync, StatementSync } from 'node:sqlite';
import { JsonObject, normalizeRequestTurn, TranscriptTurn } from './transcript';

/**
 * On-disk digest of VS Code chat session logs: one row per request holding the normalised
 * turn the dashboard shows plus the (string-capped) raw request needed to re-normalise it
 * after later mutations. Pages are plain range selects, so serving history never touches
 * the session log and holds nothing in memory beyond the rows of one page.
 *
 * The `digest_sessions` row records how far into the log the digest reflects (`indexed_offset`)
 * together with the identity of the bytes just before that offset, so an append is consumed
 * incrementally and a rewrite (VS Code compacts a log into one fresh Initial entry) is
 * detected and rebuilt.
 */

export interface DigestCursor {
	readonly ino: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly anchorHash: string | undefined;
	readonly indexedOffset: number;
}

export interface DigestSessionRow {
	readonly sessionId: string;
	readonly filePath: string;
	readonly cursor: DigestCursor;
	readonly generation: number;
	readonly revision: number;
	readonly sessionUuid: string;
	readonly customTitle: string | undefined;
	readonly inputState: JsonObject;
	readonly requestCount: number;
}

export interface TurnCaps {
	readonly assistantTextChars: number;
	readonly thinkingChars: number;
	readonly outputChars: number;
}

export const defaultTurnCaps: TurnCaps = {
	assistantTextChars: 64 * 1024,
	thinkingChars: 8 * 1024,
	outputChars: 8 * 1024,
};

export interface SessionDigestOptions {
	readonly caps?: TurnCaps;
	/** How long a write waits for another connection's transaction before failing with SQLITE_BUSY. */
	readonly busyTimeoutMs?: number;
}

/** `modelState.value` of a request VS Code will never diff again. */
const sealedModelStates = new Set([1, 2, 3]);

export class SessionDigest {
	private readonly database: DatabaseSync;
	private readonly caps: TurnCaps;
	private readonly statements: {
		readonly session: StatementSync;
		readonly upsertSession: StatementSync;
		readonly deleteSession: StatementSync;
		readonly setCursor: StatementSync;
		readonly setHeader: StatementSync;
		readonly setCount: StatementSync;
		readonly bumpRevision: StatementSync;
		readonly turns: StatementSync;
		readonly raw: StatementSync;
		readonly putTurn: StatementSync;
		readonly deleteTurnsFrom: StatementSync;
		readonly deleteTurns: StatementSync;
		readonly trimRaw: StatementSync;
		readonly requestIndex: StatementSync;
		readonly lastModelId: StatementSync;
		readonly count: StatementSync;
	};

	constructor(readonly path: string, options: SessionDigestOptions = {}) {
		this.caps = options.caps ?? defaultTurnCaps;
		this.database = new DatabaseSync(path);
		this.database.exec(`
			PRAGMA auto_vacuum = INCREMENTAL;
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))};
			CREATE TABLE IF NOT EXISTS digest_sessions (
				session_id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL,
				ino TEXT NOT NULL DEFAULT '',
				size INTEGER NOT NULL DEFAULT 0,
				mtime_ms REAL NOT NULL DEFAULT 0,
				anchor_hash TEXT,
				indexed_offset INTEGER NOT NULL DEFAULT 0,
				generation INTEGER NOT NULL DEFAULT 0,
				revision INTEGER NOT NULL DEFAULT 0,
				session_uuid TEXT NOT NULL DEFAULT '',
				custom_title TEXT,
				input_state TEXT NOT NULL DEFAULT '{}',
				request_count INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS digest_turns (
				session_id TEXT NOT NULL,
				idx INTEGER NOT NULL,
				request_id TEXT,
				model_id TEXT,
				sealed INTEGER NOT NULL DEFAULT 0,
				turn TEXT NOT NULL,
				raw TEXT NOT NULL,
				PRIMARY KEY (session_id, idx)
			) WITHOUT ROWID;
			CREATE INDEX IF NOT EXISTS digest_turns_request ON digest_turns (session_id, request_id);
		`);
		this.statements = {
			session: this.database.prepare('SELECT * FROM digest_sessions WHERE session_id = ?'),
			upsertSession: this.database.prepare(`
				INSERT INTO digest_sessions (session_id, file_path, generation, updated_at) VALUES (?, ?, 1, ?)
				ON CONFLICT (session_id) DO UPDATE SET
					file_path = excluded.file_path, ino = '', size = 0, mtime_ms = 0, anchor_hash = NULL, indexed_offset = 0,
					generation = generation + 1, revision = revision + 1, session_uuid = '', custom_title = NULL, input_state = '{}',
					request_count = 0, updated_at = excluded.updated_at`),
			deleteSession: this.database.prepare('DELETE FROM digest_sessions WHERE session_id = ?'),
			setCursor: this.database.prepare('UPDATE digest_sessions SET ino = ?, size = ?, mtime_ms = ?, anchor_hash = ?, indexed_offset = ?, updated_at = ? WHERE session_id = ?'),
			setHeader: this.database.prepare('UPDATE digest_sessions SET session_uuid = ?, custom_title = ?, input_state = ?, revision = revision + 1 WHERE session_id = ?'),
			setCount: this.database.prepare('UPDATE digest_sessions SET request_count = ?, revision = revision + 1 WHERE session_id = ?'),
			bumpRevision: this.database.prepare('UPDATE digest_sessions SET revision = revision + 1 WHERE session_id = ?'),
			turns: this.database.prepare('SELECT idx, turn FROM digest_turns WHERE session_id = ? AND idx >= ? AND idx < ? ORDER BY idx'),
			raw: this.database.prepare('SELECT raw FROM digest_turns WHERE session_id = ? AND idx = ?'),
			putTurn: this.database.prepare(`
				INSERT INTO digest_turns (session_id, idx, request_id, model_id, sealed, turn, raw) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (session_id, idx) DO UPDATE SET request_id = excluded.request_id, model_id = excluded.model_id, sealed = excluded.sealed, turn = excluded.turn, raw = excluded.raw`),
			deleteTurnsFrom: this.database.prepare('DELETE FROM digest_turns WHERE session_id = ? AND idx >= ?'),
			deleteTurns: this.database.prepare('DELETE FROM digest_turns WHERE session_id = ?'),
			trimRaw: this.database.prepare("UPDATE digest_turns SET raw = '' WHERE session_id = ? AND idx < ? AND sealed = 1 AND raw <> ''"),
			requestIndex: this.database.prepare('SELECT idx FROM digest_turns WHERE session_id = ? AND request_id = ? ORDER BY idx DESC LIMIT 1'),
			lastModelId: this.database.prepare('SELECT model_id FROM digest_turns WHERE session_id = ? AND model_id IS NOT NULL ORDER BY idx DESC LIMIT 1'),
			count: this.database.prepare('SELECT COUNT(*) AS n FROM digest_turns WHERE session_id = ?'),
		};
	}

	close(): void {
		this.database.close();
	}

	// #region reads

	session(sessionId: string): DigestSessionRow | undefined {
		const row = this.statements.session.get(sessionId) as Record<string, unknown> | undefined;
		if (!row) {
			return undefined;
		}
		let inputState: JsonObject = {};
		try {
			const parsed = JSON.parse(String(row.input_state)) as unknown;
			inputState = isObject(parsed) ? parsed : {};
		} catch {
			// A corrupt header degrades to defaults; the next rebuild rewrites it.
		}
		return {
			sessionId,
			filePath: String(row.file_path),
			cursor: {
				ino: String(row.ino),
				size: Number(row.size),
				mtimeMs: Number(row.mtime_ms),
				anchorHash: row.anchor_hash === null ? undefined : String(row.anchor_hash),
				indexedOffset: Number(row.indexed_offset),
			},
			generation: Number(row.generation),
			revision: Number(row.revision),
			sessionUuid: String(row.session_uuid),
			customTitle: row.custom_title === null ? undefined : String(row.custom_title),
			inputState,
			requestCount: Number(row.request_count),
		};
	}

	/** Turns in `[start, end)` in index order; gaps left by unparsable rows are skipped. */
	turns(sessionId: string, start: number, end: number): TranscriptTurn[] {
		if (end <= start) {
			return [];
		}
		const rows = this.statements.turns.all(sessionId, Math.max(0, start), end) as Array<{ idx: number; turn: string }>;
		const result: TranscriptTurn[] = [];
		for (const row of rows) {
			try {
				result.push(JSON.parse(row.turn) as TranscriptTurn);
			} catch {
				// Skip a corrupt row rather than fail the page.
			}
		}
		return result;
	}

	requestIndex(sessionId: string, requestId: string): number | undefined {
		const row = this.statements.requestIndex.get(sessionId, requestId) as { idx: number } | undefined;
		return row?.idx;
	}

	lastModelId(sessionId: string): string | undefined {
		const row = this.statements.lastModelId.get(sessionId) as { model_id: string } | undefined;
		return row?.model_id ?? undefined;
	}

	/** The raw request kept for re-normalisation, or `undefined` when it was trimmed or never stored. */
	rawRequest(sessionId: string, index: number): JsonObject | undefined {
		const row = this.statements.raw.get(sessionId, index) as { raw: string } | undefined;
		if (!row || row.raw === '') {
			return undefined;
		}
		try {
			const parsed = JSON.parse(row.raw) as unknown;
			return isObject(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	// #endregion

	// #region writes (used by the builder)

	begin(): void {
		this.database.exec('BEGIN IMMEDIATE');
	}

	commit(): void {
		this.database.exec('COMMIT');
	}

	rollback(): void {
		try {
			this.database.exec('ROLLBACK');
		} catch {
			// No transaction open.
		}
	}

	/** Starts a fresh generation for the session: no turns, default header, cursor at zero. */
	resetSession(sessionId: string, filePath: string): void {
		this.statements.upsertSession.run(sessionId, filePath, Date.now());
		this.statements.deleteTurns.run(sessionId);
	}

	removeSession(sessionId: string): void {
		this.statements.deleteTurns.run(sessionId);
		this.statements.deleteSession.run(sessionId);
	}

	/** Drops digests whose log is gone (chat deleted in VS Code or pruned past its 400-session cap). */
	pruneMissing(exists: (filePath: string) => boolean): number {
		const rows = this.database.prepare('SELECT session_id, file_path FROM digest_sessions').all() as Array<{ session_id: string; file_path: string }>;
		let removed = 0;
		for (const row of rows) {
			if (!exists(row.file_path)) {
				this.removeSession(row.session_id);
				removed++;
			}
		}
		if (removed > 0) {
			this.vacuum();
		}
		return removed;
	}

	setCursor(sessionId: string, cursor: DigestCursor): void {
		this.statements.setCursor.run(cursor.ino, cursor.size, cursor.mtimeMs, cursor.anchorHash ?? null, cursor.indexedOffset, Date.now(), sessionId);
	}

	setHeader(sessionId: string, header: { sessionUuid: string; customTitle: string | undefined; inputState: JsonObject }): void {
		this.statements.setHeader.run(header.sessionUuid, header.customTitle ?? null, JSON.stringify(header.inputState), sessionId);
	}

	setRequestCount(sessionId: string, count: number): void {
		this.statements.setCount.run(count, sessionId);
	}

	bumpRevision(sessionId: string): void {
		this.statements.bumpRevision.run(sessionId);
	}

	/** Normalises and stores one request at `index`; the raw object is kept for later mutations. */
	putRequest(sessionId: string, index: number, raw: JsonObject): void {
		const turn = capTurn(normalizeRequestTurn(raw, index), this.caps);
		const modelState = isObject(raw.modelState) ? raw.modelState : undefined;
		const sealed = typeof modelState?.value === 'number' && sealedModelStates.has(modelState.value) ? 1 : 0;
		this.statements.putTurn.run(
			sessionId,
			index,
			typeof raw.requestId === 'string' ? raw.requestId : null,
			typeof raw.modelId === 'string' ? raw.modelId : null,
			sealed,
			JSON.stringify(turn),
			JSON.stringify(raw),
		);
	}

	deleteRequestsFrom(sessionId: string, index: number): void {
		this.statements.deleteTurnsFrom.run(sessionId, index);
	}

	/** Drops raw JSON for sealed requests below `keepFrom`; VS Code never diffs a sealed request again. */
	trimRaw(sessionId: string, keepFrom: number): void {
		if (keepFrom > 0) {
			this.statements.trimRaw.run(sessionId, keepFrom);
		}
	}

	/** Returns freed pages to the file system; call outside a transaction. */
	vacuum(): void {
		this.database.exec('PRAGMA incremental_vacuum');
	}

	storedCount(sessionId: string): number {
		const row = this.statements.count.get(sessionId) as { n: number };
		return Number(row.n);
	}

	// #endregion
}

export function capTurn(turn: TranscriptTurn, caps: TurnCaps): TranscriptTurn {
	const activities = turn.activities.map(activity => activity.output && activity.output.length > caps.outputChars
		? { ...activity, output: truncate(activity.output, caps.outputChars), outputTruncated: true }
		: activity);
	const blocks = turn.blocks.map(block => {
		if (block.kind === 'text' && block.text.length > caps.assistantTextChars) {
			return { ...block, text: truncate(block.text, caps.assistantTextChars) };
		}
		if (block.kind === 'thinking' && block.text.length > caps.thinkingChars) {
			return { ...block, text: truncate(block.text, caps.thinkingChars) };
		}
		if (block.kind === 'activity') {
			const activity = activities.find(candidate => candidate.id === block.activity.id) ?? block.activity;
			return activity === block.activity ? block : { ...block, activity };
		}
		return block;
	});
	return {
		...turn,
		assistantText: truncate(turn.assistantText, caps.assistantTextChars),
		thinking: truncate(turn.thinking, caps.thinkingChars),
		activities,
		blocks,
	};
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
