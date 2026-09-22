import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DirectoryEvent, DirectoryWatcher } from './directoryWatcher';
import { LineTailer } from './lineTailer';
import { mergeLiveTurns } from './liveMerge';
import { LiveTurnAccumulator, relevantDebugLogTypes, sniffDebugLogType } from './liveTurns';
import type { ActiveSessionState, ChatPermissionLevel } from './protocol';
import { readSessionHeadTitle } from './sessionHeadTitle';
import { readSessionIndex, SessionIndexEntry } from './sessionIndex';
import { SessionLogProjection } from './sessionLogProjection';
import { localSessionResource } from './sessionResource';
import type { TranscriptTurn } from './transcript';

/**
 * Event-driven model of one VS Code window's chat sessions.
 *
 * Sources (all consumed by byte-offset tailing on fs.watch events, never re-read whole):
 * - `state.vscdb` → session list (title, dates, last state) via {@link readSessionIndex};
 * - `chatSessions/<id>.jsonl` → authoritative turns of the *selected* session;
 * - `transcripts/<id>.jsonl` and `debug-logs/<id>/main.jsonl` → live progress overlay and
 *   an activity signal ("working") for the list.
 *
 * Nothing runs while no viewer is connected: watchers and tailers exist only between
 * `setViewerCount(>0)` and `setViewerCount(0)`. There are no periodic timers; the only
 * timers are event debounces and the one-shot "activity aged out" transition.
 */

export interface SessionCorePaths {
	readonly sessionDirectories: readonly string[];
	readonly transcriptDirectories: readonly string[];
	readonly debugLogDirectories: readonly string[];
	readonly indexDatabasePath: string;
}

export interface SessionCoreOptions {
	readonly paths: SessionCorePaths;
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	/** Newest turns kept exact for the selected session and sent to viewers. */
	readonly retainedTurns?: number;
	readonly fileDebounceMs?: number;
	readonly indexDebounceMs?: number;
	/** How long a transcript/debug-log write keeps a non-selected session marked as working. */
	readonly activityWindowMs?: number;
	/** Session logs larger than this start tailing near EOF (history unavailable). */
	readonly oversizedSessionBytes?: number;
	readonly maximumLineBytes?: number;
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
	fallbackTitleKey: string | undefined;
	lastActivityAt: number | undefined;
}

interface ActiveTail {
	readonly sessionId: string;
	readonly projection: SessionLogProjection;
	readonly sessionTailer: LineTailer;
	readonly transcript: LiveTurnAccumulator;
	readonly transcriptTailer: LineTailer;
	readonly debug: LiveTurnAccumulator;
	readonly debugTailer: LineTailer;
	readonly debugWatcher: DirectoryWatcher;
	revision: number;
	loading: boolean;
	sessionLogError: string | undefined;
}

const defaultRetainedTurns = 40;
const defaultFileDebounceMs = 50;
const defaultIndexDebounceMs = 400;
const defaultActivityWindowMs = 15_000;
const defaultOversizedSessionBytes = 256 * 1024 * 1024;
const defaultMaximumLineBytes = 64 * 1024 * 1024;
const fallbackTitleBytes = 64 * 1024;

export class SessionCore {
	private readonly listeners = new Set<() => void>();
	private readonly records = new Map<string, SessionRecord>();
	private readonly watchers: DirectoryWatcher[] = [];
	private readonly debounces = new Map<string, NodeJS.Timeout>();
	private active: ActiveTail | undefined;
	private activeSessionId: string | undefined;
	private viewerCount = 0;
	private indexRevision: string | undefined;
	private indexEntries = new Map<string, SessionIndexEntry>();
	private activityTimer: NodeJS.Timeout | undefined;
	private emitScheduled = false;
	private error: string | undefined;
	private disposed = false;
	private listRefresh: Promise<void> | undefined;

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

	/** Viewers gate all work. 0 → tear everything down; >0 → attach watchers and refresh. */
	async setViewerCount(count: number): Promise<void> {
		if (this.disposed) {
			return;
		}
		const hadViewers = this.viewerCount > 0;
		this.viewerCount = count;
		if (count > 0 && !hadViewers) {
			this.attachWatchers();
			await this.refreshAll();
		} else if (count === 0 && hadViewers) {
			this.detachEverything();
		}
	}

