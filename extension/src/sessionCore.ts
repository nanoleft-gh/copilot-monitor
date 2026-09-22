import * as fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DirectoryEvent, DirectoryWatcher } from './directoryWatcher';
import { LineTailer } from './lineTailer';
import { mergeLiveTurns } from './liveMerge';
import { LiveTurnAccumulator, relevantDebugLogTypes, sniffDebugLogType } from './liveTurns';
import { parseSessionModelState } from './modelCatalog';
import type { ActiveSessionState, ChatPermissionLevel } from './protocol';
import { SessionDigest } from './sessionDigest';
import type { DigestSyncResult } from './sessionDigestBuilder';
import { syncDigestForSession } from './sessionDigestClient';
import { readSessionHead } from './sessionHeadTitle';
import { readSessionIndex, SessionIndexEntry } from './sessionIndex';
import { localSessionResource } from './sessionResource';
import { findTailStart } from './tailScan';
import type { JsonObject, TranscriptTurn } from './transcript';

/**
 * Event-driven model of one VS Code window's chat sessions.
 *
 * The session *list* is metadata only: `state.vscdb` (title, dates, last state), `fs.stat`
 * of each log, and directory events on the live logs as a "working" signal. No session log
 * is parsed for it.
 *
 * A session a client *watches* additionally gets: its on-disk digest brought up to date
 * (only bytes appended since last time are read; a rewrite is detected and rebuilt in a
 * worker), the newest `liveWindowTurns` turns from that digest, and live overlays tailed from
 * the newest turns of Copilot's transcript and debug log. Everything else is paged from the
 * digest on demand. Watching ends a grace period after the last client stops watching, so a
 * phone going to the background briefly does not redo the attach.
 *
 * Nothing runs while no viewer is connected. There are no periodic timers; the only timers
 * are event debounces, the one-shot "activity aged out" transition, and the unwatch grace.
 */

export interface SessionCorePaths {
	readonly sessionDirectories: readonly string[];
	readonly transcriptDirectories: readonly string[];
	readonly debugLogDirectories: readonly string[];
	readonly indexDatabasePath: string;
	/** SQLite file holding the per-session digests; created on first use. */
	readonly digestDatabasePath: string;
}

export interface SessionCoreOptions {
	readonly paths: SessionCorePaths;
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	/** Newest persisted turns kept in memory and streamed for a watched session. */
	readonly liveWindowTurns?: number;
	readonly fileDebounceMs?: number;
	readonly indexDebounceMs?: number;
	/** How long a transcript/debug-log write keeps a non-watched session marked as working. */
	readonly activityWindowMs?: number;
	/** How long a session stays attached after its last watcher left. */
	readonly detachGraceMs?: number;
	readonly maximumWatchedSessions?: number;
	/** Bytes read back from the end of a live log on attach. */
	readonly liveLookbackBytes?: number;
	/** Test hook: replaces the inline/worker digest sync. */
	readonly syncDigest?: (digest: SessionDigest, sessionId: string, filePath: string, signal: AbortSignal) => Promise<DigestSyncResult>;
}

export interface SessionCoreState {
	readonly sessions: readonly ActiveSessionState[];
	readonly activeSessionResource: string | undefined;
	readonly error: string | undefined;
}

export interface HistoryPage {
	readonly turns: readonly TranscriptTurn[];
	readonly totalCount: number;
	readonly start: number;
	readonly end: number;
	readonly hasEarlier: boolean;
}

interface SessionRecord {
	readonly sessionId: string;
	readonly resource: string;
	filePath: string;
	size: number;
	mtimeMs: number;
	index: SessionIndexEntry | undefined;
	fallbackTitle: string | undefined;
	/** Whether the log head showed any request, for sessions VS Code has not indexed yet. */
	fallbackHasRequests: boolean | undefined;
	fallbackTitleKey: string | undefined;
	lastActivityAt: number | undefined;
}

interface DigestView {
	status: 'loading' | 'ready' | 'oversized' | 'error';
	requestCount: number;
	generation: number;
	customTitle: string | undefined;
	inputState: JsonObject;
	lastModelId: string | undefined;
	error: string | undefined;
}

