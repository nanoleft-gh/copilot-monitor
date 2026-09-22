import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import Assembler = require('stream-json/Assembler');
import { parser } from 'stream-json';
import { DigestCursor, DigestSessionRow, SessionDigest } from './sessionDigest';
import { JsonObject } from './transcript';

/**
 * Brings a session's digest up to date with its mutation log, reading only bytes the digest
 * has not seen. Lines up to `smallLineBytes` are parsed whole; longer ones (a compacted
 * Initial entry can be 100 MB on a single line) are tokenised with `stream-json` so that at
 * most one request object is materialised at a time and every string is capped.
 *
 * Runs either inline on the extension host (short appends) or inside a worker thread
 * (rebuilds); the only shared state is the SQLite file.
 */

export interface DigestSyncOptions {
	readonly digest: SessionDigest;
	readonly sessionId: string;
	readonly filePath: string;
	/** Lines at most this long are `JSON.parse`d; longer ones are streamed. */
	readonly smallLineBytes?: number;
	/** Longest string kept from a streamed line. */
	readonly stringCapChars?: number;
	/** Requests written per transaction during a rebuild, so readers are never blocked for long. */
	readonly commitEvery?: number;
	/** Logs above this size are not digested at all. */
	readonly maximumFileBytes?: number;
	readonly signal?: AbortSignal;
}

export type DigestSyncStatus = 'rebuilt' | 'extended' | 'unchanged' | 'gone' | 'oversized';

export interface DigestSyncResult {
	readonly status: DigestSyncStatus;
	readonly requestCount: number;
	readonly generation: number;
	readonly revision: number;
}

const defaultSmallLineBytes = 256 * 1024;
const defaultStringCapChars = 64 * 1024;
const defaultCommitEvery = 64;
const defaultMaximumFileBytes = 1024 * 1024 * 1024;
/** Newest requests whose raw JSON stays available for later mutations; older sealed ones are trimmed. */
const retainedRawRequests = 16;
/** Raw requests held in memory during one pass; a streaming response mutates the same request many times. */
const rawCacheEntries = 4;
const anchorBytes = 4096;
const prefixBytes = 1024;
const tailBytes = 128;

/** A mutation touched a request whose raw JSON was trimmed; only a full replay can apply it. */
class RebuildRequiredError extends Error {}

/** Decides whether `filePath` needs a rebuild, an incremental extend, or nothing, without reading content. */
export async function planDigestSync(digest: SessionDigest, sessionId: string, filePath: string): Promise<{ mode: 'rebuild' | 'extend' | 'unchanged' | 'gone'; appendedBytes: number }> {
	let stat;
	try {
		stat = await fs.stat(filePath, { bigint: true });
	} catch (error) {
		if (isFileNotFound(error)) {
			return { mode: 'gone', appendedBytes: 0 };
		}
		throw error;
	}
	const row = digest.session(sessionId);
	const size = Number(stat.size);
	if (!row || row.filePath !== filePath || row.cursor.ino !== String(stat.ino) || size < row.cursor.indexedOffset) {
		return { mode: 'rebuild', appendedBytes: size };
	}
	if (size === row.cursor.indexedOffset && row.cursor.mtimeMs === Number(stat.mtimeMs)) {
		return { mode: 'unchanged', appendedBytes: 0 };
	}
	if (row.cursor.indexedOffset > 0 && !(await anchorMatches(filePath, row.cursor))) {
		return { mode: 'rebuild', appendedBytes: size };
	}
	return { mode: size === row.cursor.indexedOffset ? 'unchanged' : 'extend', appendedBytes: size - row.cursor.indexedOffset };
}

