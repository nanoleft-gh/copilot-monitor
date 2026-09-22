import type { LiveToolCall, LiveTurn } from './liveTurns';
import { sameToolId } from './liveTurns';
import type { TranscriptActivity, TranscriptBlock, TranscriptTurn } from './transcript';

/**
 * Overlays live turns (from Copilot's transcript / debug log) onto the persisted turns
 * (from VS Code's mutation log). Persisted data is authoritative once a request is sealed;
 * live data fills the gap while a request is in flight and adds requests VS Code has not
 * flushed to disk yet (it does so only every ~60 s).
 */

export interface MergeInput {
	/** Persisted window, oldest first. */
	readonly persisted: readonly TranscriptTurn[];
	/** Absolute index of `persisted[0]` within the session. */
	readonly persistedStart: number;
	/** Total persisted requests in the session. */
	readonly persistedCount: number;
	readonly live: readonly LiveTurn[];
	readonly now: number;
}

export interface MergeResult {
	readonly turns: readonly TranscriptTurn[];
	readonly turnCount: number;
	readonly historyStart: number;
	readonly status: 'idle' | 'working';
	/** Count of turns that exist only in the live source so far. */
	readonly unpersistedTurns: number;
}

const pairingToleranceMs = 5 * 60_000;
/** A live tool still running after this long may be waiting for the user's confirmation. */
const approvableAfterMs = 2_000;

export function mergeLiveTurns(input: MergeInput): MergeResult {
	const { persisted, live, now } = input;
	const pairs = alignFromEnd(persisted, live);
	const turns: TranscriptTurn[] = persisted.map((turn, index) => {
		const liveIndex = pairs.get(index);
		return liveIndex === undefined ? turn : overlay(turn, live[liveIndex], now);
	});

	const lastPaired = Math.max(-1, ...pairs.values());
	const firstUnpersisted = pairs.size === 0
		? firstLiveNewerThanPersisted(persisted, live)
		: lastPaired + 1;
	const appended = live.slice(firstUnpersisted).map(turn => fromLive(turn, now));
	turns.push(...appended);

	return {
		turns,
		turnCount: input.persistedCount + appended.length,
		historyStart: input.persistedStart,
		status: turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
		unpersistedTurns: appended.length,
	};
}

/** Pairs persisted index → live index, walking backwards from the newest live turn that has a persisted match. */
function alignFromEnd(persisted: readonly TranscriptTurn[], live: readonly LiveTurn[]): Map<number, number> {
	const pairs = new Map<number, number>();
	let liveIndex = live.length - 1;
	let anchor: number | undefined;
	for (; liveIndex >= 0 && anchor === undefined; liveIndex--) {
		for (let index = persisted.length - 1; index >= 0; index--) {
			if (matches(persisted[index], live[liveIndex])) {
				anchor = index;
				break;
			}
		}
		if (anchor !== undefined) {
			pairs.set(anchor, liveIndex);
			break;
		}
	}
	if (anchor === undefined) {
		return pairs;
	}
	let persistedIndex = anchor - 1;
	for (liveIndex--; liveIndex >= 0 && persistedIndex >= 0; liveIndex--, persistedIndex--) {
		if (!matches(persisted[persistedIndex], live[liveIndex])) {
			break;
		}
		pairs.set(persistedIndex, liveIndex);
	}
	return pairs;
}

function firstLiveNewerThanPersisted(persisted: readonly TranscriptTurn[], live: readonly LiveTurn[]): number {
	const newestPersisted = persisted.at(-1)?.timestamp ?? 0;
	if (persisted.length === 0) {
		return 0;
	}
	const index = live.findIndex(turn => turn.startedAt > newestPersisted + 1_000);
	return index < 0 ? live.length : index;
}

function matches(persisted: TranscriptTurn, live: LiveTurn): boolean {
	if (normalize(persisted.userText) !== normalize(live.userText)) {
		return false;
	}
	if (!persisted.timestamp || !live.startedAt) {
		return true;
	}
	return Math.abs(persisted.timestamp - live.startedAt) <= pairingToleranceMs;
}