interface WatchedTail {
	readonly sessionId: string;
	readonly filePath: string;
	readonly digest: DigestView;
	liveWindow: TranscriptTurn[];
	readonly transcript: LiveTurnAccumulator;
	readonly transcriptTailer: LineTailer;
	readonly debug: LiveTurnAccumulator;
	readonly debugTailer: LineTailer;
	readonly debugWatcher: DirectoryWatcher;
	readonly abort: AbortController;
	revision: number;
	/** False until the first pass over the live logs finished; replayed lines are not activity. */
	liveReplayed: boolean;
	syncing: Promise<void> | undefined;
	syncRequested: boolean;
	syncFailures: number;
	detachTimer: NodeJS.Timeout | undefined;
}

const defaultLiveWindowTurns = 8;
const defaultFileDebounceMs = 50;
const defaultIndexDebounceMs = 400;
const defaultActivityWindowMs = 15_000;
const defaultDetachGraceMs = 60_000;
const defaultMaximumWatchedSessions = 3;
const defaultLiveLookbackBytes = 4 * 1024 * 1024;
const fallbackTitleBytes = 64 * 1024;
const maximumSyncFailures = 3;
const transcriptTurnMarker = '"type":"user.message"';
const debugTurnMarker = '"type":"user_message"';

export class SessionCore {
	private readonly listeners = new Set<() => void>();
	private readonly records = new Map<string, SessionRecord>();
	private readonly watchers: DirectoryWatcher[] = [];
	private readonly debounces = new Map<string, NodeJS.Timeout>();
	private readonly tails = new Map<string, WatchedTail>();
	/** Sessions clients asked for, in the order they were asked; applied while viewers exist. */
	private desiredWatched: string[] = [];
	private activeSessionId: string | undefined;
	private viewerCount = 0;
	private teardownTimer: NodeJS.Timeout | undefined;
	private indexRevision: string | undefined;
	private indexEntries = new Map<string, SessionIndexEntry>();
	private activityTimer: NodeJS.Timeout | undefined;
	private emitScheduled = false;
	private error: string | undefined;
	private disposed = false;
	private listRefresh: Promise<void> | undefined;
	private digestStore: SessionDigest | undefined;

	constructor(private readonly options: SessionCoreOptions) {}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	get viewers(): number {
		return this.viewerCount;
	}

	get activeSession(): string | undefined {
		return this.activeSessionId;
	}

	/** Sessions currently attached (including those in their unwatch grace period). */
	get watchedSessions(): readonly string[] {
		return [...this.tails.keys()];
	}

	/** Viewers gate all work. 0 → tear everything down after the grace; >0 → attach watchers and refresh. */
	async setViewerCount(count: number): Promise<void> {
		if (this.disposed) {
			return;
		}
		const hadViewers = this.viewerCount > 0;
		this.viewerCount = count;
		if (count > 0) {
			this.clearTeardown();
			if (!hadViewers && this.watchers.length === 0) {
				this.attachWatchers();
				await this.refreshAll();
			}
			this.reconcileWatched();
		} else if (hadViewers) {
			this.scheduleTeardown();
		}
	}

	/** The sessions clients are looking at right now; only these are tailed and carry turns. */
	setWatched(sessionIds: readonly string[]): void {
		if (this.disposed) {
			return;
		}
		this.desiredWatched = [...new Set(sessionIds)];
		if (this.viewerCount > 0) {
			this.reconcileWatched();
		}
	}

	/** Marks the session VS Code (or the dashboard) is focused on; does not attach anything. */
	async selectSession(sessionId: string): Promise<void> {
		if (this.disposed || this.activeSessionId === sessionId) {
			return;
		}
		this.activeSessionId = sessionId;
		this.scheduleEmit();
	}

	/** Re-read the session's files now (after the monitor itself appended to them). */
	async pokeSession(sessionId: string): Promise<void> {
		await this.refreshSessionList(`${sessionId}.jsonl`);
		const tail = this.tails.get(sessionId);
		if (tail) {
			await Promise.all([this.syncDigest(tail), this.pokeLive(tail, 'all')]);
		}
	}

