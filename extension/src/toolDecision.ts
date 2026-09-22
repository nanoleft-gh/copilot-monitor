import type { ActiveSessionState } from './protocol';
import type { ToolDecisionRequest } from './protocol';

export function isActivePendingTool(
	sessions: readonly ActiveSessionState[],
	request: ToolDecisionRequest,
): boolean {
	const session = sessions.find(candidate => candidate.resource === request.sessionResource);
	const lastTurn = session?.turns.at(-1);
	// Live sources cannot tell "waiting for confirmation" from "running", so any approvable
	// activity counts; VS Code's accept/skip commands are no-ops when nothing is pending.
	const firstPending = lastTurn?.activities.find(activity => activity.canApprove && activity.status !== 'completed');
	return lastTurn?.id === request.requestId && firstPending?.id === request.toolCallId;
}