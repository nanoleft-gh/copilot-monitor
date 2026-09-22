export interface SessionLoadCandidate {
	readonly resource: string;
	readonly size: number;
}

export function planSessionLoads(
	candidates: readonly SessionLoadCandidate[],
	activeResource: string | undefined,
	maximumFileBytes: number,
	maximumWorkspaceBytes: number,
): boolean[] {
	const activeIndex = candidates.findIndex(candidate => candidate.resource === activeResource);
	const activeSize = activeIndex >= 0 ? candidates[activeIndex].size : 0;
	const activeFits = activeIndex >= 0 && activeSize >= 0 && activeSize <= maximumFileBytes;
	let remainingBytes = Math.max(0, maximumWorkspaceBytes - (activeFits ? activeSize : 0));
	return candidates.map(candidate => {
		if (candidate.size < 0 || candidate.size > maximumFileBytes) {
			return false;
		}
		if (candidate.resource === activeResource) {
			return activeFits;
		}
		if (candidate.size > remainingBytes) {
			return false;
		}
		remainingBytes = Math.max(0, remainingBytes - candidate.size);
		return true;
	});
}