	async refreshAll(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.refreshIndex() === 'unavailable') {
			this.scheduleIndexRefresh(1);
		}
		await this.refreshSessionList(undefined);
		if (!this.activeSessionId) {
			const records = this.orderedRecords();
			this.activeSessionId = (records.find(record => this.isEmpty(record) !== true) ?? records[0])?.sessionId;
		}
		this.scheduleEmit();
	}

	getState(): SessionCoreState {
		const now = this.now();
		const sessions = this.orderedRecords().map(record => {
			const tail = this.tails.get(record.sessionId);
			return tail ? this.buildWatchedState(record, tail, now) : this.buildSummaryState(record, now);
		});
		return {
			sessions,
			activeSessionResource: this.activeSessionId ? localSessionResource(this.activeSessionId) : undefined,
			error: this.error,
		};
	}

	/** Absolute index of a request in a digested session. */
	requestIndexOf(sessionId: string, requestId: string): number | undefined {
		return this.digestStore?.requestIndex(sessionId, requestId);
	}

	/**
	 * Pages persisted history out of the digest. Available for watched sessions and for any
	 * session whose digest still matches the log on disk.
	 */
	historyPage(sessionId: string, before: number, limit: number): HistoryPage | undefined {
		const digest = this.digestStore;
		const record = this.records.get(sessionId);
		if (!digest || !record) {
			return undefined;
		}
		const tail = this.tails.get(sessionId);
		if (tail && tail.digest.status !== 'ready') {
			return undefined;
		}
		const row = digest.session(sessionId);
		if (!row || row.filePath !== record.filePath) {
			return undefined;
		}
		// The digest records a bigint (whole-ms) mtime; the record holds the float form.
		if (!tail && (row.cursor.size !== record.size || Math.abs(row.cursor.mtimeMs - record.mtimeMs) >= 1)) {
			return undefined;
		}
		const total = row.requestCount;
		const end = Math.max(0, Math.min(Math.floor(before), total));
		const start = Math.max(0, end - Math.max(1, Math.min(Math.floor(limit), 100)));
		return { turns: digest.turns(sessionId, start, end), totalCount: total, start, end, hasEarlier: start > 0 };
	}

	sessionFile(sessionId: string): { filePath: string; size: number; mtimeMs: number } | undefined {
		const record = this.records.get(sessionId);
		return record ? { filePath: record.filePath, size: record.size, mtimeMs: record.mtimeMs } : undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.clearTeardown();
		this.detachEverything();
		this.listeners.clear();
		this.digestStore?.close();
		this.digestStore = undefined;
	}

	// #region watchers

	private attachWatchers(): void {
		for (const directory of this.options.paths.sessionDirectories) {
			this.addWatcher(directory, event => this.onSessionDirectoryEvent(directory, event));
		}
		for (const directory of this.options.paths.transcriptDirectories) {
			this.addWatcher(directory, event => this.onTranscriptDirectoryEvent(event));
		}
		this.addWatcher(path.dirname(this.options.paths.indexDatabasePath), event => this.onIndexDirectoryEvent(event));
	}

	private addWatcher(directory: string, listener: (event: DirectoryEvent) => void): void {
		const watcher = new DirectoryWatcher(directory, event => {
			if (!this.disposed && this.watchers.includes(watcher)) {
				listener(event);
			}
		});
		watcher.start();
		this.watchers.push(watcher);
	}

	private onSessionDirectoryEvent(directory: string, event: DirectoryEvent): void {
		const debounceMs = this.options.fileDebounceMs ?? defaultFileDebounceMs;
		if (event.type === 'reconcile') {
			this.debounce('list', () => void this.refreshSessionList(undefined), debounceMs);
			for (const tail of this.tails.values()) {
				this.debounce(`digest:${tail.sessionId}`, () => void this.syncDigest(tail), debounceMs);
			}
			return;
		}
		const name = event.name;
		if (name && !name.endsWith('.jsonl')) {
			return;
		}
		if (name) {
			const tail = this.tails.get(name.slice(0, -'.jsonl'.length));
			if (tail && path.join(directory, name) === tail.filePath) {
				this.debounce(`digest:${tail.sessionId}`, () => void this.syncDigest(tail), debounceMs);
			}
		}
		this.debounce(`list:${name ?? '*'}`, () => void this.refreshSessionList(name), debounceMs);
	}

	private onTranscriptDirectoryEvent(event: DirectoryEvent): void {
		const debounceMs = this.options.fileDebounceMs ?? defaultFileDebounceMs;
		if (event.type === 'reconcile') {
			for (const tail of this.tails.values()) {
				this.debounce(`transcript:${tail.sessionId}`, () => void this.pokeLive(tail, 'transcript'), debounceMs);
			}
			return;
		}
		const name = event.name;
		if (!name || !name.endsWith('.jsonl')) {
			return;
		}
		const sessionId = name.slice(0, -'.jsonl'.length);
		this.noteActivity(sessionId);
		const tail = this.tails.get(sessionId);
		if (tail) {
			this.debounce(`transcript:${sessionId}`, () => void this.pokeLive(tail, 'transcript'), debounceMs);
		}
	}

	private onIndexDirectoryEvent(event: DirectoryEvent): void {
		const base = path.basename(this.options.paths.indexDatabasePath);
		if (event.type === 'change' && event.name && !event.name.startsWith(base)) {
			return;
		}
		this.scheduleIndexRefresh(0);
	}

	/** The database may be locked mid-write; retry a few times with growing delays. */
	private scheduleIndexRefresh(attempt: number): void {
		const delay = (this.options.indexDebounceMs ?? defaultIndexDebounceMs) * (attempt + 1);
		this.debounce('index', () => {
			const result = this.refreshIndex();
			if (result === 'changed') {
				this.scheduleEmit();
			} else if (result === 'unavailable' && attempt < 4) {
				this.scheduleIndexRefresh(attempt + 1);
			}
		}, delay);
	}

	private debounce(key: string, action: () => void, delayMs: number): void {
		const existing = this.debounces.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.debounces.delete(key);
			if (!this.disposed) {
				action();
			}
		}, delayMs);
		timer.unref();
		this.debounces.set(key, timer);
	}

	private clearDebounce(key: string): void {
		const timer = this.debounces.get(key);
		if (timer) {
			clearTimeout(timer);
			this.debounces.delete(key);
		}
	}

	private scheduleTeardown(): void {
		const grace = this.options.detachGraceMs ?? defaultDetachGraceMs;
		if (grace <= 0) {
			this.detachEverything();
			return;
		}
		this.clearTeardown();
		this.teardownTimer = setTimeout(() => {
			this.teardownTimer = undefined;
			if (!this.disposed && this.viewerCount === 0) {
				this.detachEverything();
			}
		}, grace);
		this.teardownTimer.unref();
	}

	private clearTeardown(): void {
		if (this.teardownTimer) {
			clearTimeout(this.teardownTimer);
			this.teardownTimer = undefined;
		}
	}

	private detachEverything(): void {
		for (const watcher of this.watchers.splice(0)) {
			watcher.dispose();
		}
		for (const timer of this.debounces.values()) {
			clearTimeout(timer);
		}
		this.debounces.clear();
		if (this.activityTimer) {
			clearTimeout(this.activityTimer);
			this.activityTimer = undefined;
		}
		for (const tail of [...this.tails.values()]) {
			this.detach(tail);
		}
	}

	// #endregion

	// #region session list

	private refreshIndex(): 'changed' | 'unchanged' | 'unavailable' {
		const snapshot = readSessionIndex(this.options.paths.indexDatabasePath);
		if (!snapshot) {
			return 'unavailable';
		}
		if (snapshot.revision === this.indexRevision) {
			return 'unchanged';
		}
		this.indexRevision = snapshot.revision;
		this.indexEntries = new Map(snapshot.entries.map(entry => [entry.sessionId, entry] as const));
		this.applyIndexToRecords();
		return 'changed';
	}

	private refreshSessionList(onlyName: string | undefined): Promise<void> {
		// Serialise refreshes so a full listing and a single-file update cannot interleave.
		const run = async () => {
			try {
				if (onlyName) {
					await this.refreshOneFile(onlyName);
				} else {
					await this.refreshAllFiles();
				}
				this.error = undefined;
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
			this.scheduleEmit();
		};
		this.listRefresh = (this.listRefresh ?? Promise.resolve()).then(run, run);
		return this.listRefresh;
	}

	private async refreshAllFiles(): Promise<void> {
		const present = new Set<string>();
		for (const directory of this.options.paths.sessionDirectories) {
			let names: string[];
			try {
				names = await fs.readdir(directory);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith('.jsonl')) {
					continue;
				}
				present.add(name.slice(0, -'.jsonl'.length));
				await this.upsertRecord(path.join(directory, name));
			}
		}
		for (const sessionId of [...this.records.keys()]) {
			if (!present.has(sessionId)) {
				this.records.delete(sessionId);
			}
		}
		this.applyIndexToRecords();
	}

	private async refreshOneFile(name: string): Promise<void> {
		const sessionId = name.slice(0, -'.jsonl'.length);
		for (const directory of this.options.paths.sessionDirectories) {
			const filePath = path.join(directory, name);
			const updated = await this.upsertRecord(filePath);
			if (updated) {
				this.applyIndexToRecords();
				return;
			}
		}
		this.records.delete(sessionId);
	}

	private async upsertRecord(filePath: string): Promise<boolean> {
		let stat;
		try {
			stat = await fs.stat(filePath);
		} catch {
			return false;
		}
		const sessionId = path.basename(filePath, '.jsonl');
		let record = this.records.get(sessionId);
		if (!record) {
			record = {
				sessionId,
				resource: localSessionResource(sessionId),
				filePath,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				index: undefined,
				fallbackTitle: undefined,
				fallbackHasRequests: undefined,
				fallbackTitleKey: undefined,
				lastActivityAt: undefined,
			};
			this.records.set(sessionId, record);
		} else {
			record.filePath = filePath;
			record.size = stat.size;
			record.mtimeMs = stat.mtimeMs;
		}
		if (!record.index) {
			await this.ensureFallbackTitle(record);
		}
		return true;
	}

	private applyIndexToRecords(): void {
		for (const record of this.records.values()) {
			record.index = this.indexEntries.get(record.sessionId);
		}
	}

	private async ensureFallbackTitle(record: SessionRecord): Promise<void> {
		const key = `${record.size}:${record.mtimeMs}`;
		if (record.fallbackTitleKey === key) {
			return;
		}
		record.fallbackTitleKey = key;
		try {
			const head = await readSessionHead(record.filePath, fallbackTitleBytes);
			record.fallbackTitle = head.title;
			record.fallbackHasRequests = head.hasRequests;
		} catch {
			record.fallbackTitle = undefined;
			record.fallbackHasRequests = undefined;
		}
	}

	/** VS Code's index is authoritative; a not-yet-indexed session falls back to its log head. */
	private isEmpty(record: SessionRecord): boolean | undefined {
		if (record.index) {
			return record.index.isEmpty;
		}
		return record.fallbackHasRequests === undefined ? undefined : !record.fallbackHasRequests;
	}

	private orderedRecords(): SessionRecord[] {
		return [...this.records.values()].sort((left, right) => this.updatedAt(right) - this.updatedAt(left));
	}

	private updatedAt(record: SessionRecord): number {
		return Math.max(record.index?.lastMessageDate ?? 0, record.mtimeMs, record.lastActivityAt ?? 0);
	}

	private noteActivity(sessionId: string): void {
		const record = this.records.get(sessionId);
		if (!record) {
			return;
		}
		record.lastActivityAt = this.now();
		this.scheduleEmit();
		this.scheduleActivityDecay();
	}

	/** One-shot timer that flips "working" back to "idle" once no writes arrived for the window. */
	private scheduleActivityDecay(): void {
		if (this.activityTimer) {
			return;
		}
		const window = this.options.activityWindowMs ?? defaultActivityWindowMs;
		this.activityTimer = setTimeout(() => {
			this.activityTimer = undefined;
			if (this.disposed || this.viewerCount === 0) {
				return;
			}
			const now = this.now();
			const stillActive = [...this.records.values()].some(record => record.lastActivityAt !== undefined && now - record.lastActivityAt < window);
			this.scheduleEmit();
			if (stillActive) {
				this.scheduleActivityDecay();
			}
		}, window + 50);
		this.activityTimer.unref();
	}

	// #endregion

	// #region watched sessions

	private reconcileWatched(): void {
		const limit = Math.max(1, this.options.maximumWatchedSessions ?? defaultMaximumWatchedSessions);
		const wanted = new Set(this.desiredWatched.slice(-limit));
		for (const tail of this.tails.values()) {
			if (wanted.has(tail.sessionId)) {
				this.cancelDetach(tail);
			} else {
				this.scheduleDetach(tail);
			}
		}
		for (const sessionId of wanted) {
			if (!this.tails.has(sessionId)) {
				this.attach(sessionId);
			}
		}
	}

	private attach(sessionId: string): void {
		const record = this.records.get(sessionId);
		const filePath = record?.filePath ?? path.join(this.options.paths.sessionDirectories[0] ?? '', `${sessionId}.jsonl`);
		const transcriptPath = path.join(this.options.paths.transcriptDirectories[0] ?? '', `${sessionId}.jsonl`);
		const debugDirectory = path.join(this.options.paths.debugLogDirectories[0] ?? '', sessionId);
		const debugPath = path.join(debugDirectory, 'main.jsonl');
		const lookback = this.options.liveLookbackBytes ?? defaultLiveLookbackBytes;
		const liveTurns = this.liveWindow();
		const transcript = new LiveTurnAccumulator(liveTurns);
		const debug = new LiveTurnAccumulator(liveTurns);
		const tail: WatchedTail = {
			sessionId,
			filePath,
			digest: { status: 'loading', requestCount: 0, generation: 0, customTitle: undefined, inputState: {}, lastModelId: undefined, error: undefined },
			liveWindow: [],
			transcript,
			transcriptTailer: new LineTailer(transcriptPath, {
				onLines: lines => this.applyLiveLines(tail, lines, line => transcript.applyTranscriptLine(line)),
				onReset: () => { transcript.reset(); this.bump(tail); },
				onGone: () => { transcript.reset(); this.bump(tail); },
			}, {
				initialOffset: size => findTailStart(transcriptPath, size, { marker: transcriptTurnMarker, maximumLookbackBytes: lookback }),
			}),
			debug,
			debugTailer: new LineTailer(debugPath, {
				onLines: lines => this.applyLiveLines(tail, lines, line => {
					const type = sniffDebugLogType(line);
					return type !== undefined && relevantDebugLogTypes.has(type) && debug.applyDebugLogLine(line);
				}),
				onReset: () => { debug.reset(); this.bump(tail); },
				onGone: () => { debug.reset(); this.bump(tail); },
			}, {
				maximumLineBytes: 8 * 1024 * 1024,
				initialOffset: size => findTailStart(debugPath, size, { marker: debugTurnMarker, maximumLookbackBytes: lookback }),
			}),
			debugWatcher: new DirectoryWatcher(debugDirectory, event => {
				if (this.tails.get(sessionId) !== tail) {
					return;
				}
				if (event.type === 'reconcile' || !event.name || event.name === 'main.jsonl') {
					this.debounce(`debug:${sessionId}`, () => void this.pokeLive(tail, 'debug'), this.options.fileDebounceMs ?? defaultFileDebounceMs);
				}
			}),
			abort: new AbortController(),
			revision: 0,
			liveReplayed: false,
			syncing: undefined,
			syncRequested: false,
			syncFailures: 0,
			detachTimer: undefined,
		};
		this.tails.set(sessionId, tail);
		tail.debugWatcher.start();
		this.scheduleEmit();
		void this.syncDigest(tail);
		void this.pokeLive(tail, 'all').then(() => {
			tail.liveReplayed = true;
		});
	}

	private scheduleDetach(tail: WatchedTail): void {
		if (tail.detachTimer) {
			return;
		}
		const grace = this.options.detachGraceMs ?? defaultDetachGraceMs;
		if (grace <= 0) {
			this.detach(tail);
			this.scheduleEmit();
			return;
		}
		tail.detachTimer = setTimeout(() => {
			tail.detachTimer = undefined;
			if (this.tails.get(tail.sessionId) === tail) {
				this.detach(tail);
				this.scheduleEmit();
			}
		}, grace);
		tail.detachTimer.unref();
	}

	private cancelDetach(tail: WatchedTail): void {
		if (tail.detachTimer) {
			clearTimeout(tail.detachTimer);
			tail.detachTimer = undefined;
		}
	}

	private detach(tail: WatchedTail): void {
		this.cancelDetach(tail);
		this.tails.delete(tail.sessionId);
		tail.abort.abort();
		tail.transcriptTailer.dispose();
		tail.debugTailer.dispose();
		tail.debugWatcher.dispose();
		for (const key of ['digest', 'transcript', 'debug']) {
			this.clearDebounce(`${key}:${tail.sessionId}`);
		}
	}

	/** Brings the digest up to date; concurrent requests coalesce into one follow-up pass. */
	private syncDigest(tail: WatchedTail): Promise<void> {
		if (this.tails.get(tail.sessionId) !== tail || tail.abort.signal.aborted) {
			return Promise.resolve();
		}
		if (tail.syncing) {
			tail.syncRequested = true;
			return tail.syncing;
		}
		tail.syncing = this.runDigestSync(tail).finally(() => {
			tail.syncing = undefined;
			if (tail.syncRequested && this.tails.get(tail.sessionId) === tail) {
				tail.syncRequested = false;
				void this.syncDigest(tail);
			}
		});
		return tail.syncing;
	}

	private async runDigestSync(tail: WatchedTail): Promise<void> {
		let digest: SessionDigest;
		try {
			digest = this.digest();
		} catch (error) {
			this.failDigest(tail, error);
			return;
		}
		try {
			const sync = this.options.syncDigest ?? ((store, sessionId, filePath, signal) => syncDigestForSession(store, sessionId, filePath, { signal }));
			const result = await sync(digest, tail.sessionId, tail.filePath, tail.abort.signal);
			if (this.tails.get(tail.sessionId) !== tail) {
				return;
			}
			tail.syncFailures = 0;
			if (result.status === 'oversized') {
				tail.digest.status = 'oversized';
				tail.digest.requestCount = 0;
				tail.liveWindow = [];
				this.bump(tail);
				return;
			}
			if (result.status === 'gone') {
				tail.digest.status = 'ready';
				tail.digest.requestCount = 0;
				tail.digest.customTitle = undefined;
				tail.digest.inputState = {};
				tail.digest.lastModelId = undefined;
				tail.liveWindow = [];
				this.bump(tail);
				return;
			}
			const row = digest.session(tail.sessionId);
			if (!row) {
				return;
			}
			const window = this.liveWindow();
			const wasReady = tail.digest.status === 'ready';
			tail.digest.status = 'ready';
			tail.digest.error = undefined;
			tail.digest.requestCount = row.requestCount;
			tail.digest.generation = row.generation;
			tail.digest.customTitle = row.customTitle;
			tail.digest.inputState = row.inputState;
			tail.digest.lastModelId = digest.lastModelId(tail.sessionId);
			tail.liveWindow = digest.turns(tail.sessionId, Math.max(0, row.requestCount - window), row.requestCount);
			if (result.status !== 'unchanged' || !wasReady) {
				this.bump(tail);
			}
		} catch (error) {
			if (tail.abort.signal.aborted) {
				return;
			}
			this.failDigest(tail, error);
		}
	}

	private failDigest(tail: WatchedTail, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.log(`digest sync failed for ${tail.sessionId}: ${message}`);
		tail.syncFailures++;
		if (tail.digest.status === 'loading') {
			tail.digest.status = 'error';
		}
		tail.digest.error = message;
		this.bump(tail);
		if (tail.syncFailures < maximumSyncFailures) {
			this.debounce(`digest:${tail.sessionId}`, () => void this.syncDigest(tail), 1_000 * tail.syncFailures);
		}
	}

	private digest(): SessionDigest {
		if (!this.digestStore) {
			mkdirSync(path.dirname(this.options.paths.digestDatabasePath), { recursive: true });
			// Short wait: the extension host must never block on a worker's write transaction.
			this.digestStore = new SessionDigest(this.options.paths.digestDatabasePath, { busyTimeoutMs: 250 });
		}
		return this.digestStore;
	}

	private async pokeLive(tail: WatchedTail, which: 'all' | 'transcript' | 'debug'): Promise<void> {
		if (this.tails.get(tail.sessionId) !== tail) {
			return;
		}
		const jobs: Promise<void>[] = [];
		if (which === 'all' || which === 'transcript') {
			jobs.push(tail.transcriptTailer.poke().catch(error => this.log(`transcript tail failed: ${String(error)}`)));
		}
		if (which === 'all' || which === 'debug') {
			jobs.push(tail.debugTailer.poke().catch(error => this.log(`debug log tail failed: ${String(error)}`)));
		}
		await Promise.all(jobs);
	}

	private applyLiveLines(tail: WatchedTail, lines: readonly string[], apply: (line: string) => boolean): void {
		let changed = false;
		for (const line of lines) {
			changed = apply(line) || changed;
		}
		// Replaying an existing file on attach, or log chatter that touched no turn, is not evidence
		// of work; counting it made a chat show "working" right after being opened and closed.
		const record = changed && tail.liveReplayed ? this.records.get(tail.sessionId) : undefined;
		if (record) {
			record.lastActivityAt = this.now();
			this.scheduleActivityDecay();
		}
		if (changed) {
			this.bump(tail);
		}
	}

	private bump(tail: WatchedTail): void {
		tail.revision++;
		this.scheduleEmit();
	}

	private liveWindow(): number {
		return Math.max(1, this.options.liveWindowTurns ?? defaultLiveWindowTurns);
	}

	// #endregion

	// #region state

	private buildSummaryState(record: SessionRecord, now: number): ActiveSessionState {
		const window = this.options.activityWindowMs ?? defaultActivityWindowMs;
		const working = record.lastActivityAt !== undefined && now - record.lastActivityAt < window;
		const isEmpty = working ? false : this.isEmpty(record);
		return {
			resource: record.resource,
			sessionId: record.sessionId,
			title: this.titleOf(record, undefined),
			status: working ? 'working' : 'idle',
			revision: `meta:${record.size}:${record.mtimeMs}:${this.indexRevision ?? ''}`,
			updatedAt: this.updatedAt(record),
			turns: [],
			...(isEmpty === true ? { turnCount: 0 } : {}),
			...(isEmpty === undefined ? {} : { isEmpty }),
			permissionLevel: record.index?.permissionLevel ?? 'default',
		};
	}

	private buildWatchedState(record: SessionRecord, tail: WatchedTail, now: number): ActiveSessionState {
		const view = tail.digest;
		const ready = view.status === 'ready';
		const persisted = tail.liveWindow;
		const live = tail.transcript.turns.length > 0 ? tail.transcript.turns : tail.debug.turns;
		const merged = mergeLiveTurns({
			persisted,
			persistedStart: Math.max(0, view.requestCount - persisted.length),
			persistedCount: view.requestCount,
			live,
			now,
		});
		const status: ActiveSessionState['status'] = view.status === 'loading' ? 'loading' : merged.status;
		const permissionLevel: ChatPermissionLevel = ready ? parsePermissionLevel(view.inputState) : record.index?.permissionLevel ?? 'default';
		const isEmpty = ready || merged.turns.length > 0
			? merged.turnCount === 0 && merged.turns.length === 0
			: this.isEmpty(record);
		const modelSource: JsonObject = { inputState: view.inputState, requests: view.lastModelId ? [{ modelId: view.lastModelId }] : [] };
		return {
			resource: record.resource,
			sessionId: record.sessionId,
			title: this.titleOf(record, ready ? view.customTitle : undefined),
			status,
			revision: `live:${view.generation}:${tail.revision}`,
			updatedAt: Math.max(this.updatedAt(record), merged.turns.at(-1)?.timestamp ?? 0),
			turns: merged.turns,
			turnCount: merged.turnCount,
			...(isEmpty === undefined ? {} : { isEmpty }),
			historyStart: merged.historyStart,
			historyTruncated: merged.historyStart > 0,
			...(view.status === 'oversized' ? { historyUnavailable: 'oversized' as const } : {}),
			model: ready ? parseSessionModelState(modelSource) : undefined,
			permissionLevel,
		};
	}

	private titleOf(record: SessionRecord, projected: string | undefined): string {
		return projected || record.index?.title || record.fallbackTitle || 'Copilot chat';
	}

	private scheduleEmit(): void {
		if (this.emitScheduled || this.disposed) {
			return;
		}
		this.emitScheduled = true;
		setImmediate(() => {
			this.emitScheduled = false;
			if (this.disposed) {
				return;
			}
			for (const listener of this.listeners) {
				listener();
			}
		});
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	// #endregion
}

function parsePermissionLevel(inputState: JsonObject): ChatPermissionLevel {
	const level = inputState.permissionLevel;
	return level === 'autoApprove' || level === 'autopilot' ? level : 'default';
}
