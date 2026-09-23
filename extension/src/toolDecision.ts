import { sameToolId } from './liveTurns';
import { mergeSessionModelState } from './modelCatalog';
import type { ActiveSessionState, SessionModelState, ToolDecisionRequest } from './protocol';
import type { TranscriptActivity } from './transcript';

/** What one export of the renderer's live session told us that the files cannot. */
export interface ExportSnapshot {
	readonly resource: string;
	/** Newest turn of the export; the verdict applies to it only. */
	readonly turnId: string | undefined;
	/** Tool calls VS Code was holding for confirmation when the export ran. */
	readonly pendingToolIds: readonly string[];
	readonly model: SessionModelState | undefined;
	readonly capturedAt: number;
}

export function isActivePendingTool(
	sessions: readonly ActiveSessionState[],
	request: ToolDecisionRequest,
): boolean {
	const session = sessions.find(candidate => candidate.resource === request.sessionResource);
	const lastTurn = session?.turns.at(-1);
	const firstPending = lastTurn?.activities.find(activity => activity.canApprove && activity.status !== 'completed');
	return lastTurn?.id === request.requestId && firstPending?.id === request.toolCallId;
}

/**
 * Overlays what only the renderer knows onto the file-derived session: which tools of the
 * newest working turn VS Code is holding for confirmation, and the live model state. Turn
 * content is never replaced, so live progress keeps flowing after an export.
 */
export function applyExportSnapshot(session: ActiveSessionState, snapshot: ExportSnapshot): ActiveSessionState {
	const model = snapshot.model ? mergeSessionModelState(session.model, snapshot.model) : session.model;
	const last = session.turns.at(-1);
	const pending = snapshot.pendingToolIds;
	const isPending = (activity: TranscriptActivity) => activity.status !== 'completed' && pending.some(id => sameToolId(activity.id, id));
	// A live-only turn has a synthetic id the export cannot know; it is the newest turn either way.
	const sameTurn = last !== undefined && (snapshot.turnId === undefined || snapshot.turnId === last.id || !last.editable);
	const applies = sameTurn && last.status === 'working' && last.activities.some(isPending);
	if (!applies) {
		return model === session.model ? session : { ...session, model };
	}
	const mark = (activity: TranscriptActivity): TranscriptActivity => isPending(activity) ? { ...activity, status: 'waiting', canApprove: true } : activity;
	const turn = {
		...last,
		activities: last.activities.map(mark),
		blocks: last.blocks.map(block => block.kind === 'activity' ? { ...block, activity: mark(block.activity) } : block),
	};
	return {
		...session,
		turns: [...session.turns.slice(0, -1), turn],
		model,
		revision: `${session.revision}+x${snapshot.capturedAt}`,
	};
}
