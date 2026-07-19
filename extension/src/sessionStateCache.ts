import type { ActiveSessionState, SessionModelState } from './protocol';

export class SessionStateCache {
	private readonly persistedByPath = new Map<string, ActiveSessionState>();
	private readonly liveByResource = new Map<string, ActiveSessionState>();
	private readonly transientByResource = new Map<string, ActiveSessionState>();

	upsertPersisted(filePath: string, session: ActiveSessionState): void {
		this.persistedByPath.set(filePath, session);
		this.transientByResource.delete(session.resource);
		const live = this.liveByResource.get(session.resource);
		if (live && persistedCaughtUp(session, live)) {
			this.liveByResource.delete(session.resource);
		}
	}

	upsertTransient(session: ActiveSessionState): void {
		if (!this.getPersistedByResource(session.resource)) {
			this.transientByResource.set(session.resource, session);
		}
	}

	removeMissingPaths(currentPaths: ReadonlySet<string>): boolean {
		let changed = false;
		for (const [filePath, session] of this.persistedByPath) {
			if (currentPaths.has(filePath)) {
				continue;
			}
			this.persistedByPath.delete(filePath);
			if (![...this.persistedByPath.values()].some(candidate => candidate.resource === session.resource)) {
				this.liveByResource.delete(session.resource);
			}
			changed = true;
		}
		return changed;
	}

	applyLive(session: ActiveSessionState): boolean {
		const persisted = this.getPersistedByResource(session.resource);
		if (!persisted) {
			return false;
		}
		this.liveByResource.set(session.resource, {
			...session,
			resource: persisted.resource,
			sessionId: persisted.sessionId,
			title: persisted.title,
		});
		return true;
	}

	updateModel(resource: string, model: SessionModelState): boolean {
		let changed = false;
		for (const [filePath, session] of this.persistedByPath) {
			if (session.resource === resource) {
				this.persistedByPath.set(filePath, { ...session, model });
				changed = true;
			}
		}
		const live = this.liveByResource.get(resource);
		if (live) {
			this.liveByResource.set(resource, { ...live, model });
		}
		return changed;
	}

	getVisibleSessions(): ActiveSessionState[] {
		const persistedByResource = new Map<string, ActiveSessionState>();
		for (const session of this.persistedByPath.values()) {
			const current = persistedByResource.get(session.resource);
			if (!current || (session.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
				persistedByResource.set(session.resource, session);
			}
		}

		return [...persistedByResource.values(), ...this.transientByResource.values()]
			.map(persisted => {
				const live = this.liveByResource.get(persisted.resource);
				if (!live) {
					return persisted;
				}
				return {
					...live,
					resource: persisted.resource,
					sessionId: persisted.sessionId,
					title: persisted.title,
					model: persisted.model ?? live.model,
					permissionLevel: persisted.permissionLevel,
					updatedAt: Math.max(persisted.updatedAt ?? 0, live.updatedAt ?? 0),
				};
			})
			.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
	}

	private getPersistedByResource(resource: string): ActiveSessionState | undefined {
		let newest: ActiveSessionState | undefined;
		for (const session of this.persistedByPath.values()) {
			if (session.resource === resource && (!newest || (session.updatedAt ?? 0) > (newest.updatedAt ?? 0))) {
				newest = session;
			}
		}
		return newest;
	}
}

function persistedCaughtUp(persisted: ActiveSessionState, live: ActiveSessionState): boolean {
	const liveLast = live.turns.at(-1);
	if (!liveLast) {
		return true;
	}

	const persistedIndex = persisted.turns.findIndex(turn => turn.id === liveLast.id);
	if (persistedIndex >= 0) {
		if (persistedIndex < persisted.turns.length - 1) {
			return true;
		}
		const persistedLast = persisted.turns[persistedIndex];
		return persistedLast.status !== 'working'
			&& persistedLast.assistantText.length >= liveLast.assistantText.length
			&& persistedLast.thinking.length >= liveLast.thinking.length;
	}

	const persistedLast = persisted.turns.at(-1);
	return persistedLast !== undefined
		&& persistedLast.timestamp > liveLast.timestamp
		&& !live.turns.some(turn => turn.id === persistedLast.id);
}