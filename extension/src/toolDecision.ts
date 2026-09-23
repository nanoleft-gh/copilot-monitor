import { sameToolId } from './liveTurns';
import { mergeSessionModelState } from './modelCatalog';
import type { ActiveSessionState, SessionModelState, ToolDecisionRequest } from './protocol';
import type { TranscriptActivity, TranscriptBlock, TranscriptTurn } from './transcript';

/** What one export of the renderer's live session told us that the files cannot. */
export interface ExportSnapshot {
	readonly resource: string;
	/** Newest request of the export; the verdict applies to it only. */
	readonly turnId: string | undefined;
	/** Tool calls VS Code was holding for confirmation when the export ran. */
	readonly pendingToolIds: readonly string[];
	readonly model: SessionModelState | undefined;
	readonly capturedAt: number;
	/** The newest request as the renderer had it, including text still streaming. */
	readonly preview?: TranscriptTurn;
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
 * Whether an export (identified by its request ids, oldest first) is of `session`. Request ids
 * are unique across chats, so every persisted request the session shows must be in the export,
 * and the export may only be newer than it. A chat with no persisted request yet is matched by
 * its single request's prompt instead.
 */
export function exportMatchesSession(requestIds: readonly string[], session: ActiveSessionState, lastPrompt?: string): boolean {
	if (requestIds.length === 0) {
		return false;
	}
	const known = session.turns.filter(turn => turn.editable).map(turn => turn.id);
	if (known.length === 0) {
		const only = session.turns.at(-1);
		return requestIds.length === 1 && session.turns.length === 1 && only !== undefined
			&& lastPrompt !== undefined && only.userText.trim() !== '' && only.userText.trim() === lastPrompt.trim();
	}
	const ids = new Set(requestIds);
	return known.every(id => ids.has(id));
}

/**
 * Overlays what only the renderer knows onto the file-derived session: which tools of the
 * newest working turn VS Code is holding for confirmation, the live model state, and text
 * that is still streaming. The preview is used only while it is ahead of the files, so it can
 * never hold back progress the files already show.
 */
export function applyExportSnapshot(session: ActiveSessionState, snapshot: ExportSnapshot): ActiveSessionState {
	const model = snapshot.model ? mergeSessionModelState(session.model, snapshot.model) : session.model;
	const last = session.turns.at(-1);
	// A live-only turn has a synthetic id the export cannot know; it is the newest turn either way.
	const sameTurn = last !== undefined && (snapshot.turnId === undefined || snapshot.turnId === last.id || !last.editable);
	if (!sameTurn || last.status !== 'working') {
		return model === session.model ? session : { ...session, model };
	}
	const previewed = snapshot.preview && isAhead(snapshot.preview, last) ? withPreview(last, snapshot.preview) : last;
	const pending = snapshot.pendingToolIds;
	const isPending = (activity: TranscriptActivity) => activity.status !== 'completed' && pending.some(id => sameToolId(activity.id, id));
	const marked = previewed.activities.some(isPending) ? markPending(previewed, isPending) : previewed;
	if (marked === last) {
		return model === session.model ? session : { ...session, model };
	}
	const turns = [...session.turns.slice(0, -1), marked];
	return {
		...session,
		turns,
		status: turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
		model,
		revision: `${session.revision}+x${snapshot.capturedAt}`,
	};
}

function isAhead(preview: TranscriptTurn, live: TranscriptTurn): boolean {
	return preview.status !== 'working'
		|| visibleLength(preview.assistantText) > visibleLength(live.assistantText)
		|| visibleLength(preview.thinking) > visibleLength(live.thinking);
}

/**
 * Text, thinking and order come from the renderer; tool status comes from the files, because
 * the export marks every invocation complete (`ChatToolInvocation.toJSON`).
 */
function withPreview(live: TranscriptTurn, preview: TranscriptTurn): TranscriptTurn {
	const same = (left: TranscriptActivity, right: TranscriptActivity) => sameToolId(left.id, right.id) || sameToolId(right.id, left.id);
	const blocks: TranscriptBlock[] = preview.blocks.map((block, index) => {
		if (block.kind !== 'activity') {
			return block;
		}
		const known = live.activities.find(candidate => same(candidate, block.activity));
		if (known) {
			return { kind: 'activity', activity: known };
		}
		const followedByOutput = preview.blocks.slice(index + 1).some(next => next.kind !== 'activity');
		return { kind: 'activity', activity: { ...block.activity, status: followedByOutput ? 'completed' : 'running' } };
	});
	const activities = blocks.flatMap(block => block.kind === 'activity' ? [block.activity] : []);
	for (const activity of live.activities) {
		if (!activities.some(candidate => same(candidate, activity))) {
			activities.push(activity);
			blocks.push({ kind: 'activity', activity });
		}
	}
	const finished = preview.status !== 'working';
	return {
		...live,
		assistantText: visibleLength(preview.assistantText) >= visibleLength(live.assistantText) ? preview.assistantText : live.assistantText,
		thinking: visibleLength(preview.thinking) >= visibleLength(live.thinking) ? preview.thinking : live.thinking,
		thinkingTitle: preview.thinkingTitle || live.thinkingTitle,
		activities,
		blocks,
		status: finished ? preview.status : live.status,
		...(finished ? { completedAt: preview.completedAt ?? live.completedAt } : {}),
	};
}

function markPending(turn: TranscriptTurn, isPending: (activity: TranscriptActivity) => boolean): TranscriptTurn {
	const mark = (activity: TranscriptActivity): TranscriptActivity => isPending(activity) ? { ...activity, status: 'waiting', canApprove: true } : activity;
	return {
		...turn,
		activities: turn.activities.map(mark),
		blocks: turn.blocks.map(block => block.kind === 'activity' ? { ...block, activity: mark(block.activity) } : block),
	};
}

function visibleLength(text: string): number {
	return text.replace(/\s+/g, '').length;
}
