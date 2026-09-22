import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import Assembler = require('stream-json/Assembler');
import Filter = require('stream-json/filters/Filter');
import { parser } from 'stream-json';
import { chain } from 'stream-chain';
import { HistoryPageResult } from './protocol';
import { normalizeRequestTurn } from './transcript';

const maximumFieldCharacters = 64 * 1024;
const maximumPrefixBytes = 1024;

export interface MutationRange {
	readonly offset: number;
	readonly length: number;
	readonly kind: number;
	readonly path: readonly (string | number)[];
}

export interface PagedMutationHistoryIndex {
	readonly filePath: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly sessionId: string;
	readonly title: string;
	readonly requests: readonly Record<string, unknown>[];
	readonly arrayIndices: readonly number[];
	readonly rangesByRequest: ReadonlyMap<number, readonly MutationRange[]>;
}

export async function indexPagedMutationHistory(filePath: string): Promise<PagedMutationHistoryIndex> {
	const statBefore = await fs.stat(filePath);
	const ranges = await indexRanges(filePath);
	let sessionId = '';
	let customTitle = '';
	const requestsByArrayIndex = new Map<number, Record<string, unknown>>();
	const rangesByArrayIndex = new Map<number, MutationRange[]>();
	let requestArrayLength = 0;

	for (const range of ranges) {
		if (range.kind === 0) {
			const initial = range.length <= 1024 * 1024
				? await readSmallRange(filePath, range)
				: await parseCappedMutation(filePath, range);
			const state = recordValue(initial?.v);
			sessionId = stringValue(state?.sessionId) ?? sessionId;
			customTitle = stringValue(state?.customTitle)?.trim() ?? customTitle;
			const initialRequests = Array.isArray(state?.requests) ? state.requests : [];
			requestArrayLength = initialRequests.length;
			for (let index = 0; index < initialRequests.length; index++) {
				const request = initialRequests[index];
				if (!isRecord(request)) {continue;}
				requestsByArrayIndex.set(index, sanitizeRequest(request, true));
				rangesByArrayIndex.set(index, []);
			}
			continue;
		}
		if (range.path[0] !== 'requests') {continue;}
		if (range.kind === 2 && range.path.length === 1) {
			const mutation = await parseCappedMutation(filePath, range);
			const startIndex = typeof mutation?.i === 'number' ? Math.max(0, Math.floor(mutation.i)) : requestArrayLength;
			for (const index of [...requestsByArrayIndex.keys()]) {
				if (index >= startIndex) {requestsByArrayIndex.delete(index);}
			}
			for (const index of [...rangesByArrayIndex.keys()]) {
				if (index >= startIndex) {rangesByArrayIndex.delete(index);}
			}
			requestArrayLength = startIndex;
			for (const value of Array.isArray(mutation?.v) ? mutation.v : []) {
				if (!isRecord(value)) {continue;}
				const requestIndex = requestArrayLength++;
				requestsByArrayIndex.set(requestIndex, sanitizeRequest(value));
				rangesByArrayIndex.set(requestIndex, [range]);
			}
			continue;
		}
		const requestIndex = typeof range.path[1] === 'number' ? range.path[1] : undefined;
		if (requestIndex === undefined) {continue;}
		const list = rangesByArrayIndex.get(requestIndex) ?? [];
		list.push(range);
		rangesByArrayIndex.set(requestIndex, list);
	}

	const liveArrayIndices = [...requestsByArrayIndex.keys()].sort((left, right) => left - right);
	const requests = liveArrayIndices.map(index => requestsByArrayIndex.get(index)!);
	const rangesByRequest = new Map<number, readonly MutationRange[]>(
		liveArrayIndices.map((arrayIndex, denseIndex) => [denseIndex, rangesByArrayIndex.get(arrayIndex) ?? []]),
	);
	const firstPrompt = requests.map(request => stringValue(recordValue(request.message)?.text)?.trim()).find(Boolean) ?? '';
	const statAfter = await fs.stat(filePath);
	if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
		throw new Error('The chat changed while its progressive index was being built.');
	}
	return {
		filePath,
		size: statAfter.size,
		mtimeMs: statAfter.mtimeMs,
		sessionId,
		title: customTitle || summarize(firstPrompt || 'Copilot chat', 72),
		requests,
		arrayIndices: liveArrayIndices,
		rangesByRequest,
	};
}

