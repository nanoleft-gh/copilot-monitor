import { parentPort, workerData } from 'node:worker_threads';
import {
	deserializePagedMutationHistoryIndex,
	indexPagedMutationHistory,
	loadPagedMutationHistory,
	serializePagedMutationHistoryIndex,
	SerializedPagedMutationHistoryIndex,
} from './pagedMutationHistory';

type WorkerInput = string | {
	readonly action: 'page';
	readonly index: SerializedPagedMutationHistoryIndex;
	readonly start: number;
	readonly limit: number;
	readonly revision: string;
};

const input = workerData as WorkerInput;
const operation = typeof input === 'string'
	? indexPagedMutationHistory(input).then(index => ({ index: serializePagedMutationHistoryIndex(index) }))
	: loadPagedMutationHistory(deserializePagedMutationHistoryIndex(input.index), input.start, input.limit, input.revision)
		.then(page => ({ page }));

void operation
	.then(result => parentPort?.postMessage({ ok: true, ...result }))
	.catch(error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));