export async function syncSessionDigest(options: DigestSyncOptions): Promise<DigestSyncResult> {
	const { digest, sessionId, filePath } = options;
	const plan = await planDigestSync(digest, sessionId, filePath);
	if (plan.mode === 'gone') {
		digest.removeSession(sessionId);
		return { status: 'gone', requestCount: 0, generation: 0, revision: 0 };
	}
	const stat = await fs.stat(filePath, { bigint: true });
	const size = Number(stat.size);
	if (size > (options.maximumFileBytes ?? defaultMaximumFileBytes)) {
		return { status: 'oversized', requestCount: 0, generation: 0, revision: 0 };
	}
	const row = digest.session(sessionId);
	if (plan.mode === 'unchanged' && row) {
		return { status: 'unchanged', requestCount: row.requestCount, generation: row.generation, revision: row.revision };
	}
	const rebuild = plan.mode === 'rebuild' || !row;
	try {
		return await applyLog(options, stat, size, rebuild);
	} catch (error) {
		if (error instanceof RebuildRequiredError && !rebuild) {
			return applyLog(options, stat, size, true);
		}
		throw error;
	}
}

async function applyLog(options: DigestSyncOptions, stat: { ino: bigint; mtimeMs: bigint }, size: number, rebuild: boolean): Promise<DigestSyncResult> {
	const { digest, sessionId, filePath } = options;
	digest.begin();
	try {
		if (rebuild) {
			digest.resetSession(sessionId, filePath);
		}
		const row = digest.session(sessionId)!;
		const applier = new DigestApplier(digest, sessionId, row, options.commitEvery ?? defaultCommitEvery);
		const indexedOffset = await consumeLines(filePath, rebuild ? 0 : row.cursor.indexedOffset, size, options, applier);
		applier.finish();
		digest.trimRaw(sessionId, applier.requestCount - retainedRawRequests);
		const anchorHash = await readAnchor(filePath, indexedOffset);
		digest.setCursor(sessionId, { ino: String(stat.ino), size, mtimeMs: Number(stat.mtimeMs), anchorHash, indexedOffset });
		digest.commit();
	} catch (error) {
		digest.rollback();
		throw error;
	}
	if (rebuild) {
		digest.vacuum();
	}
	const updated = digest.session(sessionId)!;
	return { status: rebuild ? 'rebuilt' : 'extended', requestCount: updated.requestCount, generation: updated.generation, revision: updated.revision };
}

// #region line consumption

interface ScannedLine {
	readonly offset: number;
	readonly length: number;
	/** Whole line when it fit the small-line budget. */
	readonly bytes: Buffer | undefined;
	readonly prefix: Buffer;
	readonly tail: Buffer;
}

/** Feeds every complete line in `[from, end)` to the applier; returns the offset of the first byte not consumed. */
async function consumeLines(filePath: string, from: number, end: number, options: DigestSyncOptions, applier: DigestApplier): Promise<number> {
	if (end <= from) {
		return from;
	}
	const smallLineBytes = options.smallLineBytes ?? defaultSmallLineBytes;
	let lineOffset = from;
	let lineLength = 0;
	let parts: Buffer[] | undefined = [];
	let prefix = Buffer.alloc(0);
	let tail = Buffer.alloc(0);

	const accumulate = (part: Buffer) => {
		lineLength += part.length;
		if (parts && lineLength <= smallLineBytes) {
			parts.push(part);
		} else {
			parts = undefined;
		}
		if (prefix.length < prefixBytes) {
			prefix = Buffer.concat([prefix, part.subarray(0, prefixBytes - prefix.length)]);
		}
		tail = part.length >= tailBytes ? Buffer.from(part.subarray(part.length - tailBytes)) : Buffer.concat([tail, part]).subarray(-tailBytes);
	};

	const stream = createReadStream(filePath, { start: from, end: end - 1, highWaterMark: 256 * 1024 });
	for await (const chunk of stream) {
		options.signal?.throwIfAborted();
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let cursor = 0;
		while (cursor < bytes.length) {
			const newline = bytes.indexOf(0x0a, cursor);
			const part = bytes.subarray(cursor, newline < 0 ? bytes.length : newline);
			accumulate(part);
			if (newline < 0) {
				break;
			}
			const line: ScannedLine = { offset: lineOffset, length: lineLength, bytes: parts ? Buffer.concat(parts) : undefined, prefix, tail };
			if (lineLength > 0) {
				await applyLine(filePath, line, options, applier);
			}
			lineOffset += lineLength + 1;
			lineLength = 0;
			parts = [];
			prefix = Buffer.alloc(0);
			tail = Buffer.alloc(0);
			cursor = newline + 1;
		}
	}
	// A trailing partial line is left for the next sync.
	return lineOffset;
}

