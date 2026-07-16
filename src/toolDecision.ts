import type { ActiveSessionState } from './protocol';
import type { ToolDecisionRequest } from './protocol';

export function isActivePendingTool(
	sessions: readonly ActiveSessionState[],
	request: ToolDecisionRequest,
): boolean {
	const session = sessions.find(candidate => candidate.resource === request.sessionResource);
	const lastTurn = session?.turns.at(-1);
	const firstPending = lastTurn?.activities.find(activity => activity.status === 'waiting' && activity.canApprove);
	return lastTurn?.id === request.requestId && firstPending?.id === request.toolCallId;
}