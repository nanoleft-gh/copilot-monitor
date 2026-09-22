import * as fs from 'node:fs/promises';

export interface SessionHead {
	readonly title: string | undefined;
	/** Whether any request is visible in the head: in the initial snapshot or as a later push. */
	readonly hasRequests: boolean;
}

/**
 * Derives a display title (and whether the chat has any request yet) for a session whose
 * entry is not in VS Code's index by reading only the first `maximumBytes` of its mutation
 * log. Used for brand-new sessions during the ≤60 s window before VS Code flushes its index.
 */
export async function readSessionHead(filePath: string, maximumBytes = 64 * 1024): Promise<SessionHead> {
	const handle = await fs.open(filePath, 'r');
	let head: string;
	try {
		const buffer = Buffer.allocUnsafe(maximumBytes);
		const { bytesRead } = await handle.read(buffer, 0, maximumBytes, 0);
		head = buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
	// A request appended after the snapshot arrives as a push onto `requests`.
	let hasRequests = /\{"kind":2,"k":\["requests"\]/.test(head);
	let title: string | undefined;
	const newline = head.indexOf('\n');
	if (newline >= 0) {
		try {
			const entry = JSON.parse(head.slice(0, newline)) as { kind?: unknown; v?: unknown };
			if (entry.kind === 0 && isRecord(entry.v)) {
				const requests = Array.isArray(entry.v.requests) ? entry.v.requests : [];
				hasRequests = hasRequests || requests.length > 0;
				const custom = typeof entry.v.customTitle === 'string' ? entry.v.customTitle.trim() : '';
				if (custom) {
					return { title: summarize(custom), hasRequests };
				}
				for (const request of requests) {
					const message = isRecord(request) && isRecord(request.message) ? request.message : undefined;
					const text = typeof message?.text === 'string' ? cleanUserText(message.text) : '';
					if (text) {
						return { title: summarize(text), hasRequests };
					}
				}
				return { title: undefined, hasRequests };
			}
		} catch {
			// Fall through to the tolerant scan below.
		}
	}
	const customMatch = /"customTitle":("(?:\\.|[^"\\])*")/.exec(head);
	const custom = customMatch ? decode(customMatch[1]) : '';
	if (custom.trim()) {
		title = summarize(custom.trim());
	}
	const messageMatch = /"message":\{"text":("(?:\\.|[^"\\])*")/.exec(head);
	const prompt = messageMatch ? cleanUserText(decode(messageMatch[1])) : '';
	if (prompt) {
		hasRequests = true;
		title ??= summarize(prompt);
	}
	return { title, hasRequests };
}

export async function readSessionHeadTitle(filePath: string, maximumBytes = 64 * 1024): Promise<string | undefined> {
	return (await readSessionHead(filePath, maximumBytes)).title;
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
