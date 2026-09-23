import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';

/**
 * Byte-offset tailer for append-only newline-delimited files (JSONL).
 *
 * Invariants:
 * - Never holds a file descriptor between `poke()` calls, so the writer can rename or
 *   truncate the file without interference (Windows rename-over-open semantics).
 * - Emits only complete lines (terminated by `\n`); a trailing partial line is carried as
 *   raw bytes so multibyte UTF-8 sequences are never decoded in pieces.
 * - Detects that the file was rewritten underneath the cursor through independent signals:
 *   inode change (rename rotation), size < offset (truncation), and a hash of the bytes
 *   immediately before the cursor (in-place compaction that kept the same prefix). Any of
 *   them restarts from a safe position and bumps `generation` so consumers drop stale state.
 * - Lines longer than `maximumLineBytes` are skipped rather than buffered, and reported
 *   through `onLineSkipped` so the consumer can degrade gracefully.
 */

export type TailResetReason = 'truncated' | 'rotated' | 'rewritten' | 'desync' | 'oversized';

export interface LineTailerEvents {
	/** Complete lines since the last poke, in order. `generation` identifies the file incarnation. */
	readonly onLines: (lines: readonly string[], generation: number) => void;
	/** The file was rewritten or replaced. Everything derived from earlier lines is stale. */
	readonly onReset?: (reason: TailResetReason, generation: number) => void;
	/** A line exceeded `maximumLineBytes` and was dropped. `index` counts lines seen in this generation. */
	readonly onLineSkipped?: (bytes: number, index: number, generation: number) => void;
	/** The file no longer exists. */
	readonly onGone?: () => void;
}

export interface LineTailerOptions {
	/** Maximum bytes per read; a large backlog is consumed in a loop without blocking the event loop. */
	readonly chunkBytes?: number;
	/** Bytes hashed immediately before the cursor to detect in-place rewrites. */
	readonly anchorBytes?: number;
	/** When attaching to a rotated or oversized file, resume this many bytes before EOF at a line boundary. */
	readonly resyncTailBytes?: number;
	/** Longest line that will be buffered; longer lines are skipped. */
	readonly maximumLineBytes?: number;
	/** On first attach, files larger than this start near EOF instead of at byte 0. */
	readonly skipToTailIfLargerThan?: number;
	/** On first attach, start at the returned offset (a line start) instead of byte 0. */
	readonly initialOffset?: (size: number) => Promise<number>;
}

export interface LineTailerCursor {
	readonly offset: number;
	readonly generation: number;
	readonly size: number;
	readonly lineIndex: number;
}

const defaultChunkBytes = 1024 * 1024;
const defaultAnchorBytes = 4096;
const defaultResyncTailBytes = 64 * 1024;
const defaultMaximumLineBytes = 64 * 1024 * 1024;

export class LineTailer {
	private offset = 0;
	private generation = 0;
	private lineIndex = 0;
	private ino: bigint | undefined;
	private anchorHash: string | undefined;
	private carry: Buffer = Buffer.alloc(0);
	private skipping = false;
	private skippedBytes = 0;
	private lastSize = 0;
	private started = false;
	private disposed = false;
	private running: Promise<void> | undefined;
	private pokeRequested = false;

	constructor(
		readonly filePath: string,
		private readonly events: LineTailerEvents,
		private readonly options: LineTailerOptions = {},
	) {}

	get cursor(): LineTailerCursor {
		return { offset: this.offset, generation: this.generation, size: this.lastSize, lineIndex: this.lineIndex };
	}

	/**
	 * Read everything appended since the last call. Concurrent pokes coalesce: one arriving
	 * while a pass runs schedules exactly one follow-up pass after it.
	 */
	poke(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (this.running) {
			this.pokeRequested = true;
			return this.running;
		}
		this.running = this.run().finally(() => {
			this.running = undefined;
			if (this.pokeRequested && !this.disposed) {
				this.pokeRequested = false;
				void this.poke();
			}
		});
		return this.running;
	}

	/**
	 * The consumer could not interpret a complete line. Treat the file as rewritten
	 * underneath the cursor and start again from the beginning.
	 */
	async resync(): Promise<void> {
		await this.running;
		if (this.disposed) {
			return;
		}
		this.reset('desync', 0);
		await this.poke();
	}

	dispose(): void {
		this.disposed = true;
	}

