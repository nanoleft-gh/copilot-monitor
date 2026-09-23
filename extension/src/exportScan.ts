import type { JsonObject } from './transcript';

/**
 * Reads what the monitor needs from a `workbench.action.chat.export` payload without parsing
 * the whole document. VS Code writes it with `JSON.stringify(model.toExport(), undefined, 2)`,
 * so every request object starts at a fixed indentation with `requestId` as its first key
 * (see `ChatModel.toExport`). Only the newest request is materialised.
 */

export interface ExportScan {
	readonly requestIds: readonly string[];
	readonly lastRequest: JsonObject | undefined;
	readonly bytes: number;
}

const requestStart = Buffer.from('\n    {\n      "requestId": ');
const requestIdKey = Buffer.from('\n      "requestId": "');
const requestEnd = Buffer.from('\n    }');
const requestsClose = Buffer.from('\n  ]');
/** Beyond this the fallback full parse is refused. */
const maximumFullParseBytes = 16 * 1024 * 1024;

export function scanExport(data: Uint8Array): ExportScan {
	const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	const requestIds: string[] = [];
	for (let at = buffer.indexOf(requestIdKey); at >= 0; at = buffer.indexOf(requestIdKey, at + requestIdKey.length)) {
		const start = at + requestIdKey.length;
		const end = buffer.indexOf(0x22, start);
		if (end < 0) {
			break;
		}
		requestIds.push(buffer.toString('utf8', start, end));
	}
	const lastStart = buffer.lastIndexOf(requestStart);
	if (lastStart >= 0) {
		// Everything inside a request is indented deeper, so the first two-space `]` after the
		// newest request closes the requests array, whatever top-level keys follow it.
		const close = buffer.indexOf(requestsClose, lastStart);
		const lastEnd = close > lastStart ? buffer.lastIndexOf(requestEnd, close) : -1;
		if (lastEnd > lastStart) {
			try {
				const value = JSON.parse(buffer.toString('utf8', lastStart + 1, lastEnd + requestEnd.length)) as unknown;
				if (isObject(value)) {
					return { requestIds, lastRequest: value, bytes: buffer.byteLength };
				}
			} catch {
				// Unexpected layout: fall through to the bounded full parse.
			}
		}
	}
	return { ...fullParse(buffer), bytes: buffer.byteLength };
}

function fullParse(buffer: Buffer): Pick<ExportScan, 'requestIds' | 'lastRequest'> {
	if (buffer.byteLength === 0 || buffer.byteLength > maximumFullParseBytes) {
		return { requestIds: [], lastRequest: undefined };
	}
	try {
		const value = JSON.parse(buffer.toString('utf8')) as unknown;
		const requests = isObject(value) && Array.isArray(value.requests) ? value.requests.filter(isObject) : [];
		return {
			requestIds: requests.map(request => typeof request.requestId === 'string' ? request.requestId : '').filter(Boolean),
			lastRequest: requests.at(-1),
		};
	} catch {
		return { requestIds: [], lastRequest: undefined };
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
