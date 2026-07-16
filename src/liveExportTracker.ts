import type { Transcript, TranscriptTurn } from './transcript';

const maximumLiveExportDurationMs = 10 * 60_000;
const timestampToleranceMs = 2_000;

export interface PendingLiveTurn {
	readonly userText: string;
	readonly outboundMessageId: string;
	readonly createdAt: number;
	readonly sessionResource: string;
}

export class LiveExportTracker {
	private pending: PendingLiveTurn | undefined;
	private sampleUntil = 0;

	get current(): PendingLiveTurn | undefined {
		return this.pending;
	}

	begin(userText: string, outboundMessageId: string, createdAt: number, sessionResource: string): void {
		this.pending = { userText, outboundMessageId, createdAt, sessionResource };
		this.sampleUntil = createdAt + maximumLiveExportDurationMs;
	}

	cancel(outboundMessageId: string): void {
		if (this.pending?.outboundMessageId === outboundMessageId) {
			this.pending = undefined;
			this.sampleUntil = 0;
		}
	}

	shouldSample(force: boolean, sessionStatus: 'idle' | 'working' | 'loading', now: number): boolean {
		return force || sessionStatus === 'working' || now < this.sampleUntil;
	}

	observe(sessionResource: string, turns: readonly TranscriptTurn[]): PendingLiveTurn | undefined {
		const pending = this.pending;
		if (!pending || pending.sessionResource !== sessionResource) {
			return undefined;
		}

		for (let index = turns.length - 1; index >= 0; index--) {
			const turn = turns[index];
			if (turn.timestamp >= pending.createdAt - timestampToleranceMs
				&& turn.userText.trim() === pending.userText
				&& turn.status === 'completed') {
				this.pending = undefined;
				this.sampleUntil = 0;
				return pending;
			}
		}
		return undefined;
	}

	stabilize(sessionResource: string, transcript: Transcript): Transcript {
		const pending = this.pending;
		if (!pending || pending.sessionResource !== sessionResource) {
			return transcript;
		}

		let changed = false;
		const turns = transcript.turns.map(turn => {
			const isPendingTurn = turn.timestamp >= pending.createdAt - timestampToleranceMs
				&& turn.userText.trim() === pending.userText;
			if (!isPendingTurn
				|| turn.status !== 'cancelled'
				|| turn.thinking
				|| turn.assistantText
				|| turn.activities.length > 0) {
				return turn;
			}
			changed = true;
			return { ...turn, status: 'working' as const, completedAt: undefined };
		});

		return changed ? { ...transcript, status: 'working', turns } : transcript;
	}
}