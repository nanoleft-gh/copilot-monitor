import { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';

export async function readStableUtf8(filePath: string, statBefore: Stats): Promise<{
	readonly content: string;
	readonly statAfter: Stats;
	readonly stable: boolean;
}> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(statBefore.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) {
				break;
			}
			offset += bytesRead;
		}
		const statAfter = await fs.stat(filePath);
		return {
			content: buffer.subarray(0, offset).toString('utf8'),
			statAfter,
			stable: offset === statBefore.size
				&& statBefore.size === statAfter.size
				&& statBefore.mtimeMs === statAfter.mtimeMs,
		};
	} finally {
		await handle.close();
	}
}