export async function loadPagedMutationHistory(
	index: PagedMutationHistoryIndex,
	requestedStart: number,
	requestedLimit = 40,
	revision = '',
): Promise<HistoryPageResult> {
	const totalCount = index.requests.length;
	const start = Math.max(0, Math.min(Math.floor(requestedStart), totalCount));
	const end = Math.min(totalCount, start + Math.max(1, Math.floor(requestedLimit)));
	const turns = [];
	for (let requestIndex = start; requestIndex < end; requestIndex++) {
		const request = structuredClone(index.requests[requestIndex] ?? {});
		const arrayIndex = index.arrayIndices[requestIndex];
		for (const range of index.rangesByRequest.get(requestIndex) ?? []) {
			if (range.kind === 2 && range.path.length === 1) {continue;}
			applyMutation(request, arrayIndex, range, await parseCappedMutation(index.filePath, range));
		}
		turns.push(normalizeRequestTurn(request, requestIndex));
	}
	return { turns, totalCount, start, end, hasEarlier: start > 0, revision };
}

async function indexRanges(filePath: string): Promise<MutationRange[]> {
	const ranges: MutationRange[] = [];
	let offset = 0;
	let length = 0;
	let prefix = Buffer.alloc(0);
	for await (const chunk of createReadStream(filePath)) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let cursor = 0;
		while (cursor < bytes.length) {
			const newline = bytes.indexOf(0x0a, cursor);
			const end = newline < 0 ? bytes.length : newline;
			const part = bytes.subarray(cursor, end);
			if (prefix.length < maximumPrefixBytes) {
				prefix = Buffer.concat([prefix, part.subarray(0, maximumPrefixBytes - prefix.length)]);
			}
			length += part.length;
			if (newline < 0) {break;}
			const classified = classify(prefix.toString('utf8'));
			if (classified) {ranges.push({ offset, length, ...classified });}
			offset += length + 1;
			length = 0;
			prefix = Buffer.alloc(0);
			cursor = newline + 1;
		}
	}
	if (length > 0) {
		const classified = classify(prefix.toString('utf8'));
		if (classified) {ranges.push({ offset, length, ...classified });}
	}
	return ranges;
}

function classify(prefix: string): Pick<MutationRange, 'kind' | 'path'> | undefined {
	const kindMatch = /^\{"kind":(\d+)/.exec(prefix);
	if (!kindMatch) {return undefined;}
	const kind = Number(kindMatch[1]);
	if (kind === 0) {return { kind, path: [] };}
	const pathMatch = /,"k":(\[[^\]]*\])/.exec(prefix);
	if (!pathMatch) {return undefined;}
	try {
		const path = JSON.parse(pathMatch[1]) as unknown;
		return Array.isArray(path) && path.every(value => typeof value === 'string' || typeof value === 'number')
			? { kind, path: path as (string | number)[] }
			: undefined;
	} catch {
		return undefined;
	}
}

async function parseCappedMutation(filePath: string, range: MutationRange): Promise<Record<string, unknown> | undefined> {
	const pipeline = chain([
		createReadStream(filePath, { start: range.offset, end: range.offset + range.length - 1 }),
		parser({ packKeys: true, packStrings: false, packNumbers: true }),
		new CappedStringPacker(maximumFieldCharacters),
		new Filter({ filter: stack => includePath(stack, range.path), streamValues: true }),
	]);
	const assembler = new Assembler();
	pipeline.on('data', token => assembler.consume(token));
	await new Promise<void>((resolve, reject) => {
		pipeline.once('end', resolve);
		pipeline.once('error', reject);
	});
	return isRecord(assembler.current) ? assembler.current : undefined;
}