	private async run(): Promise<void> {
		let stat: BigIntStats;
		try {
			stat = await fs.stat(this.filePath, { bigint: true });
		} catch (error) {
			if (isFileNotFound(error)) {
				if (this.started) {
					this.started = false;
					this.events.onGone?.();
				}
				return;
			}
			throw error;
		}
		const size = Number(stat.size);
		this.lastSize = size;

		if (!this.started) {
			this.started = true;
			this.ino = stat.ino;
			this.generation++;
			const skipThreshold = this.options.skipToTailIfLargerThan;
			if (skipThreshold !== undefined && size > skipThreshold) {
				this.offset = await this.findLineStartNearEnd(size);
				this.events.onReset?.('oversized', this.generation);
			} else if (this.options.initialOffset) {
				this.offset = Math.max(0, Math.min(size, await this.options.initialOffset(size)));
			} else {
				this.offset = 0;
			}
		} else if (stat.ino !== this.ino) {
			this.ino = stat.ino;
			this.reset('rotated', 0);
			const tailBytes = this.options.resyncTailBytes ?? defaultResyncTailBytes;
			if (size > tailBytes) {
				this.offset = await this.findLineStartNearEnd(size);
			}
		} else if (size < this.offset) {
			this.reset('truncated', 0);
		} else if (this.offset > 0 && this.anchorHash !== undefined && await this.anchorChanged()) {
			this.reset('rewritten', 0);
		}

		if (size <= this.offset) {
			return;
		}

		const chunkBytes = this.options.chunkBytes ?? defaultChunkBytes;
		const handle = await fs.open(this.filePath, 'r');
		try {
			while (this.offset < size && !this.disposed) {
				const length = Math.min(chunkBytes, size - this.offset);
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
				if (bytesRead === 0) {
					break;
				}
				this.offset += bytesRead;
				this.consume(buffer.subarray(0, bytesRead));
				if (this.offset < size) {
					// Let timers and I/O callbacks run between chunks of a large backlog.
					await new Promise<void>(resolve => setImmediate(resolve));
				}
			}
			this.anchorHash = await this.readAnchor(handle);
		} finally {
			await handle.close();
		}
	}

	private consume(chunk: Buffer): void {
		const maximumLineBytes = this.options.maximumLineBytes ?? defaultMaximumLineBytes;
		let data = chunk;
		let start = 0;

		if (this.skipping) {
			const newline = data.indexOf(0x0a);
			if (newline < 0) {
				this.skippedBytes += data.length;
				return;
			}
			this.skippedBytes += newline + 1;
			this.skipping = false;
			this.events.onLineSkipped?.(this.skippedBytes, this.lineIndex, this.generation);
			this.lineIndex++;
			this.skippedBytes = 0;
			start = newline + 1;
		} else if (this.carry.length > 0) {
			data = Buffer.concat([this.carry, chunk]);
		}

		const lines: string[] = [];
		for (;;) {
			const newline = data.indexOf(0x0a, start);
			if (newline < 0) {
				break;
			}
			let end = newline;
			if (end > start && data[end - 1] === 0x0d) {
				end--;
			}
			if (end > start) {
				lines.push(data.subarray(start, end).toString('utf8'));
			}
			this.lineIndex++;
			start = newline + 1;
		}

		const remainder = data.subarray(start);
		if (remainder.length > maximumLineBytes) {
			this.carry = Buffer.alloc(0);
			this.skipping = true;
			this.skippedBytes = remainder.length;
		} else {
			// Copy so the carried bytes do not pin the whole read buffer alive.
			this.carry = remainder.length > 0 ? Buffer.from(remainder) : Buffer.alloc(0);
		}
		if (lines.length > 0) {
			this.events.onLines(lines, this.generation);
		}
	}

	private reset(reason: TailResetReason, offset: number): void {
		this.generation++;
		this.offset = offset;
		this.lineIndex = 0;
		this.carry = Buffer.alloc(0);
		this.skipping = false;
		this.skippedBytes = 0;
		this.anchorHash = undefined;
		this.events.onReset?.(reason, this.generation);
	}

	private async anchorChanged(): Promise<boolean> {
		const handle = await fs.open(this.filePath, 'r');
		try {
			return (await this.readAnchor(handle)) !== this.anchorHash;
		} finally {
			await handle.close();
		}
	}

	private async readAnchor(handle: fs.FileHandle): Promise<string | undefined> {
		if (this.offset === 0) {
			return undefined;
		}
		const anchorBytes = this.options.anchorBytes ?? defaultAnchorBytes;
		const length = Math.min(anchorBytes, this.offset);
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, this.offset - length);
		return createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('base64');
	}

	/** Position after the first newline found in the last `resyncTailBytes`; EOF if there is none. */
	private async findLineStartNearEnd(size: number): Promise<number> {
		const tailBytes = this.options.resyncTailBytes ?? defaultResyncTailBytes;
		const from = Math.max(0, size - tailBytes);
		const handle = await fs.open(this.filePath, 'r');
		try {
			const buffer = Buffer.allocUnsafe(size - from);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
			const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
			return newline < 0 ? size : from + newline + 1;
		} finally {
			await handle.close();
		}
	}
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
