import type { ActiveSessionState } from './protocol';
import type { Transcript } from './transcript';

export function findMatchingSession(
	sessions: readonly ActiveSessionState[],
	transcript: Transcript,
): ActiveSessionState | undefined {
	const exportedIds = transcript.turns.map(turn => turn.id);
	const exportedIdSet = new Set(exportedIds);
	let best: { session: ActiveSessionState; overlap: number } | undefined;
	let ambiguous = false;

	for (const session of sessions) {
		const latestRequestId = session.turns.at(-1)?.id;
		if (!latestRequestId || !exportedIdSet.has(latestRequestId)) {
			continue;
		}

		const overlap = session.turns.reduce(
			(count, turn) => count + (exportedIdSet.has(turn.id) ? 1 : 0),
			0,
		);
		if (!best || overlap > best.overlap) {
			best = { session, overlap };
			ambiguous = false;
		} else if (overlap === best.overlap && session.resource !== best.session.resource) {
			ambiguous = true;
		}
	}

	return ambiguous ? undefined : best?.session;
}