class CappedStringPacker extends Transform {
	private active = false;
	private value = '';

	constructor(private readonly maximumCharacters: number) {
		super({ objectMode: true });
	}

	_transform(token: { name: string; value?: string }, _encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void {
		if (token.name === 'startString') {
			this.active = true;
			this.value = '';
			return callback(null, token);
		}
		if (token.name === 'stringChunk' && this.active) {
			if (this.value.length < this.maximumCharacters && token.value) {
				this.value += token.value.slice(0, this.maximumCharacters - this.value.length);
			}
			return callback();
		}
		if (token.name === 'endString') {
			this.active = false;
			this.push(token);
			return callback(null, { name: 'stringValue', value: this.value });
		}
		callback(null, token);
	}
}

function sanitizeRequest(request: Record<string, unknown>, includeResponse = false): Record<string, unknown> {
	return {
		requestId: request.requestId,
		timestamp: request.timestamp,
		message: isRecord(request.message) ? { text: request.message.text } : undefined,
		modelState: isRecord(request.modelState) ? { value: request.modelState.value, completedAt: request.modelState.completedAt } : undefined,
		result: sanitizeResult(request.result),
		response: includeResponse && Array.isArray(request.response)
			? request.response.flatMap(value => isRecord(value) ? [sanitizeResponse(value)] : [])
			: [],
	};
}

function sanitizeResult(value: unknown): Record<string, unknown> | undefined {
	const result = recordValue(value);
	const errorDetails = recordValue(result?.errorDetails);
	if (!errorDetails) {return undefined;}
	return {
		errorDetails: {
			code: errorDetails.code,
			message: errorDetails.message,
		},
	};
}

function sanitizeResponse(part: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of ['kind', 'value', 'generatedTitle', 'content', 'toolCallId', 'toolId', 'isComplete'] as const) {
		if (part[key] !== undefined) {result[key] = part[key];}
	}
	for (const key of ['invocationMessage', 'pastTenseMessage'] as const) {
		if (isRecord(part[key])) {result[key] = { value: part[key].value };}
	}
	return result;
}

function applyMutation(
	request: Record<string, unknown>,
	arrayIndex: number,
	range: MutationRange,
	mutation: Record<string, unknown> | undefined,
): void {
	if (!mutation) {return;}
	if (range.kind === 0) {
		const state = recordValue(mutation.v);
		const requests = Array.isArray(state?.requests) ? state.requests : [];
		const source = requests[arrayIndex];
		if (isRecord(source)) {Object.assign(request, sanitizeRequest(source, true));}
		return;
	}
	const path = range.path.slice(2);
	if (path.length === 0) {return;}
	let value = mutation.v;
	if (path[0] === 'response' && Array.isArray(value)) {value = value.flatMap(item => isRecord(item) ? [sanitizeResponse(item)] : []);}
	if (path[0] === 'message' && isRecord(value)) {value = { text: value.text };}
	if (path[0] === 'modelState' && isRecord(value)) {value = { value: value.value, completedAt: value.completedAt };}
	if (path[0] === 'result') {value = sanitizeResult(value);}
	if (range.kind === 1) {setAtPath(request, path, value);}
	else if (range.kind === 2) {pushAtPath(request, path, value);}
}

function setAtPath(target: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
	let current: Record<string, unknown> | unknown[] = target;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index];
		const nextKey = path[index + 1];
		const next: unknown = Array.isArray(current) ? current[Number(key)] : current[String(key)];
		if (isRecord(next) || Array.isArray(next)) {current = next;}
		else {
			const created: Record<string, unknown> | unknown[] = typeof nextKey === 'number' ? [] : {};
			if (Array.isArray(current)) {current[Number(key)] = created;}
			else {current[String(key)] = created;}
			current = created;
		}
	}
	const key = path.at(-1)!;
	if (Array.isArray(current)) {current[Number(key)] = value;}
	else {current[String(key)] = value;}
}

