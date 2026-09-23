import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { SessionDigest } from './sessionDigest';
import { DigestSyncResult, planDigestSync, syncSessionDigest } from './sessionDigestBuilder';
import type { DigestWorkerInput, DigestWorkerOutput } from './sessionDigestWorker';

/**
 * Runs a digest sync where it is cheapest: a short append is parsed inline on the extension
 * host (it is a few small lines), anything larger — and every rebuild — goes to a worker
 * thread so the extension host never tokenises megabytes of JSON.
 */

export interface DigestSyncClientOptions {
	/** Appends up to this many bytes are parsed inline. */
	readonly inlineBytes?: number;
	readonly signal?: AbortSignal;
	/** Test hook: force every sync through one path. */
	readonly mode?: 'inline' | 'worker';
}

const defaultInlineBytes = 512 * 1024;

export async function syncDigestForSession(digest: SessionDigest, sessionId: string, filePath: string, options: DigestSyncClientOptions = {}): Promise<DigestSyncResult> {
	const plan = await planDigestSync(digest, sessionId, filePath);
	if (plan.mode === 'gone' || plan.mode === 'unchanged') {
		return syncSessionDigest({ digest, sessionId, filePath, signal: options.signal });
	}
	const inline = options.mode === 'inline' || (options.mode !== 'worker' && plan.mode === 'extend' && plan.appendedBytes <= (options.inlineBytes ?? defaultInlineBytes));
	if (inline) {
		return syncSessionDigest({ digest, sessionId, filePath, signal: options.signal });
	}
	return runDigestWorker({ databasePath: digest.path, sessionId, filePath }, options.signal);
}

function runDigestWorker(input: DigestWorkerInput, signal?: AbortSignal): Promise<DigestSyncResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(path.join(__dirname, 'sessionDigestWorker.js'), {
			workerData: input,
			resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
		});
		let settled = false;
		const settle = (outcome: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			outcome();
		};
		const onAbort = () => {
			void worker.terminate();
			settle(() => reject(new Error('Digest sync was cancelled.')));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		worker.once('message', (output: DigestWorkerOutput) => {
			void worker.terminate();
			settle(() => output.ok ? resolve(output.result) : reject(new Error(output.error)));
		});
		worker.once('error', error => settle(() => reject(error)));
		worker.once('exit', code => {
			if (code !== 0) {
				settle(() => reject(new Error(`Digest worker exited with code ${code}.`)));
			}
		});
	});
}