	/** Point the core at a session: its log, transcript and debug log get tailed. */
	async selectSession(sessionId: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.activeSessionId === sessionId && this.active) {
			return;
		}
		this.activeSessionId = sessionId;
		if (this.viewerCount > 0) {
			await this.attachActive(sessionId);
		}
		this.scheduleEmit();
	}

	/** Re-read the selected session's files now (after the monitor itself appended to them). */
	async pokeSession(sessionId: string): Promise<void> {
		if (this.active?.sessionId === sessionId) {
			await this.pokeActive('all');
		}
		await this.refreshSessionList(`${sessionId}.jsonl`);
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
			this.activeSessionId = this.orderedRecords()[0]?.sessionId;
		}
		if (this.activeSessionId && this.viewerCount > 0) {
			if (this.active?.sessionId !== this.activeSessionId) {
				await this.attachActive(this.activeSessionId);
			} else {
				await this.pokeActive('all');
			}
		}
		this.scheduleEmit();
	}

	getState(): SessionCoreState {
		const now = this.now();
		const sessions = this.orderedRecords().map(record => record.sessionId === this.active?.sessionId
			? this.buildActiveState(record, this.active, now)
			: this.buildSummaryState(record, now));
		return {
			sessions,
			activeSessionResource: this.activeSessionId ? localSessionResource(this.activeSessionId) : undefined,
			error: this.error ?? this.active?.sessionLogError,
		};
	}

	/** Absolute index of a request in the selected session, from the exact projection. */
	requestIndexOf(sessionId: string, requestId: string): number | undefined {
		const tail = this.active;
		if (!tail || tail.sessionId !== sessionId) {
			return undefined;
		}
		const count = tail.projection.snapshot.turnCount;
		for (let index = count - 1; index >= 0; index--) {
			const turn = tail.projection.turns(index, index + 1)[0];
			if (turn?.id === requestId) {
				return index;
			}
		}
		return undefined;
	}

	/** Pages persisted history of the selected session out of the projection. */
	historyPage(sessionId: string, before: number, limit: number): HistoryPage | undefined {
		const tail = this.active;
		if (!tail || tail.sessionId !== sessionId) {
			return undefined;
		}
		const snapshot = tail.projection.snapshot;
		if (!snapshot.initialised || snapshot.oversized) {
			return undefined;
		}
		const total = snapshot.turnCount;
		const end = Math.max(0, Math.min(Math.floor(before), total));
		const start = Math.max(0, end - Math.max(1, Math.min(Math.floor(limit), 100)));
		return { turns: tail.projection.turns(start, end), totalCount: total, start, end, hasEarlier: start > 0 };
	}

	sessionFile(sessionId: string): { filePath: string; size: number; mtimeMs: number } | undefined {
		const record = this.records.get(sessionId);
		return record ? { filePath: record.filePath, size: record.size, mtimeMs: record.mtimeMs } : undefined;
	}

	isOversized(sessionId: string): boolean {
		return this.active?.sessionId === sessionId && this.active.projection.snapshot.oversized;
	}

	dispose(): void {
		this.disposed = true;
		this.detachEverything();
		this.listeners.clear();
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
			if (!this.disposed && this.viewerCount > 0) {
				listener(event);
			}
		});
		watcher.start();
		this.watchers.push(watcher);
	}

	private onSessionDirectoryEvent(directory: string, event: DirectoryEvent): void {
		if (event.type === 'reconcile') {
			this.debounce('list', () => void this.refreshSessionList(undefined), this.options.fileDebounceMs ?? defaultFileDebounceMs);
			return;
		}
		const name = event.name;
		if (name && !name.endsWith('.jsonl')) {
			return;
		}
		if (name && this.active && path.join(directory, name) === this.active.sessionTailer.filePath) {
			this.debounce('active:session', () => void this.pokeActive('session'), this.options.fileDebounceMs ?? defaultFileDebounceMs);
		}
		this.debounce(`list:${name ?? '*'}`, () => void this.refreshSessionList(name), this.options.fileDebounceMs ?? defaultFileDebounceMs);
	}

	private onTranscriptDirectoryEvent(event: DirectoryEvent): void {
		if (event.type === 'reconcile') {
			this.debounce('active:transcript', () => void this.pokeActive('transcript'), this.options.fileDebounceMs ?? defaultFileDebounceMs);
			return;
		}
		const name = event.name;
		if (!name || !name.endsWith('.jsonl')) {
			return;
		}
		const sessionId = name.slice(0, -'.jsonl'.length);
		this.noteActivity(sessionId);
		if (this.active?.sessionId === sessionId) {
			this.debounce('active:transcript', () => void this.pokeActive('transcript'), this.options.fileDebounceMs ?? defaultFileDebounceMs);
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
		this.detachActive();
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
		const record = this.records.get(sessionId);
		if (record) {
			this.records.delete(sessionId);
			if (this.active?.sessionId === sessionId) {
				await this.pokeActive('session');
			}
		}
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
			record.fallbackTitle = await readSessionHeadTitle(record.filePath, fallbackTitleBytes);
		} catch {
			record.fallbackTitle = undefined;
		}
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

	// #region active session

	private async attachActive(sessionId: string): Promise<void> {
		this.detachActive();
		const record = this.records.get(sessionId);
		const sessionPath = record?.filePath ?? path.join(this.options.paths.sessionDirectories[0] ?? '', `${sessionId}.jsonl`);
		const transcriptPath = path.join(this.options.paths.transcriptDirectories[0] ?? '', `${sessionId}.jsonl`);
		const debugDirectory = path.join(this.options.paths.debugLogDirectories[0] ?? '', sessionId);
		const debugPath = path.join(debugDirectory, 'main.jsonl');

		const projection = new SessionLogProjection({ retainedRawTurns: this.options.retainedTurns ?? defaultRetainedTurns });
		const transcript = new LiveTurnAccumulator();
		const debug = new LiveTurnAccumulator();
		const tail: ActiveTail = {
			sessionId,
			projection,
			transcript,
			debug,
			revision: 0,
			loading: true,
			sessionLogError: undefined,
			sessionTailer: new LineTailer(sessionPath, {
				onLines: (lines, generation) => this.applySessionLines(tail, lines, generation),
				onReset: () => { projection.reset(); this.bump(tail); },
				onLineSkipped: (_bytes, index) => {
					if (index === 0) {
						projection.markInitialSkipped();
						this.bump(tail);
					}
				},
				onGone: () => { projection.reset(); this.bump(tail); },
			}, {
				maximumLineBytes: this.options.maximumLineBytes ?? defaultMaximumLineBytes,
				skipToTailIfLargerThan: this.options.oversizedSessionBytes ?? defaultOversizedSessionBytes,
			}),
			transcriptTailer: new LineTailer(transcriptPath, {
				onLines: lines => this.applyLiveLines(tail, transcript, lines, line => transcript.applyTranscriptLine(line)),
				onReset: () => { transcript.reset(); this.bump(tail); },
				onGone: () => { transcript.reset(); this.bump(tail); },
			}),
			debugTailer: new LineTailer(debugPath, {
				onLines: lines => this.applyLiveLines(tail, debug, lines, line => {
					const type = sniffDebugLogType(line);
					return type !== undefined && relevantDebugLogTypes.has(type) && debug.applyDebugLogLine(line);
				}),
				onReset: () => { debug.reset(); this.bump(tail); },
				onGone: () => { debug.reset(); this.bump(tail); },
			}, { maximumLineBytes: 8 * 1024 * 1024 }),
			debugWatcher: new DirectoryWatcher(debugDirectory, event => {
				if (this.active !== tail || this.viewerCount === 0) {
					return;
				}
				if (event.type === 'reconcile' || !event.name || event.name === 'main.jsonl') {
					this.debounce('active:debug', () => void this.pokeActive('debug'), this.options.fileDebounceMs ?? defaultFileDebounceMs);
				}
			}),
		};
		this.active = tail;
		tail.debugWatcher.start();
		this.scheduleEmit();
		await this.pokeActive('all');
		tail.loading = false;
		this.scheduleEmit();
	}

	private detachActive(): void {
		const tail = this.active;
		this.active = undefined;
		if (!tail) {
			return;
		}
		tail.sessionTailer.dispose();
		tail.transcriptTailer.dispose();
		tail.debugTailer.dispose();
		tail.debugWatcher.dispose();
	}

	private async pokeActive(which: 'all' | 'session' | 'transcript' | 'debug'): Promise<void> {
		const tail = this.active;
		if (!tail) {
			return;
		}
		const jobs: Promise<void>[] = [];
		if (which === 'all' || which === 'session') {
			jobs.push(tail.sessionTailer.poke().catch(error => {
				tail.sessionLogError = error instanceof Error ? error.message : String(error);
				this.log(`session log tail failed: ${tail.sessionLogError}`);
			}));
		}
		if (which === 'all' || which === 'transcript') {
			jobs.push(tail.transcriptTailer.poke().catch(error => this.log(`transcript tail failed: ${String(error)}`)));
		}
		if (which === 'all' || which === 'debug') {
			jobs.push(tail.debugTailer.poke().catch(error => this.log(`debug log tail failed: ${String(error)}`)));
		}
		await Promise.all(jobs);
	}

	private applySessionLines(tail: ActiveTail, lines: readonly string[], generation: number): void {
		let changed = false;
		for (const line of lines) {
			try {
				changed = tail.projection.applyLine(line) || changed;
			} catch (error) {
				this.log(`session log desync (${generation}): ${error instanceof Error ? error.message : String(error)}`);
				tail.projection.reset();
				void tail.sessionTailer.resync();
				return;
			}
		}
		if (tail.projection.snapshot.needsFullReload) {
			tail.projection.reset();
			void tail.sessionTailer.resync();
			return;
		}
		tail.sessionLogError = undefined;
		if (changed) {
			this.bump(tail);
		}
	}

	private applyLiveLines(tail: ActiveTail, _source: LiveTurnAccumulator, lines: readonly string[], apply: (line: string) => boolean): void {
		let changed = false;
		for (const line of lines) {
			changed = apply(line) || changed;
		}
		const record = this.records.get(tail.sessionId);
		if (record) {
			record.lastActivityAt = this.now();
			this.scheduleActivityDecay();
		}
		if (changed) {
			this.bump(tail);
		}
	}

	private bump(tail: ActiveTail): void {
		tail.revision++;
		this.scheduleEmit();
	}

	// #endregion

	// #region state

	private buildSummaryState(record: SessionRecord, now: number): ActiveSessionState {
		const window = this.options.activityWindowMs ?? defaultActivityWindowMs;
		const working = record.lastActivityAt !== undefined && now - record.lastActivityAt < window;
		return {
			resource: record.resource,
			sessionId: record.sessionId,
			title: this.titleOf(record, undefined),
			status: working ? 'working' : 'idle',
			revision: `meta:${record.size}:${record.mtimeMs}:${this.indexRevision ?? ''}`,
			updatedAt: this.updatedAt(record),
			turns: [],
			permissionLevel: record.index?.permissionLevel ?? 'default',
		};
	}

	private buildActiveState(record: SessionRecord, tail: ActiveTail, now: number): ActiveSessionState {
		const snapshot = tail.projection.snapshot;
		const retained = this.options.retainedTurns ?? defaultRetainedTurns;
		const persisted = tail.projection.tail(retained);
		const live = tail.transcript.turns.length > 0 ? tail.transcript.turns : tail.debug.turns;
		const merged = mergeLiveTurns({
			persisted: persisted.turns,
			persistedStart: persisted.start,
			persistedCount: snapshot.turnCount,
			live,
			now,
		});
		const status: ActiveSessionState['status'] = tail.loading && !snapshot.initialised ? 'loading' : merged.status;
		const permissionLevel: ChatPermissionLevel = snapshot.initialised && !snapshot.oversized
			? snapshot.permissionLevel
			: record.index?.permissionLevel ?? snapshot.permissionLevel;
		return {
			resource: record.resource,
			sessionId: record.sessionId,
			title: this.titleOf(record, snapshot.title),
			status,
			revision: `live:${tail.sessionTailer.cursor.generation}:${tail.revision}`,
			updatedAt: Math.max(this.updatedAt(record), merged.turns.at(-1)?.timestamp ?? 0),
			turns: merged.turns,
			turnCount: merged.turnCount,
			historyStart: merged.historyStart,
			historyTruncated: merged.historyStart > 0,
			...(snapshot.oversized ? { historyUnavailable: 'oversized' as const } : {}),
			model: snapshot.model,
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

	// #endregion

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private log(message: string): void {
		this.options.log?.(message);
	}
}
