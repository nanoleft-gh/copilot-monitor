import { FSWatcher, existsSync, watch } from 'node:fs';
import * as path from 'node:path';

/**
 * A resilient wrapper around `fs.watch` for a single directory.
 *
 * Two watchers are kept: one on the directory itself (when it exists) and one on the
 * nearest existing ancestor, which observes the directory being created, deleted or
 * replaced — `fs.watch` on Windows reports none of that on the deleted handle itself.
 * Whenever the directory (re)appears, consumers receive a `reconcile` event to catch up.
 * Watcher errors tear down and re-attach after a short delay. There is no polling: the
 * only timer is the recovery delay, armed while broken and once after attaching a fresh
 * ancestor watch while the directory is still missing (a `mkdir -p` can create it between
 * the existence check and the watch, and the new watch would never report it).
 */

export type DirectoryEvent =
	| { readonly type: 'change'; readonly name: string | undefined }
	| { readonly type: 'reconcile' };

export interface DirectoryWatcherOptions {
	readonly retryDelayMs?: number;
}

const defaultRetryDelayMs = 1_000;

export class DirectoryWatcher {
	private targetWatcher: FSWatcher | undefined;
	private ancestorWatcher: FSWatcher | undefined;
	private ancestorPath: string | undefined;
	private retryTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(
		readonly directory: string,
		private readonly listener: (event: DirectoryEvent) => void,
		private readonly options: DirectoryWatcherOptions = {},
	) {}

	/** The directory itself while it exists and is watched; otherwise the ancestor being watched. */
	get watching(): string | undefined {
		if (this.targetWatcher) {
			return this.directory;
		}
		return this.ancestorPath;
	}

	start(): void {
		if (this.disposed) {
			return;
		}
		this.reconcileWatchers(false);
	}

	dispose(): void {
		this.disposed = true;
		this.clearRetry();
		this.closeTarget();
		this.closeAncestor();
	}

	private reconcileWatchers(announce: boolean): void {
		if (this.disposed) {
			return;
		}
		const targetExists = existsSync(this.directory);
		if (targetExists && !this.targetWatcher) {
			this.openTarget();
			if (announce && this.targetWatcher) {
				this.listener({ type: 'reconcile' });
			}
		} else if (!targetExists && this.targetWatcher) {
			this.closeTarget();
		}

		const ancestor = nearestExisting(path.dirname(this.directory));
		const reattached = ancestor !== this.ancestorPath || !this.ancestorWatcher;
		if (reattached) {
			this.closeAncestor();
			if (ancestor) {
				this.openAncestor(ancestor);
			}
		}
		if (!ancestor || (targetExists && !this.targetWatcher)) {
			this.scheduleRetry();
			return;
		}
		if (reattached && !this.targetWatcher) {
			// A fresh ancestor watch cannot report anything created before it was attached. Look
			// again right away, and once more after the retry delay in case the kernel event was
			// lost in that gap; the retry re-arms only if this branch runs again.
			if (existsSync(this.directory)) {
				this.reconcileWatchers(true);
				return;
			}
			this.scheduleRetry();
		}
	}

	private openTarget(): void {
		try {
			const watcher = watch(this.directory, { persistent: false }, (_eventType, fileName) => {
				if (this.disposed || this.targetWatcher !== watcher) {
					return;
				}
				this.listener({ type: 'change', name: fileName ? String(fileName) : undefined });
			});
			watcher.on('error', () => {
				if (this.targetWatcher !== watcher) {
					return;
				}
				this.closeTarget();
				this.scheduleRetry();
			});
			this.targetWatcher = watcher;
		} catch {
			this.scheduleRetry();
		}
	}

	private openAncestor(ancestor: string): void {
		try {
			const watcher = watch(ancestor, { persistent: false }, () => {
				if (this.disposed || this.ancestorWatcher !== watcher) {
					return;
				}
				this.reconcileWatchers(true);
			});
			watcher.on('error', () => {
				if (this.ancestorWatcher !== watcher) {
					return;
				}
				this.closeAncestor();
				this.scheduleRetry();
			});
			this.ancestorWatcher = watcher;
			this.ancestorPath = ancestor;
		} catch {
			this.scheduleRetry();
		}
	}

	private scheduleRetry(): void {
		if (this.disposed || this.retryTimer) {
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.reconcileWatchers(true);
		}, this.options.retryDelayMs ?? defaultRetryDelayMs);
		this.retryTimer.unref();
	}

	private clearRetry(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
	}

	private closeTarget(): void {
		const watcher = this.targetWatcher;
		this.targetWatcher = undefined;
		watcher?.close();
	}

	private closeAncestor(): void {
		const watcher = this.ancestorWatcher;
		this.ancestorWatcher = undefined;
		this.ancestorPath = undefined;
		watcher?.close();
	}
}

function nearestExisting(directory: string): string | undefined {
	let current = directory;
	for (;;) {
		if (existsSync(current)) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}
