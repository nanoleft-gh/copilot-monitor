import { parentPort, workerData } from 'node:worker_threads';
import { SessionDigest } from './sessionDigest';
import { DigestSyncResult, syncSessionDigest } from './sessionDigestBuilder';

export interface DigestWorkerInput {
	readonly databasePath: string;
	readonly sessionId: string;
	readonly filePath: string;
}

export type DigestWorkerOutput = { readonly ok: true; readonly result: DigestSyncResult } | { readonly ok: false; readonly error: string };

const input = workerData as DigestWorkerInput;
const digest = new SessionDigest(input.databasePath);
void syncSessionDigest({ digest, sessionId: input.sessionId, filePath: input.filePath })
	.then(result => parentPort?.postMessage({ ok: true, result } satisfies DigestWorkerOutput))
	.catch(error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies DigestWorkerOutput))
	.finally(() => digest.close());
