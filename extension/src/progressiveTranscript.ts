import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { TranscriptBlock, TranscriptTurn } from './transcript';

const maximumRemoteFieldCharacters = 256 * 1024;
const truncationNotice = '\n\n[Content truncated in remote view. Open this chat in VS Code for the full content.]';

export interface ProgressiveTranscriptIndex {
	readonly filePath: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly sessionId: string;
	readonly title: string;
	readonly turnOffsets: readonly number[];
	readonly complete: boolean;
}

export interface ProgressiveTranscriptPage {
	readonly turns: readonly TranscriptTurn[];
	readonly totalCount: number;
	readonly start: number;
	readonly end: number;
	readonly hasEarlier: boolean;
}

export async function indexProgressiveTranscript(filePath: string): Promise<ProgressiveTranscriptIndex> {
	const statBefore = await fs.stat(filePath);
	const turnOffsets: number[] = [];
	const seenUserEventIds = new Set<string>();
	let sessionId = '';
	let title = '';
	let complete = true;
	let previousUserText = '';
	let assistantSeen = false;

	await scanJsonLines(filePath, 0, statBefore.size, (value, offset) => {
		const type = stringValue(value.type);
		const data = recordValue(value.data);
		if (type === 'session.start') {
			sessionId = stringValue(data?.sessionId) ?? sessionId;
			return;
		}
		if (type === 'assistant.message') {
			assistantSeen = true;
			return;
		}
		if (type !== 'user.message') {return;}
		const eventId = stringValue(value.id);
		if (eventId && seenUserEventIds.has(eventId)) {return;}
		if (eventId) {seenUserEventIds.add(eventId);}
		const userText = cleanUserText(stringValue(data?.content) ?? '');
		if (turnOffsets.length > 0 && userText === previousUserText && !assistantSeen) {
			turnOffsets[turnOffsets.length - 1] = offset;
			return;
		}
		turnOffsets.push(offset);
		previousUserText = userText;
		assistantSeen = false;
		if (!title) {title = summarize(cleanTitleSource(userText) || 'Copilot chat', 72);}
		return;
	}, () => { complete = false; });

	const statAfter = await fs.stat(filePath);
	if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {complete = false;}
	return {
		filePath,
		size: statAfter.size,
		mtimeMs: statAfter.mtimeMs,
		sessionId,
		title: title || 'Copilot chat',
		turnOffsets,
		complete,
	};
}

export async function loadProgressiveTranscriptPage(
	index: ProgressiveTranscriptIndex,
	requestedStart: number,
	requestedLimit = 40,
	maximumPageBytes = 4 * 1024 * 1024,
): Promise<ProgressiveTranscriptPage> {
	const totalCount = index.turnOffsets.length;
	const start = Math.max(0, Math.min(Math.floor(requestedStart), totalCount));
	const requestedEnd = Math.min(totalCount, start + Math.max(1, Math.floor(requestedLimit)));
	const startOffset = index.turnOffsets[start] ?? index.size;
	const requestedEndOffset = index.turnOffsets[requestedEnd] ?? index.size;
	const endOffset = Math.min(requestedEndOffset, startOffset + maximumPageBytes);
	const acceptedOffsets = new Set(index.turnOffsets.slice(start, requestedEnd));
	const turns: TranscriptTurn[] = [];
	let current: MutableTurn | undefined;
	let consumedEnd = start;

	const flush = () => {
		if (!current) {return;}
		turns.push(finishTurn(current, start + turns.length));
		current = undefined;
		consumedEnd = start + turns.length;
	};

	await scanJsonLines(index.filePath, startOffset, endOffset, (value, offset) => {
		const type = stringValue(value.type);
		const data = recordValue(value.data);
		if (type === 'user.message') {
			if (!acceptedOffsets.has(offset)) {return;}
			if (current && current.completedAt === undefined) {current.completedAt = parseTimestamp(value.timestamp);}
			flush();
			current = {
				id: stringValue(value.id),
				timestamp: parseTimestamp(value.timestamp),
				userText: limitField(cleanUserText(stringValue(data?.content) ?? '')),
				assistantText: '',
				thinking: '',
				completedAt: undefined,
			};
			return;
		}
		if (!current) {return;}
		if (type === 'assistant.message') {
			current.assistantText = limitField(stringValue(data?.content)?.trim() ?? current.assistantText);
			current.thinking = limitField(stringValue(data?.reasoningText)?.trim() ?? current.thinking);
		} else if (type === 'assistant.turn_end') {
			current.completedAt = parseTimestamp(value.timestamp);
		}
	});
	flush();

	return {
		turns,
		totalCount,
		start,
		end: consumedEnd,
		hasEarlier: start > 0,
	};
}

interface MutableTurn {
	id?: string;
	timestamp: number;
	userText: string;
	assistantText: string;
	thinking: string;
	completedAt?: number;
}

function finishTurn(turn: MutableTurn, index: number): TranscriptTurn {
	const blocks: TranscriptBlock[] = [];
	if (turn.thinking) {blocks.push({ kind: 'thinking', text: turn.thinking, title: '' });}
	if (turn.assistantText) {blocks.push({ kind: 'text', text: turn.assistantText });}
	return {
		id: turn.id ?? `transcript-${index}`,
		editable: turn.id !== undefined,
		timestamp: turn.timestamp,
		userText: turn.userText,
		thinking: turn.thinking,
		thinkingTitle: '',
		assistantText: turn.assistantText,
		activities: [],
		blocks,
		status: turn.completedAt === undefined ? 'working' : 'completed',
		completedAt: turn.completedAt,
	};
}

async function scanJsonLines(
	filePath: string,
	start: number,
	endExclusive: number,
	onValue: (value: Record<string, unknown>, offset: number) => void,
	onPartial?: () => void,
): Promise<void> {
	if (endExclusive <= start) {return;}
	const stream = createReadStream(filePath, { start, end: endExclusive - 1 });
	let pending = Buffer.alloc(0);
	let pendingOffset = start;
	for await (const chunk of stream) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
		let newline: number;
		while ((newline = pending.indexOf(0x0a)) >= 0) {
			const line = pending.subarray(0, newline);
			parseLine(line, pendingOffset, onValue);
			pending = pending.subarray(newline + 1);
			pendingOffset += newline + 1;
		}
	}
	if (pending.length > 0) {
		if (endExclusive < (await fs.stat(filePath)).size) {onPartial?.();}
		else {parseLine(pending, pendingOffset, onValue, onPartial);}
	}
}

function parseLine(
	line: Buffer,
	offset: number,
	onValue: (value: Record<string, unknown>, offset: number) => void,
	onPartial?: () => void,
): void {
	const text = line.toString('utf8').trim();
	if (!text) {return;}
	try {
		const value = JSON.parse(text) as unknown;
		if (isRecord(value)) {onValue(value, offset);}
	} catch {
		onPartial?.();
	}
}

function limitField(value: string): string {
	return value.length <= maximumRemoteFieldCharacters
		? value
		: `${value.slice(0, maximumRemoteFieldCharacters)}${truncationNotice}`;
}

function cleanUserText(value: string): string {
	return value.replace(/^\s*<attachments>[\s\S]*?<\/attachments>\s*/i, '').trim();
}

function summarize(value: string, length: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function parseTimestamp(value: unknown): number {
	if (typeof value !== 'string') {return 0;}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : 0;
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

function cleanTitleSource(value: string): string {
	return value
		.replace(/^[\s=_*#-]{8,}/, '')
		.replace(/\s*[=_*#-]{8,}[\s\S]*$/, '')
		.trim();
}