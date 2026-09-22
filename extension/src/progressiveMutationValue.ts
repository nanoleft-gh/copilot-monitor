import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import Assembler = require('stream-json/Assembler');
import Filter = require('stream-json/filters/Filter');
import { parser } from 'stream-json';
import { chain } from 'stream-chain';

const maximumPrefixBytes = 1024;

interface MutationRange {
	readonly offset: number;
	readonly length: number;
	readonly kind: number;
	readonly path: readonly (string | number)[];
}

export async function readProgressiveMutationValue(
	filePath: string,
	targetPath: readonly (string | number)[],
): Promise<{ readonly value: unknown; readonly complete: boolean; readonly stable: boolean }> {
	const statBefore = await fs.stat(filePath);
	const ranges = await indexRelevantRanges(filePath, targetPath);
	let value: unknown;
	let complete = true;
	for (const range of ranges) {
		try {
			const mutation = await parseProjectedMutation(filePath, range, targetPath);
			if (!isRecord(mutation)) {continue;}
			if (range.kind === 0) {
				value = readAtPath(mutation.v, targetPath);
			} else if (range.kind === 1) {
				value = applySet(value, targetPath, range.path, mutation.v);
			} else if (range.kind === 3) {
				value = applyDelete(value, targetPath, range.path);
			}
		} catch (error) {
			if (range.offset + range.length === statBefore.size) {
				complete = false;
				break;
			}
			throw error;
		}
	}
	const statAfter = await fs.stat(filePath);
	return {
		value,
		complete,
		stable: statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs,
	};
}

async function indexRelevantRanges(filePath: string, targetPath: readonly (string | number)[]): Promise<MutationRange[]> {
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
			addRelevantRange(ranges, offset, length, prefix, targetPath);
			offset += length + 1;
			length = 0;
			prefix = Buffer.alloc(0);
			cursor = newline + 1;
		}
	}
	if (length > 0) {addRelevantRange(ranges, offset, length, prefix, targetPath);}
	return ranges;
}

function addRelevantRange(
	ranges: MutationRange[],
	offset: number,
	length: number,
	prefix: Buffer,
	targetPath: readonly (string | number)[],
): void {
	const classified = classify(prefix.toString('utf8'));
	if (classified && (classified.kind === 0 || pathsOverlap(classified.path, targetPath))) {
		ranges.push({ offset, length, ...classified });
	}
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

async function parseProjectedMutation(
	filePath: string,
	range: MutationRange,
	targetPath: readonly (string | number)[],
): Promise<unknown> {
	const projectedPath = range.kind === 0
		? targetPath
		: isPathPrefix(range.path, targetPath) ? targetPath.slice(range.path.length) : [];
	const pipeline = chain([
		createReadStream(filePath, { start: range.offset, end: range.offset + range.length - 1 }),
		parser({ packKeys: true, packStrings: false, packNumbers: true }),
		new Filter({
			filter: stack => includeProjectedPath(stack, projectedPath),
			streamValues: true,
		}),
		new ExactStringPacker(),
	]);
	const assembler = new Assembler();
	pipeline.on('data', token => assembler.consume(token));
	await new Promise<void>((resolve, reject) => {
		pipeline.once('end', resolve);
		pipeline.once('error', reject);
	});
	return assembler.current;
}

class ExactStringPacker extends Transform {
	private active = false;
	private value = '';

	constructor() {
		super({ objectMode: true });
	}

	_transform(token: { name: string; value?: string }, _encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void): void {
		if (token.name === 'startString') {
			this.active = true;
			this.value = '';
			return callback(null, token);
		}
		if (token.name === 'stringChunk' && this.active) {
			this.value += token.value ?? '';
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

function includeProjectedPath(stack: readonly (string | number | null)[], projectedPath: readonly (string | number)[]): boolean {
	const root = stack[0];
	if (root === 'kind' || root === 'k') {return true;}
	if (root !== 'v') {return false;}
	const path = stack.slice(1).filter((value): value is string | number => value !== null);
	return isPathPrefix(path, projectedPath) || isPathPrefix(projectedPath, path);
}

function applySet(
	current: unknown,
	targetPath: readonly (string | number)[],
	mutationPath: readonly (string | number)[],
	mutationValue: unknown,
): unknown {
	if (isPathPrefix(mutationPath, targetPath)) {
		return readAtPath(mutationValue, targetPath.slice(mutationPath.length));
	}
	if (!isRecord(current)) {return current;}
	setAtPath(current, mutationPath.slice(targetPath.length), mutationValue);
	return current;
}

function applyDelete(
	current: unknown,
	targetPath: readonly (string | number)[],
	mutationPath: readonly (string | number)[],
): unknown {
	if (isPathPrefix(mutationPath, targetPath)) {return undefined;}
	if (!isRecord(current)) {return current;}
	deleteAtPath(current, mutationPath.slice(targetPath.length));
	return current;
}

function readAtPath(value: unknown, path: readonly (string | number)[]): unknown {
	let current = value;
	for (const key of path) {
		current = Array.isArray(current) ? current[Number(key)] : isRecord(current) ? current[String(key)] : undefined;
	}
	return current;
}

function setAtPath(target: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
	if (path.length === 0) {return;}
	let current: Record<string, unknown> | unknown[] = target;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index];
		const next: unknown = Array.isArray(current) ? current[Number(key)] : current[String(key)];
		if (!isRecord(next) && !Array.isArray(next)) {return;}
		current = next;
	}
	const key = path.at(-1)!;
	if (Array.isArray(current)) {current[Number(key)] = value;}
	else {current[String(key)] = value;}
}

function deleteAtPath(target: Record<string, unknown>, path: readonly (string | number)[]): void {
	if (path.length === 0) {return;}
	let current: unknown = target;
	for (const key of path.slice(0, -1)) {
		current = Array.isArray(current) ? current[Number(key)] : isRecord(current) ? current[String(key)] : undefined;
	}
	const key = path.at(-1)!;
	if (Array.isArray(current)) {delete current[Number(key)];}
	else if (isRecord(current)) {delete current[String(key)];}
}

function pathsOverlap(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
	return isPathPrefix(left, right) || isPathPrefix(right, left);
}

function isPathPrefix(prefix: readonly (string | number)[], path: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}