async function applyLine(filePath: string, line: ScannedLine, options: DigestSyncOptions, applier: DigestApplier): Promise<void> {
	if (line.bytes) {
		let text = line.bytes.toString('utf8');
		if (text.endsWith('\r')) {
			text = text.slice(0, -1);
		}
		if (!text.trim()) {
			return;
		}
		const entry = JSON.parse(text) as JsonObject;
		applier.applyEntry(entry);
		return;
	}
	const classified = classify(line.prefix.toString('utf8'));
	if (!classified) {
		return;
	}
	const stringCap = options.stringCapChars ?? defaultStringCapChars;
	const index = classified.kind === 2 ? readTrailingIndex(line.tail.toString('utf8')) : undefined;
	if (classified.kind === 0) {
		applier.beginInitial();
		await walkLine(filePath, line, stringCap, options.signal, path => (path.length === 2 && path[0] === 'v' && path[1] !== 'requests' && path[1] !== 'pendingRequests')
			|| (path.length === 3 && path[0] === 'v' && path[1] === 'requests'), (path, value) => {
			if (path.length === 2) {
				applier.headerField(String(path[1]), value);
			} else {
				applier.appendRequest(isObject(value) ? value : {});
			}
		});
		return;
	}
	if (classified.kind === 2 && classified.path.length === 1 && classified.path[0] === 'requests') {
		if (index !== undefined) {
			applier.truncateRequests(index);
		}
		await walkLine(filePath, line, stringCap, options.signal, path => path.length === 2 && path[0] === 'v', (_path, value) => {
			applier.appendRequest(isObject(value) ? value : {});
		});
		return;
	}
	let captured: unknown;
	await walkLine(filePath, line, stringCap, options.signal, path => path.length === 1 && path[0] === 'v', (_path, value) => {
		captured = value;
	});
	applier.applyEntry({ kind: classified.kind, k: classified.path, ...(captured !== undefined ? { v: captured } : {}), ...(index !== undefined ? { i: index } : {}) });
}

function classify(prefix: string): { kind: number; path: (string | number)[] } | undefined {
	const kindMatch = /^\{"kind":(\d+)/.exec(prefix);
	if (!kindMatch) {
		return undefined;
	}
	const kind = Number(kindMatch[1]);
	if (kind === 0) {
		return { kind, path: [] };
	}
	const pathMatch = /,"k":(\[[^\]]*\])/.exec(prefix);
	if (!pathMatch) {
		return undefined;
	}
	try {
		const path = JSON.parse(pathMatch[1]) as unknown;
		return Array.isArray(path) && path.every(value => typeof value === 'string' || typeof value === 'number')
			? { kind, path: path as (string | number)[] }
			: undefined;
	} catch {
		return undefined;
	}
}

/** VS Code writes `{kind,k,v,i}` in that order, so a Push's `i` sits in the last bytes of the line. */
function readTrailingIndex(tail: string): number | undefined {
	const match = /,"i":(\d+)\s*\}\s*\r?$/.exec(tail);
	return match ? Number(match[1]) : undefined;
}

// #endregion

// #region streaming tokeniser

type Path = (string | number)[];

interface Frame {
	readonly array: boolean;
	readonly key: string | number | undefined;
	index: number;
}

/**
 * Tokenises one JSON line and hands back every value whose path satisfies `isCaptureRoot`,
 * assembled with strings capped at `stringCap` characters. Everything else is traversed
 * without being materialised.
 */
