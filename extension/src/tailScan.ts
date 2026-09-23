import * as fs from 'node:fs/promises';

/**
 * Finds where to start tailing a live log so that only the newest few turns are read.
 * Scans the file backwards in blocks for lines that begin a turn (they carry `marker` in
 * their first bytes) and returns the offset of the `turnsBack`-th such line from the end.
 * Falls back to the earliest complete line inside the look-back window, or 0 for small files.
 */

export interface TailScanOptions {
	/** Bytes that identify a turn-opening line, e.g. `"type":"user.message"`. */
	readonly marker: string;
	/** How many turn-opening lines back from the end to start at. */
	readonly turnsBack?: number;
	readonly blockBytes?: number;
	/** Never read more than this from the end; older turns are left to the digest. */
	readonly maximumLookbackBytes?: number;
	/** Only the first bytes of a line are checked for the marker. */
	readonly markerWindowBytes?: number;
}

const defaultTurnsBack = 2;
const defaultBlockBytes = 256 * 1024;
const defaultMaximumLookbackBytes = 4 * 1024 * 1024;
const defaultMarkerWindowBytes = 256;

export async function findTailStart(filePath: string, size: number, options: TailScanOptions): Promise<number> {
	if (size <= 0) {
		return 0;
	}
	const marker = Buffer.from(options.marker, 'utf8');
	const turnsBack = Math.max(1, options.turnsBack ?? defaultTurnsBack);
	const blockBytes = options.blockBytes ?? defaultBlockBytes;
	const lowest = Math.max(0, size - (options.maximumLookbackBytes ?? defaultMaximumLookbackBytes));
	const window = options.markerWindowBytes ?? defaultMarkerWindowBytes;
	const handle = await fs.open(filePath, 'r');
	try {
		let end = size;
		let carry = Buffer.alloc(0);
		let earliestLineStart = size;
		let found = 0;
		const opensTurn = (data: Buffer, lineStart: number, lineEnd: number): boolean =>
			data.subarray(lineStart, Math.min(lineEnd, lineStart + window)).includes(marker);

		while (end > lowest) {
			const start = Math.max(lowest, end - blockBytes);
			const block = Buffer.allocUnsafe(end - start);
			const { bytesRead } = await handle.read(block, 0, block.length, start);
			const data = carry.length > 0 ? Buffer.concat([block.subarray(0, bytesRead), carry]) : block.subarray(0, bytesRead);
			const firstNewline = data.indexOf(0x0a);
			// Everything before the first newline belongs to a line that started in an earlier block.
			const firstComplete = start === 0 ? 0 : firstNewline < 0 ? data.length : firstNewline + 1;
			let lineEnd = data.length;
			for (;;) {
				const newline = lineEnd > firstComplete ? data.lastIndexOf(0x0a, lineEnd - 1) : -1;
				const lineStart = newline < firstComplete ? firstComplete : newline + 1;
				if (lineStart >= firstComplete && lineEnd > lineStart && opensTurn(data, lineStart, lineEnd)) {
					found++;
					if (found >= turnsBack) {
						return start + lineStart;
					}
				}
				if (newline < firstComplete) {
					break;
				}
				lineEnd = newline;
			}
			if (firstComplete < data.length) {
				earliestLineStart = start + firstComplete;
			}
			if (start === 0) {
				return 0;
			}
			carry = Buffer.from(data.subarray(0, firstComplete));
			end = start;
		}
		return earliestLineStart;
	} finally {
		await handle.close();
	}
}
