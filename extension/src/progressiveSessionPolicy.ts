export const progressiveSupplementGraceMs = 10_000;

export function shouldPreserveProgressiveSession(options: {
	readonly currentRevision?: string;
	readonly primarySize: number;
	readonly primaryMtimeMs: number;
	readonly supplementPresent: boolean;
	readonly supplementMissingSince?: number;
	readonly now: number;
	readonly mutationIndexing: boolean;
}): boolean {
	if (options.mutationIndexing) {
		return true;
	}
	if (options.supplementPresent || options.supplementMissingSince === undefined) {
		return false;
	}
	const expectedPrefix = `progressive:${options.primarySize}:${options.primaryMtimeMs}|`;
	return options.currentRevision?.startsWith(expectedPrefix) === true
		&& options.now - options.supplementMissingSince <= progressiveSupplementGraceMs;
}