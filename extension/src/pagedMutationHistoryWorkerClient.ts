import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
	deserializePagedMutationHistoryIndex,
	PagedMutationHistoryIndex,
	serializePagedMutationHistoryIndex,
	SerializedPagedMutationHistoryIndex,
} from './pagedMutationHistory';
import { HistoryPageResult } from './protocol';

type PageWorkerInput = {
	readonly action: 'page';
	readonly index: SerializedPagedMutationHistoryIndex;
	readonly start: number;
	readonly limit: number;
	readonly revision: string;
};

type WorkerResult = {
	readonly ok: true;
	readonly index?: SerializedPagedMutationHistoryIndex;
	readonly page?: HistoryPageResult;
} | {
	readonly ok: false;
	readonly error: string;
};

export async function indexPagedMutationHistoryInWorker(
	filePath: string,
	signal?: AbortSignal,
): Promise<PagedMutationHistoryIndex> {
	const result = await runWorker(filePath, signal);
	if (!result.index) {throw new Error('Progressive history worker returned no index.');}
	return deserializePagedMutationHistoryIndex(result.index);
}

export async function loadPagedMutationHistoryInWorker(
	index: PagedMutationHistoryIndex,
	start: number,
	limit: number,
	revision: string,
	signal?: AbortSignal,
): Promise<HistoryPageResult> {
	const result = await runWorker({
		action: 'page',
		index: serializePagedMutationHistoryIndex(index),
		start,
		limit,
		revision,
	}, signal);
	if (!result.page) {throw new Error('Progressive history worker returned no page.');}
	return result.page;
}

function runWorker(workerData: string | PageWorkerInput, signal?: AbortSignal): Promise<Extract<WorkerResult, { ok: true }>> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(path.join(__dirname, 'pagedMutationHistoryWorker.js'), {
			workerData,
			resourceLimits: {
				maxOldGenerationSizeMb: 256,
				maxYoungGenerationSizeMb: 32,
				stackSizeMb: 4,
			},
		});
		let settled = false;
		const cleanup = () => signal?.removeEventListener('abort', onAbort);
		const resolveOnce = (result: Extract<WorkerResult, { ok: true }>) => {
			if (settled) {return;}
			settled = true;
			cleanup();
			resolve(result);
		};
		const rejectOnce = (error: Error) => {
			if (settled) {return;}
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			void worker.terminate();
			rejectOnce(new Error('Progressive history operation was cancelled.'));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		worker.once('message', (result: WorkerResult) => {
			void worker.terminate();
			if (result.ok) {resolveOnce(result);}
			else {rejectOnce(new Error(result.error));}
		});
		worker.once('error', rejectOnce);
		worker.once('exit', code => {
			if (code !== 0) {rejectOnce(new Error(`Progressive history worker exited with code ${code}.`));}
		});
	});
}