function overlay(persisted: TranscriptTurn, live: LiveTurn, now: number): TranscriptTurn {
	const sealed = persisted.status !== 'working';
	if (sealed) {
		return persisted;
	}
	const activities = mergeActivities(persisted.activities, live.tools, now, true);
	const assistantText = live.assistantText.length > persisted.assistantText.length ? live.assistantText : persisted.assistantText;
	const thinking = live.thinking.length > persisted.thinking.length ? live.thinking : persisted.thinking;
	const status = live.status === 'completed' ? 'completed' : 'working';
	const blocks = rebuildBlocks(persisted, activities, assistantText, thinking);
	return {
		...persisted,
		assistantText,
		thinking,
		activities,
		blocks,
		status,
		completedAt: status === 'completed' ? live.completedAt ?? persisted.completedAt : persisted.completedAt,
	};
}

function fromLive(live: LiveTurn, now: number): TranscriptTurn {
	const working = live.status === 'working';
	const activities = mergeActivities([], live.tools, now, working);
	const blocks: TranscriptBlock[] = [];
	if (live.thinking) {
		blocks.push({ kind: 'thinking', text: live.thinking, title: '' });
	}
	for (const activity of activities) {
		blocks.push({ kind: 'activity', activity });
	}
	if (live.assistantText) {
		blocks.push({ kind: 'text', text: live.assistantText });
	}
	return {
		id: `live:${live.startedAt}:${live.index}`,
		editable: false,
		timestamp: live.startedAt,
		userText: live.userText,
		thinking: live.thinking,
		thinkingTitle: '',
		assistantText: live.assistantText,
		activities,
		blocks,
		status: working ? 'working' : 'completed',
		completedAt: live.completedAt,
	};
}

function mergeActivities(
	persisted: readonly TranscriptActivity[],
	tools: readonly LiveToolCall[],
	now: number,
	turnWorking: boolean,
): TranscriptActivity[] {
	const result: TranscriptActivity[] = persisted.map(activity => ({ ...activity }));
	for (const tool of tools) {
		const existingIndex = result.findIndex(activity => sameToolId(activity.id, tool.id));
		if (existingIndex >= 0) {
			const existing = result[existingIndex];
			if (existing.status !== 'completed' && (tool.status === 'completed' || tool.status === 'failed')) {
				result[existingIndex] = { ...existing, status: 'completed', canApprove: false };
			}
			continue;
		}
		result.push(toActivity(tool, now, turnWorking));
	}
	return result;
}

function toActivity(tool: LiveToolCall, now: number, turnWorking: boolean): TranscriptActivity {
	const finished = tool.status === 'completed' || tool.status === 'failed';
	const stalled = !finished && turnWorking && now - (tool.startedAt ?? tool.requestedAt) >= approvableAfterMs;
	const durationMs = tool.completedAt !== undefined && tool.startedAt !== undefined ? tool.completedAt - tool.startedAt : undefined;
	return {
		id: tool.id,
		label: tool.argsPreview ? `${tool.name} ${tool.argsPreview}` : tool.name,
		status: finished ? 'completed' : 'running',
		toolId: tool.name,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(stalled ? { canApprove: true } : {}),
	};
}

function rebuildBlocks(
	persisted: TranscriptTurn,
	activities: readonly TranscriptActivity[],
	assistantText: string,
	thinking: string,
): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = persisted.blocks.map(block => block.kind === 'activity'
		? { kind: 'activity', activity: activities.find(activity => activity.id === block.activity.id) ?? block.activity }
		: block);
	if (thinking !== persisted.thinking && !blocks.some(block => block.kind === 'thinking')) {
		blocks.unshift({ kind: 'thinking', text: thinking, title: persisted.thinkingTitle });
	}
	const known = new Set(persisted.activities.map(activity => activity.id));
	for (const activity of activities) {
		if (!known.has(activity.id)) {
			blocks.push({ kind: 'activity', activity });
		}
	}
	if (assistantText !== persisted.assistantText) {
		const suffix = assistantText.startsWith(persisted.assistantText)
			? assistantText.slice(persisted.assistantText.length).trim()
			: assistantText;
		if (suffix) {
			blocks.push({ kind: 'text', text: suffix });
		}
	}
	return blocks;
}

function normalize(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
