import * as fs from 'node:fs/promises';

/**
 * Derives a display title for a session whose entry is not in VS Code's index yet by
 * reading only the first `maximumBytes` of its mutation log. Used for brand-new sessions
 * during the ≤60 s window before VS Code flushes its index.
 */
export async function readSessionHeadTitle(filePath: string, maximumBytes = 64 * 1024): Promise<string | undefined> {
	const handle = await fs.open(filePath, 'r');
	let head: string;
	try {
		const buffer = Buffer.allocUnsafe(maximumBytes);
		const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
		head = buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
	const newline = head.indexOf('\n');
	if (newline >= 0) {
		try {
			const entry = JSON.parse(head.slice(0, newline)) as { kind?: unknown; v?: unknown };
			if (entry.kind === 0 && isRecord(entry.v)) {
				const custom = typeof entry.v.customTitle === 'string' ? entry.v.customTitle.trim() : '';
				if (custom) {
					return summarize(custom);
				}
				const requests = Array.isArray(entry.v.requests) ? entry.v.requests : [];
				for (const request of requests) {
					const message = isRecord(request) && isRecord(request.message) ? request.message : undefined;
					const text = typeof message?.text === 'string' ? cleanUserText(message.text) : '';
					if (text) {
						return summarize(text);
					}
				}
			}
		} catch {
			// Fall through to the tolerant scan below.
		}
	}
	const customMatch = /"customTitle":("(?:\\.|[^"\\])*")/.exec(head);
	const custom = customMatch ? decode(customMatch[1]) : '';
	if (custom.trim()) {
		return summarize(custom.trim());
	}
	const messageMatch = /"message":\{"text":("(?:\\.|[^"\\])*")/.exec(head);
	const prompt = messageMatch ? cleanUserText(decode(messageMatch[1])) : '';
	return prompt ? summarize(prompt) : undefined;
}

function decode(jsonString: string): string {
	try {
		return JSON.parse(jsonString) as string;
	} catch {
		return '';
	}
}

function cleanUserText(value: string): string {
	return value.replace(/^User:\s*/i, '').trim();
}

function summarize(value: string, length = 72): string {
	const line = value.replace(/\s+/g, ' ').trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