function pushAtPath(target: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
	let current: unknown = target;
	for (const key of path) {current = Array.isArray(current) ? current[Number(key)] : isRecord(current) ? current[String(key)] : undefined;}
	if (Array.isArray(current) && Array.isArray(value)) {current.push(...value);}
}

async function readSmallRange(filePath: string, range: MutationRange): Promise<Record<string, unknown> | undefined> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(range.length);
		const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
		const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
		return isRecord(value) ? value : undefined;
	} finally {
		await handle.close();
	}
}

function summarize(value: string, length: number): string {
	const line = value.replace(/\s+/g, ' ').trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includePath(stack: readonly (string | number | null)[], mutationPath: readonly (string | number)[]): boolean {
	const root = stack[0];
	if (root === 'kind' || root === 'k' || root === 'i') {return true;}
	if (root !== 'v') {return false;}
	const path = stack.slice(1).filter((value): value is string | number => value !== null);
	if (mutationPath.length === 0) {
		if (path[0] === 'sessionId' || path[0] === 'customTitle') {return true;}
		if (path[0] !== 'requests' || typeof path[1] !== 'number') {return false;}
		return requestPathIncluded(path.slice(2));
	}
	if (mutationPath.length === 1) {
		return typeof path[0] === 'number' && requestPathIncluded(path.slice(1));
	}
	const property = mutationPath[2];
	if (property === 'response') {return typeof path[0] === 'number' && responsePathIncluded(path.slice(1));}
	if (property === 'message') {return path.length === 0 || path[0] === 'text';}
	if (property === 'modelState') {return path.length === 0 || path[0] === 'value' || path[0] === 'completedAt';}
	return property === 'requestId' || property === 'timestamp';
}

function requestPathIncluded(path: readonly (string | number)[]): boolean {
	const root = path[0];
	if (root === 'requestId' || root === 'timestamp') {return true;}
	if (root === 'message') {return path.length === 1 || path[1] === 'text';}
	if (root === 'modelState') {return path.length === 1 || path[1] === 'value' || path[1] === 'completedAt';}
	return root === 'response' && responsePathIncluded(path.slice(1));
}

function responsePathIncluded(path: readonly (string | number)[]): boolean {
	const relative = typeof path[0] === 'number' ? path.slice(1) : path;
	const root = relative[0];
	if (root === 'kind' || root === 'value' || root === 'generatedTitle' || root === 'content'
		|| root === 'toolCallId' || root === 'toolId' || root === 'isComplete') {return true;}
	return (root === 'invocationMessage' || root === 'pastTenseMessage')
		&& (relative.length === 1 || relative[1] === 'value');
}

export interface SerializedPagedMutationHistoryIndex extends Omit<PagedMutationHistoryIndex, 'rangesByRequest'> {
	readonly rangesByRequest: readonly (readonly [number, readonly MutationRange[]])[];
}

export function serializePagedMutationHistoryIndex(index: PagedMutationHistoryIndex): SerializedPagedMutationHistoryIndex {
	return { ...index, rangesByRequest: [...index.rangesByRequest.entries()] };
}

export function deserializePagedMutationHistoryIndex(index: SerializedPagedMutationHistoryIndex): PagedMutationHistoryIndex {
	if (!index || typeof index.filePath !== 'string' || typeof index.size !== 'number'
		|| typeof index.mtimeMs !== 'number' || !Array.isArray(index.requests)
		|| !Array.isArray(index.arrayIndices) || !Array.isArray(index.rangesByRequest)) {
		throw new Error('Progressive history cache is invalid.');
	}
	return { ...index, rangesByRequest: new Map(index.rangesByRequest) };
}