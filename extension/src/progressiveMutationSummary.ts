import * as fs from 'node:fs/promises';

export async function readProgressiveMutationSummary(
	filePath: string,
	maximumBytes = 4 * 1024 * 1024,
): Promise<{ readonly sessionId: string; readonly title: string }> {
	const stat = await fs.stat(filePath);
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(Math.min(stat.size, maximumBytes));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		let sessionId = '';
		let customTitle = '';
		let firstPrompt = '';
		for (const line of buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
			if (!line) {continue;}
			if (line.length > 1024 * 1024) {
				const messageMatch = /"message":\{"text":("(?:\\.|[^"\\])*")/.exec(line);
				if (messageMatch) {
					try { firstPrompt = JSON.parse(messageMatch[1]) as string; } catch { /* keep scanning */ }
				}
				if (firstPrompt) {break;}
				continue;
			}
			try {
				const mutation = JSON.parse(line) as unknown;
				if (!isRecord(mutation)) {continue;}
				if (mutation.kind === 0) {
					const state = recordValue(mutation.v);
					sessionId = stringValue(state?.sessionId) ?? sessionId;
					customTitle = stringValue(state?.customTitle)?.trim() ?? customTitle;
				} else if (mutation.kind === 2 && Array.isArray(mutation.k)
					&& mutation.k.length === 1 && mutation.k[0] === 'requests' && Array.isArray(mutation.v)) {
					const request = mutation.v.find(isRecord);
					firstPrompt = stringValue(recordValue(request?.message)?.text)?.trim() ?? firstPrompt;
				}
				if (customTitle || firstPrompt) {break;}
			} catch {
				// The bounded prefix may end in a partial mutation line.
			}
		}
		return { sessionId, title: customTitle || summarize(firstPrompt || 'Copilot chat', 72) };
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