async function walkLine(filePath: string, line: ScannedLine, stringCap: number, signal: AbortSignal | undefined, isCaptureRoot: (path: Path) => boolean, onCapture: (path: Path, value: unknown) => void): Promise<void> {
	const frames: Frame[] = [];
	let pendingKey: string | undefined;
	let capture: { assembler: Assembler; path: Path } | undefined;
	let stringParts: string[] | undefined;
	let stringLength = 0;
	let stringCapped = false;

	const valuePath = (): Path => {
		const path: Path = [];
		for (let index = 1; index < frames.length; index++) {
			path.push(frames[index].key!);
		}
		const top = frames.at(-1);
		if (top) {
			path.push(top.array ? top.index : pendingKey!);
		}
		return path;
	};

	const startValue = (token: { name: string; value?: string }) => {
		const top = frames.at(-1);
		let path: Path | undefined;
		if (frames.length <= 3) {
			path = valuePath();
		}
		const leaf = top ? (top.array ? top.index : pendingKey) : undefined;
		if (top?.array) {
			top.index++;
		}
		const container = token.name === 'startObject' || token.name === 'startArray';
		if (path && isCaptureRoot(path)) {
			if (container) {
				const assembler = new Assembler();
				assembler.consume(token);
				capture = { assembler, path };
			} else {
				onCapture(path, scalarValue(token));
			}
			return;
		}
		if (container) {
			frames.push({ array: token.name === 'startArray', key: leaf, index: 0 });
		}
	};

	const handle = (token: { name: string; value?: string }) => {
		switch (token.name) {
			case 'startString':
				stringParts = [];
				stringLength = 0;
				stringCapped = false;
				return;
			case 'stringChunk':
				if (stringParts && token.value) {
					if (stringLength < stringCap) {
						const remaining = stringCap - stringLength;
						stringParts.push(token.value.length > remaining ? token.value.slice(0, remaining) : token.value);
						stringLength += Math.min(remaining, token.value.length);
						if (token.value.length > remaining) {
							stringCapped = true;
						}
					} else {
						stringCapped = true;
					}
				}
				return;
			case 'endString': {
				const value = (stringParts ?? []).join('') + (stringCapped ? '…' : '');
				stringParts = undefined;
				handle({ name: 'stringValue', value });
				return;
			}
		}
		if (capture) {
			capture.assembler.consume(token);
			if (capture.assembler.done) {
				const finished = capture;
				capture = undefined;
				onCapture(finished.path, finished.assembler.current);
			}
			return;
		}
		switch (token.name) {
			case 'keyValue':
				pendingKey = token.value;
				return;
			case 'startObject':
			case 'startArray':
			case 'stringValue':
			case 'numberValue':
			case 'nullValue':
			case 'trueValue':
			case 'falseValue':
				startValue(token);
				return;
			case 'endObject':
			case 'endArray':
				frames.pop();
				return;
		}
	};

	const tokens = parser({ packKeys: true, streamKeys: false, packStrings: false, streamStrings: true, packNumbers: true, streamNumbers: false });
	const source = createReadStream(filePath, { start: line.offset, end: line.offset + line.length - 1, highWaterMark: 256 * 1024 });
	source.pipe(tokens);
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			source.destroy();
			tokens.destroy();
			reject(new Error('Digest sync was cancelled.'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		const done = (error?: Error) => {
			signal?.removeEventListener('abort', onAbort);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		tokens.on('data', handle);
		tokens.once('end', () => done());
		tokens.once('error', done);
		source.once('error', done);
	});
}

function scalarValue(token: { name: string; value?: string }): unknown {
	switch (token.name) {
		case 'stringValue': return token.value ?? '';
		case 'numberValue': return Number(token.value);
		case 'nullValue': return null;
		case 'trueValue': return true;
		case 'falseValue': return false;
		default: return undefined;
	}
}

// #endregion

// #region applier

/**
 * Applies mutation-log entries to the digest with the semantics of VS Code's
 * `ObjectMutationLog._applySet/_applyPush`, one request row at a time.
 */
export class DigestApplier {
	private sessionUuid: string;
	private customTitle: string | undefined;
	private inputState: JsonObject;
	private count: number;
	private headerDirty = false;
	private writesSinceCommit = 0;
	/** Most recently touched raw requests, newest last; dirty ones are written on eviction or finish. */
	private readonly rawCache = new Map<number, { raw: JsonObject; dirty: boolean }>();

	constructor(
		private readonly digest: SessionDigest,
		private readonly sessionId: string,
		row: DigestSessionRow,
		private readonly commitEvery: number,
	) {
		this.sessionUuid = row.sessionUuid;
		this.customTitle = row.customTitle;
		this.inputState = row.inputState;
		this.count = row.requestCount;
	}

	get requestCount(): number {
		return this.count;
	}

	applyEntry(entry: JsonObject): void {
		const kind = entry.kind;
		if (kind === 0) {
			this.beginInitial();
			const value = entry.v;
			if (isObject(value)) {
				for (const [key, field] of Object.entries(value)) {
					if (key === 'requests') {
						for (const request of Array.isArray(field) ? field : []) {
							this.appendRequest(isObject(request) ? request : {});
						}
					} else if (key !== 'pendingRequests') {
						this.headerField(key, field);
					}
				}
			}
			return;
		}
		const path = Array.isArray(entry.k) ? entry.k as Path : undefined;
		if (!path || path.length === 0) {
			return;
		}
		if (kind === 1 || kind === 3) {
			const value = kind === 3 ? undefined : entry.v;
			if (path[0] !== 'requests') {
				this.rootSet(path, value);
			} else if (path.length === 1) {
				this.truncateRequests(0);
				for (const request of Array.isArray(value) ? value : []) {
					this.appendRequest(isObject(request) ? request : {});
				}
			} else {
				const index = toIndex(path[1]);
				if (index === undefined) {
					return;
				}
				if (path.length === 2) {
					this.setRequest(index, isObject(value) ? value : {});
				} else {
					this.mutateRequest(index, raw => writePath(raw, path.slice(2), value));
				}
			}
			return;
		}
		if (kind === 2) {
			const values = Array.isArray(entry.v) ? entry.v : undefined;
			const startIndex = typeof entry.i === 'number' ? entry.i : undefined;
			if (path[0] !== 'requests') {
				this.rootPush(path, values, startIndex);
			} else if (path.length === 1) {
				if (startIndex !== undefined) {
					this.truncateRequests(startIndex);
				}
				for (const request of values ?? []) {
					this.appendRequest(isObject(request) ? request : {});
				}
			} else {
				const index = toIndex(path[1]);
				if (index === undefined || path.length < 3) {
					return;
				}
				this.mutateRequest(index, raw => pushPath(raw, path.slice(2), values, startIndex));
			}
		}
	}

	beginInitial(): void {
		this.rawCache.clear();
		this.digest.deleteRequestsFrom(this.sessionId, 0);
		this.count = 0;
		this.sessionUuid = '';
		this.customTitle = undefined;
		this.inputState = {};
		this.headerDirty = true;
	}

	headerField(key: string, value: unknown): void {
		if (key === 'sessionId' && typeof value === 'string') {
			this.sessionUuid = value;
		} else if (key === 'customTitle') {
			this.customTitle = typeof value === 'string' ? value.trim() || undefined : undefined;
		} else if (key === 'inputState') {
			this.inputState = isObject(value) ? value : {};
		} else {
			return;
		}
		this.headerDirty = true;
	}

	appendRequest(raw: JsonObject): void {
		this.writeRequest(this.count++, compactRawRequest(raw));
	}

	setRequest(index: number, raw: JsonObject): void {
		while (this.count <= index) {
			this.writeRequest(this.count++, {});
		}
		this.writeRequest(index, compactRawRequest(raw));
	}

	truncateRequests(count: number): void {
		const next = Math.max(0, count);
		if (next < this.count) {
			for (const index of [...this.rawCache.keys()]) {
				if (index >= next) {
					this.rawCache.delete(index);
				}
			}
			this.digest.deleteRequestsFrom(this.sessionId, next);
			this.count = next;
			this.noteWrite();
		}
		while (this.count < next) {
			this.writeRequest(this.count++, {});
		}
	}

	private mutateRequest(index: number, mutate: (raw: JsonObject) => void): void {
		while (this.count <= index) {
			this.writeRequest(this.count++, {});
		}
		const entry = this.cachedRaw(index);
		mutate(entry.raw);
		entry.dirty = true;
	}

	/** Writes through and keeps the row cached (clean) so following mutations do not re-read it. */
	private writeRequest(index: number, raw: JsonObject): void {
		this.digest.putRequest(this.sessionId, index, raw);
		this.rawCache.delete(index);
		this.rawCache.set(index, { raw, dirty: false });
		this.evictRaw();
		this.noteWrite();
	}

	private cachedRaw(index: number): { raw: JsonObject; dirty: boolean } {
		const cached = this.rawCache.get(index);
		if (cached) {
			this.rawCache.delete(index);
			this.rawCache.set(index, cached);
			return cached;
		}
		const raw = this.digest.rawRequest(this.sessionId, index);
		if (!raw) {
			throw new RebuildRequiredError(`Request ${index} was mutated after its raw JSON was trimmed.`);
		}
		const entry = { raw, dirty: false };
		this.rawCache.set(index, entry);
		this.evictRaw();
		return entry;
	}

	private evictRaw(): void {
		while (this.rawCache.size > rawCacheEntries) {
			const [index, entry] = this.rawCache.entries().next().value as [number, { raw: JsonObject; dirty: boolean }];
			this.rawCache.delete(index);
			if (entry.dirty) {
				this.digest.putRequest(this.sessionId, index, compactRawRequest(entry.raw));
				this.noteWrite();
			}
		}
	}

	private flushRaw(): void {
		for (const [index, entry] of this.rawCache) {
			if (entry.dirty) {
				entry.dirty = false;
				this.digest.putRequest(this.sessionId, index, compactRawRequest(entry.raw));
				this.writesSinceCommit++;
			}
		}
	}

	private rootSet(path: Path, value: unknown): void {
		const head = path[0];
		if (head === 'customTitle') {
			this.customTitle = typeof value === 'string' ? value.trim() || undefined : undefined;
		} else if (head === 'sessionId') {
			if (typeof value === 'string') {
				this.sessionUuid = value;
			}
		} else if (head === 'inputState') {
			if (path.length === 1) {
				this.inputState = isObject(value) ? value : {};
			} else {
				writePath(this.inputState, path.slice(1), value);
			}
		} else {
			return;
		}
		this.headerDirty = true;
	}

	private rootPush(path: Path, values: unknown[] | undefined, startIndex: number | undefined): void {
		if (path[0] !== 'inputState' || path.length < 2) {
			return;
		}
		pushPath(this.inputState, path.slice(1), values, startIndex);
		this.headerDirty = true;
	}

	/** Persists cached mutations, header and count; called once after the last line. */
	finish(): void {
		this.flushRaw();
		if (this.headerDirty) {
			this.digest.setHeader(this.sessionId, { sessionUuid: this.sessionUuid, customTitle: this.customTitle, inputState: this.inputState });
			this.headerDirty = false;
		}
		this.digest.setRequestCount(this.sessionId, this.count);
	}

	private noteWrite(): void {
		this.writesSinceCommit++;
		if (this.writesSinceCommit >= this.commitEvery) {
			this.writesSinceCommit = 0;
			// Keep write transactions short so readers on other connections are never starved.
			this.digest.commit();
			this.digest.begin();
		}
	}
}

// #endregion

// #region helpers

const rawStringCap = 64 * 1024;
const rawOutputCap = 16 * 1024;

/**
 * Keeps only what `normalizeRequestTurn` reads. Tool results, attachments, variable data and
 * token accounting are dropped; `resultDetails` survives as a presence marker because
 * normalisation only checks that it exists.
 */
export function compactRawRequest(request: JsonObject): JsonObject {
	const compact: JsonObject = {};
	for (const key of ['requestId', 'timestamp', 'modelId', 'modelState'] as const) {
		if (request[key] !== undefined) {
			compact[key] = request[key];
		}
	}
	const message = isObject(request.message) ? request.message : undefined;
	if (message) {
		compact.message = { text: capString(message.text, rawStringCap) };
	}
	const result = isObject(request.result) ? request.result : undefined;
	if (result) {
		const errorDetails = isObject(result.errorDetails) ? result.errorDetails : undefined;
		compact.result = errorDetails ? { errorDetails: { code: errorDetails.code, message: capString(errorDetails.message, 4096) } } : {};
	}
	if (Array.isArray(request.response)) {
		compact.response = request.response.map(part => isObject(part) ? compactResponsePart(part) : part);
	}
	return compact;
}

function compactResponsePart(part: JsonObject): JsonObject {
	const compact: JsonObject = {};
	for (const key of ['kind', 'toolCallId', 'toolId', 'isComplete', 'isConfirmed'] as const) {
		if (part[key] !== undefined) {
			compact[key] = part[key];
		}
	}
	for (const key of ['value', 'content', 'generatedTitle', 'invocationMessage', 'pastTenseMessage'] as const) {
		const value = part[key];
		if (typeof value === 'string') {
			compact[key] = capString(value, rawStringCap);
		} else if (isObject(value) && typeof value.value === 'string') {
			compact[key] = { value: capString(value.value, rawStringCap) };
		} else if (value !== undefined) {
			compact[key] = value;
		}
	}
	if (part.resultDetails !== undefined) {
		compact.resultDetails = {};
	}
	const data = isObject(part.toolSpecificData) ? part.toolSpecificData : undefined;
	if (data) {
		const terminalOutput = isObject(data.terminalCommandOutput) ? data.terminalCommandOutput : undefined;
		const commandLine = isObject(data.commandLine) ? data.commandLine : undefined;
		const cwd = isObject(data.cwd) ? data.cwd : undefined;
		const terminalState = isObject(data.terminalCommandState) ? data.terminalCommandState : undefined;
		compact.toolSpecificData = {
			...(data.kind !== undefined ? { kind: data.kind } : {}),
			...(data.confirmation !== undefined ? { confirmation: isObject(data.confirmation) ? { title: data.confirmation.title } : data.confirmation } : {}),
			...(terminalState ? { terminalCommandState: { exitCode: terminalState.exitCode, duration: terminalState.duration } } : {}),
			...(terminalOutput ? { terminalCommandOutput: { text: capString(terminalOutput.text, rawOutputCap), truncated: terminalOutput.truncated, lineCount: terminalOutput.lineCount } } : {}),
			...(commandLine ? { commandLine: { forDisplay: commandLine.forDisplay, original: commandLine.original } } : {}),
			...(cwd ? { cwd: { fsPath: cwd.fsPath, path: cwd.path } } : {}),
		};
	}
	return compact;
}

function capString(value: unknown, limit: number): unknown {
	return typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…` : value;
}

async function anchorMatches(filePath: string, cursor: DigestCursor): Promise<boolean> {
	return (await readAnchor(filePath, cursor.indexedOffset)) === cursor.anchorHash;
}

async function readAnchor(filePath: string, offset: number): Promise<string | undefined> {
	if (offset <= 0) {
		return undefined;
	}
	const handle = await fs.open(filePath, 'r');
	try {
		const length = Math.min(anchorBytes, offset);
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
		return createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('base64');
	} finally {
		await handle.close();
	}
}

function writePath(root: JsonObject, path: Path, value: unknown): void {
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

function pushPath(root: JsonObject, path: Path, values: readonly unknown[] | undefined, startIndex: number | undefined): void {
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

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

// #endregion
