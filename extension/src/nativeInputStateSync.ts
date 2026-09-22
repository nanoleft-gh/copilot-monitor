export interface NativeInputStateWatcher {
	dispose(): void;
}

export interface NativeInputStateTimerScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface NativeInputStateSyncOptions {
	readonly refresh: () => Promise<void>;
	readonly createWatcher: (
		onChange: () => void,
		onError: () => void,
	) => NativeInputStateWatcher;
	readonly debounceMs?: number;
	readonly watchedPollIntervalMs?: number;
	readonly fallbackPollIntervalMs?: number;
	readonly watcherRetryIntervalMs?: number;
	readonly scheduler?: NativeInputStateTimerScheduler;
}

const defaultScheduler: NativeInputStateTimerScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export class NativeInputStateSync implements Disposable {
	private readonly scheduler: NativeInputStateTimerScheduler;
	private readonly debounceMs: number;
	private readonly watchedPollIntervalMs: number;
	private readonly fallbackPollIntervalMs: number;
	private readonly watcherRetryIntervalMs: number;
	private watcher: NativeInputStateWatcher | undefined;
	private debounceTimer: unknown;
	private pollTimer: unknown;
	private watcherRetryTimer: unknown;
	private readRunning = false;
	private readPending = false;
	private disposed = false;

	constructor(private readonly options: NativeInputStateSyncOptions) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.debounceMs = options.debounceMs ?? 75;
		// 0 disables the safety poll while a file watcher is alive: watcher events are the only trigger.
		this.watchedPollIntervalMs = options.watchedPollIntervalMs ?? 0;
		this.fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? 30_000;
		this.watcherRetryIntervalMs = options.watcherRetryIntervalMs ?? 5_000;
	}

	start(): void {
		if (this.disposed) {
			return;
		}
		this.tryCreateWatcher();
		this.schedulePoll();
		this.requestRefresh(0);
	}

	/** Releases the watcher and timers but leaves the instance ready for a later `start()`. */
	stop(): void {
		this.readPending = false;
		this.clearTimer('debounceTimer');
		this.clearTimer('pollTimer');
		this.clearTimer('watcherRetryTimer');
		this.watcher?.dispose();
		this.watcher = undefined;
	}

	requestRefresh(delayMs = this.debounceMs): void {
		if (this.disposed) {
			return;
		}
		if (this.readRunning) {
			this.readPending = true;
			return;
		}
		if (this.debounceTimer !== undefined) {
			this.scheduler.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = this.scheduler.setTimeout(() => {
			this.debounceTimer = undefined;
			void this.runRefresh();
		}, delayMs);
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	private tryCreateWatcher(): void {
		if (this.disposed || this.watcher) {
			return;
		}
		try {
			this.watcher = this.options.createWatcher(
				() => this.requestRefresh(),
				() => this.handleWatcherError(),
			);
			this.clearTimer('watcherRetryTimer');
		} catch {
			this.scheduleWatcherRetry();
		}
	}

	private handleWatcherError(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		this.scheduleWatcherRetry();
		this.schedulePoll();
	}

	private scheduleWatcherRetry(): void {
		if (this.disposed || this.watcherRetryTimer !== undefined) {
			return;
		}
		this.watcherRetryTimer = this.scheduler.setTimeout(() => {
			this.watcherRetryTimer = undefined;
			this.tryCreateWatcher();
		}, this.watcherRetryIntervalMs);
	}

	private schedulePoll(): void {
		if (this.disposed) {
			return;
		}
		this.clearTimer('pollTimer');
		const delayMs = this.watcher ? this.watchedPollIntervalMs : this.fallbackPollIntervalMs;
		if (delayMs <= 0) {
			return;
		}
		this.pollTimer = this.scheduler.setTimeout(() => {
			this.pollTimer = undefined;
			this.requestRefresh(0);
			this.schedulePoll();
		}, delayMs);
	}

	private async runRefresh(): Promise<void> {
		if (this.disposed || this.readRunning) {
			return;
		}
		this.readRunning = true;
		try {
			await this.options.refresh();
		} finally {
			this.readRunning = false;
			if (this.readPending && !this.disposed) {
				this.readPending = false;
				this.requestRefresh();
			}
		}
	}

	private clearTimer(key: 'debounceTimer' | 'pollTimer' | 'watcherRetryTimer'): void {
		const timer = this[key];
		if (timer !== undefined) {
			this.scheduler.clearTimeout(timer);
			this[key] = undefined;
		}
	}
}

interface Disposable {
	dispose(): void;
}