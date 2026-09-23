import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { createNewChat, decideTool, editAndResubmitPrompt, focusChatSession, hasVoiceSessionBridge, persistLiveChatsNow, readVoiceCurrentSession, releaseChatSession, selectChatModel, sendPrompt, setChatPermissionLevel, startNewLocalChat } from './chatBridge';
import { LiveExportFileSystem, liveExportScheme } from './liveExportFileSystem';
import { LiveExportTracker } from './liveExportTracker';
import { cachedLanguageModelsStorageKey, emptyModelCatalog, mergeConfigurationFields, mergeSessionModelState, ModelCatalog, parseCachedLanguageModels, parseSessionModelState, selectedModelValue, withNativeModelState } from './modelCatalog';
import { createSessionModelConfigurationMutation, createSessionValueMutation, updateProfileModelConfiguration } from './modelConfigurationUpdate';
import { createNativeChatInputStateSnapshot } from './nativeChatInputState';
import { NativeInputStateSync, NativeInputStateWatcher } from './nativeInputStateSync';
import {
	ActiveSessionState,
	ChatModelDescriptor,
	CreateSessionRequest,
	CreateSessionResult,
	EditTurnRequest,
	EditTurnResult,
	HistoryPageRequest,
	HistoryPageResult,
	ModelConfigurationRequest,
	ModelSelectionRequest,
	MonitorRequestError,
	MonitorState,
	OutboundMessageState,
	PermissionLevelRequest,
	RenameSessionRequest,
	SendMessageRequest,
	SendMessageResult,
	SessionModelState,
	ToolDecisionRequest,
} from './protocol';
import { SessionCore } from './sessionCore';
import { findMatchingSession } from './sessionMatcher';
import { localSessionResource as localSessionResourceOf, sessionIdFromResource } from './sessionResource';
import { applyExportSnapshot, ExportSnapshot, isActivePendingTool } from './toolDecision';
import { normalizeTranscript, pendingConfirmationToolIds, TranscriptTurn } from './transcript';

/**
 * The extension-host face of the monitor. Owns the {@link SessionCore} (all file-driven
 * state), the VS Code command bridge, the on-demand export ("sync now"), and the
 * native-input-state watcher. It has no periodic timers.
 */

const maximumMessageLength = 32_000;
const maximumOutboundHistory = 20;
const nativeStateDatabaseFiles = new Set(['state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm']);
const persistWaitAttempts = 20;
const persistWaitDelayMs = 50;
/** Delay before probing a tool that looks stalled, so fast tools never trigger an export. */
const stallProbeDelayMs = 3_000;
const maximumProbedToolCalls = 256;
/** How long a model selection made from the dashboard outranks storage reads that still show the old model. */
const modelIntentGraceMs = 15_000;

export class SessionMonitor implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<MonitorState>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly outboundMessages = new Map<string, OutboundMessageState>();
	private readonly startedAt = Date.now();
	private readonly core: SessionCore;
	private readonly sessionDirectories: string[];
	private readonly copilotTranscriptDirectories: string[];
	private readonly copilotDebugLogDirectories: string[];
	private readonly languageModelsConfigurationPath: string;
	/** PROFILE-scoped storage: the panel's selected model. */
	private readonly profileStateDatabasePath: string;
	/** APPLICATION-scoped storage: cached model list and per-model configuration. */
	private readonly applicationStateDatabasePath: string;
	private readonly liveExportTracker = new LiveExportTracker();
	private readonly liveExportUri: vscode.Uri;
	private readonly liveExportFileSystem = new LiveExportFileSystem();
	private readonly nativeInputStateSync: NativeInputStateSync;
	private readonly createSessionOperations = new Map<string, Promise<CreateSessionResult>>();
	private nativeStateDatabase: DatabaseSync | undefined;
	private applicationStateDatabase: DatabaseSync | undefined;
	private nativeStateDatabaseNeedsReconnect = false;
	private nativeStateRetryAttempted = false;
	private lastNativeInputFingerprint: string | undefined;
	private nativeModelOverride: { resource: string; model: NonNullable<ActiveSessionState['model']> } | undefined;
	/** The chat VS Code itself has focused, as last observed. */
	private nativeCurrentSessionResource: string | undefined;
	/** Whether `_chat.voice.*` exists in this window; re-checked whenever viewing starts. */
	private voiceBridgeAvailable: boolean | undefined;
	/** A model the dashboard asked VS Code to select, until storage confirms or the grace period ends. */
	private modelIntent: { resource: string; modelId: string; at: number } | undefined;
	/** VS Code's stored per-model effort/context choices (`chat.modelConfiguration.panel`). */
	private storedModelConfigurations: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>> = {};
	private catalog: ModelCatalog = emptyModelCatalog;
	private catalogRaw: string | undefined;
	/** Sessions this window created on behalf of a viewer; shown even while still empty. */
	private readonly createdSessionResources = new Set<string>();
	private exportSnapshot: ExportSnapshot | undefined;
	private exportRunning: Promise<void> | undefined;
	private readonly probedToolCalls = new Set<string>();
	private stallProbeTimer: NodeJS.Timeout | undefined;
	private error: string | undefined;
	private lastEmittedSignature: string | undefined;
	private eventClientCount = 0;
	private disposed = false;

	readonly onDidChange = this.changeEmitter.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly windowId: string,
		private readonly log: (message: string) => void = () => undefined,
	) {
		this.disposables.push(this.changeEmitter);
		this.sessionDirectories = resolveSessionDirectories(context);
		this.copilotTranscriptDirectories = resolveCopilotTranscriptDirectories(context);
		this.copilotDebugLogDirectories = resolveCopilotDebugLogDirectories(context);
		this.languageModelsConfigurationPath = path.join(
			path.dirname(path.dirname(context.globalStorageUri.fsPath)),
			'chatLanguageModels.json',
		);
		this.profileStateDatabasePath = resolveProfileStateDatabasePath(context);
		this.applicationStateDatabasePath = resolveApplicationStateDatabasePath(context);
		this.core = new SessionCore({
			paths: {
				sessionDirectories: this.sessionDirectories,
				transcriptDirectories: this.copilotTranscriptDirectories,
				debugLogDirectories: this.copilotDebugLogDirectories,
				indexDatabasePath: resolveSessionIndexDatabasePath(context),
				digestDatabasePath: resolveDigestDatabasePath(context),
			},
			log: message => this.log(`[core] ${message}`),
		});
		this.disposables.push(this.core.onDidChange(() => this.onCoreChanged()));
		this.nativeInputStateSync = new NativeInputStateSync({
			refresh: () => this.refreshNativeInputState(),
			createWatcher: (onChange, onError) => this.createNativeInputStateWatcher(onChange, onError),
		});
		this.liveExportUri = vscode.Uri.from({ scheme: liveExportScheme, authority: this.windowId, path: '/chat.json' });
		this.disposables.push(this.liveExportFileSystem);
		this.disposables.push(vscode.workspace.registerFileSystemProvider(liveExportScheme, this.liveExportFileSystem, { isCaseSensitive: true }));
	}

	getState(): MonitorState {
		const coreState = this.core.getState();
		const sessions = coreState.sessions
			.filter(session => this.isSessionVisible(session, coreState.activeSessionResource))
			.map(session => this.decorateSession(session));
		const active = sessions.find(session => session.resource === coreState.activeSessionResource);
		return {
			version: 1,
			windowId: this.windowId,
			workspaceName: vscode.workspace.name ?? 'Untitled workspace',
			workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
			startedAt: this.startedAt,
			models: this.catalog.models,
			sessions,
			activeSession: active ? { ...active, turns: [] } : undefined,
			activeSessionResource: coreState.activeSessionResource,
			outboundMessages: [...this.outboundMessages.values()],
			error: this.error ?? coreState.error,
		};
	}

	/**
	 * Blank chats VS Code left behind are noise, except the one somebody is actually looking at:
	 * the viewer's selection, the chat focused in VS Code, or a chat a viewer just created.
	 */
	private isSessionVisible(session: ActiveSessionState, activeSessionResource: string | undefined): boolean {
		if (session.isEmpty !== true || session.status === 'working') {
			return true;
		}
		return session.resource === activeSessionResource
			|| session.resource === this.nativeCurrentSessionResource
			|| this.createdSessionResources.has(session.resource);
	}

	/** Viewers gate all work in the core, the native-state watcher, and the model catalog. */
	setEventClientCount(count: number): void {
		const hadClients = this.eventClientCount > 0;
		this.eventClientCount = count;
		if (count > 0 && !hadClients) {
			void this.startViewing(count);
		} else if (count === 0 && hadClients) {
			this.nativeInputStateSync.stop();
			this.exportSnapshot = undefined;
			this.clearStallProbe();
			void this.core.setViewerCount(0);
		} else if (count > 0) {
			void this.core.setViewerCount(count);
		}
	}

	/** The chats viewers currently have open; only these are tailed and carry turns. */
	setWatchedSessions(sessionResources: readonly string[]): void {
		const ids = sessionResources.map(resource => sessionIdFromResource(resource)).filter((id): id is string => id !== undefined);
		this.core.setWatched(ids);
	}

	/** First viewer: open on the chat VS Code has focused, then let the core attach. */
	private async startViewing(count: number): Promise<void> {
		this.voiceBridgeAvailable = await hasVoiceSessionBridge();
		if (!this.core.activeSession) {
			const focused = await this.readNativeCurrentSession();
			const sessionId = focused ? sessionIdFromResource(focused) : undefined;
			if (sessionId) {
				await this.core.selectSession(sessionId);
			}
		}
		await this.core.setViewerCount(count);
		this.nativeInputStateSync.start();
	}

	/**
	 * The chat VS Code's panel is showing. With the voice bridge this is exact; without it the
	 * monitor's own last focus action is the best available answer (every command the monitor
	 * runs focuses its target first, and the session log corrects any drift on its next flush).
	 */
	private async readNativeCurrentSession(): Promise<string | undefined> {
		if (this.voiceBridgeAvailable !== false) {
			const resource = await readVoiceCurrentSession();
			if (resource) {
				this.nativeCurrentSessionResource = resource;
				return resource;
			}
			if (this.voiceBridgeAvailable) {
				return undefined;
			}
		}
		return this.nativeCurrentSessionResource ?? (this.core.activeSession ? localSessionResourceOf(this.core.activeSession) : undefined);
	}

	/**
	 * Creates a local chat and returns its resource. With the voice bridge the panel reports
	 * the new session directly. Without it, VS Code offers no query for a chat's identity, so the
	 * monitor makes VS Code persist its live chats and picks up the session file that appears.
	 */
	private async createIdentifiedChat(source: ActiveSessionState | undefined): Promise<vscode.Uri> {
		this.voiceBridgeAvailable ??= await hasVoiceSessionBridge();
		const sourceResource = source ? vscode.Uri.parse(source.resource) : undefined;
		this.log(`new chat: voice bridge ${this.voiceBridgeAvailable ? 'available' : 'unavailable'}`);
		if (this.voiceBridgeAvailable) {
			return createNewChat(sourceResource, readVoiceCurrentSession);
		}
		const before = await this.listSessionIds();
		await startNewLocalChat(sourceResource);
		// The anchor receives a no-op rename; a chat mid-response would queue it instead.
		const anchor = source?.status !== 'working' ? source : undefined;
		const fallbackAnchor = anchor ?? this.getSessions().find(session => session.isEmpty !== true && session.status !== 'working');
		await persistLiveChatsNow(fallbackAnchor ? vscode.Uri.parse(fallbackAnchor.resource) : undefined, fallbackAnchor?.title ?? 'Copilot chat');
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const created = [...await this.listSessionIds()].filter(id => !before.has(id));
			if (created.length === 1) {
				return vscode.Uri.parse(localSessionResourceOf(created[0]));
			}
			if (created.length > 1) {
				// Several files appeared at once (a flush of other live chats); take the newest.
				const newest = await this.newestSessionId(created);
				return vscode.Uri.parse(localSessionResourceOf(newest));
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new MonitorRequestError(504, 'VS Code created a chat but has not persisted it yet. Try again in a moment.');
	}

	private async listSessionIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const directory of this.sessionDirectories) {
			let names: string[];
			try {
				names = await fs.readdir(directory);
			} catch {
				continue;
			}
			for (const name of names) {
				if (name.endsWith('.jsonl')) {
					ids.add(name.slice(0, -'.jsonl'.length));
				}
			}
		}
		return ids;
	}

	private async newestSessionId(ids: readonly string[]): Promise<string> {
		let newest = ids[0];
		let newestBirth = -1;
		for (const id of ids) {
			for (const directory of this.sessionDirectories) {
				try {
					const stat = await fs.stat(path.join(directory, `${id}.jsonl`));
					if (stat.birthtimeMs > newestBirth) {
						newestBirth = stat.birthtimeMs;
						newest = id;
					}
				} catch {
					// Removed between listing and stat.
				}
			}
		}
		return newest;
	}

	async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
		const text = request.text.trim();
		if (!request.id || !text) {
			throw new MonitorRequestError(400, 'Message id and text are required.');
		}
		if (text.length > maximumMessageLength) {
			throw new MonitorRequestError(413, `Message exceeds ${maximumMessageLength} characters.`);
		}
		const targetSession = this.getSessions().find(session => session.resource === request.sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(409, 'The selected Copilot session is no longer available. Refresh before sending.');
		}
		if (this.outboundMessages.has(request.id)) {
			return { id: request.id, accepted: true };
		}
		this.setOutboundMessage({ id: request.id, preview: summarize(text, 120), status: 'accepted', createdAt: Date.now() });
		this.liveExportTracker.begin(text, request.id, Date.now(), request.sessionResource);
		void sendPrompt(vscode.Uri.parse(request.sessionResource), text).then(
			() => this.pokeAfterCommand(request.sessionResource),
			error => {
				this.liveExportTracker.cancel(request.id);
				this.updateOutboundMessage(request.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
			},
		);
		return { id: request.id, accepted: true };
	}

	async editTurn(request: EditTurnRequest): Promise<EditTurnResult> {
		const text = request.text.trim();
		if (!request.id || !request.requestId || !request.sessionRevision || !text) {
			throw new MonitorRequestError(400, 'Operation id, session revision, request id, and text are required.');
		}
		if (text.length > maximumMessageLength) {
			throw new MonitorRequestError(413, `Message exceeds ${maximumMessageLength} characters.`);
		}
		const targetSession = this.requireIdleSession(request.sessionResource);
		if (targetSession.revision !== request.sessionRevision) {
			throw new MonitorRequestError(409, 'The conversation changed before the edited request could be submitted.');
		}
		const sessionId = requireSessionId(request.sessionResource);
		const requestIndex = this.core.requestIndexOf(sessionId, request.requestId) ?? -1;
		if (requestIndex < 0) {
			throw new MonitorRequestError(409, 'The selected request is no longer editable.');
		}
		if (this.outboundMessages.has(request.id)) {
			return { id: request.id, accepted: true };
		}
		this.setOutboundMessage({ id: request.id, preview: `Edit: ${summarize(text, 114)}`, status: 'accepted', createdAt: Date.now() });
		this.liveExportTracker.begin(text, request.id, Date.now(), request.sessionResource);
		void editAndResubmitPrompt(
			vscode.Uri.parse(request.sessionResource),
			requestIndex,
			targetSession.turnCount ?? targetSession.turns.length,
			text,
		).then(() => this.pokeAfterCommand(request.sessionResource)).catch(error => {
			this.liveExportTracker.cancel(request.id);
			this.updateOutboundMessage(request.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
		});
		return { id: request.id, accepted: true };
	}

	async selectSession(sessionResource: string): Promise<void> {
		const targetSession = this.getSessions().find(session => session.resource === sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		this.exportSnapshot = undefined;
		await this.core.selectSession(targetSession.sessionId);
		await focusChatSession(vscode.Uri.parse(sessionResource));
		this.nativeCurrentSessionResource = sessionResource;
		this.emit();
		this.nativeInputStateSync.requestRefresh(0);
	}

	async loadHistory(request: HistoryPageRequest): Promise<HistoryPageResult> {
		const session = this.getSessions().find(candidate => candidate.resource === request.sessionResource);
		if (!session) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		if (session.revision !== request.sessionRevision) {
			throw new MonitorRequestError(409, 'The conversation changed before history could be loaded. Refresh and try again.');
		}
		const sessionId = session.sessionId;
		const limit = Math.max(1, Math.min(Math.floor(request.limit ?? 40), 40));
		const page = this.core.historyPage(sessionId, request.before, limit);
		if (!page) {
			throw new MonitorRequestError(409, session.historyUnavailable === 'oversized'
				? 'This chat is too large to page remotely; open it in VS Code.'
				: 'History is available only while the chat is open. Open it and try again.');
		}
		return { ...page, revision: session.revision };
	}

	async selectModel(request: ModelSelectionRequest): Promise<void> {
		const targetSession = this.requireIdleSession(request.sessionResource, 'Wait for the active response to finish before changing models.');
		const model = this.catalog.models.find(candidate => candidate.identifier === request.modelId || candidate.id === request.modelId);
		if (!model) {
			throw new MonitorRequestError(409, 'The requested model is no longer available in this VS Code window.');
		}
		await selectChatModel(vscode.Uri.parse(targetSession.resource), { id: model.id, vendor: model.vendor });
		this.nativeCurrentSessionResource = targetSession.resource;
		this.modelIntent = { resource: targetSession.resource, modelId: model.identifier, at: Date.now() };
		// VS Code applies its remembered per-model configuration when switching; mirror that now.
		this.nativeModelOverride = {
			resource: targetSession.resource,
			model: withNativeModelState(targetSession.model, model, this.storedModelConfigurations[model.identifier] ?? {}),
		};
		this.emit();
		this.nativeInputStateSync.requestRefresh(0);
	}

	async configureModel(request: ModelConfigurationRequest): Promise<void> {
		const targetSession = this.requireIdleSession(request.sessionResource, 'Wait for the active response to finish before changing model configuration.');
		if (targetSession.model?.selectedModelId !== request.modelId) {
			throw new MonitorRequestError(409, 'The selected model changed before its configuration could be updated.');
		}
		const model = this.catalog.models.find(candidate => candidate.identifier === request.modelId);
		const fields = mergeConfigurationFields(
			model?.configurationFields ?? [],
			targetSession.model.configurationFields,
			targetSession.model.configuration,
		);
		const field = fields.find(candidate => candidate.key === request.key);
		const option = field?.options.find(candidate => candidate.value === request.value);
		if (!model || !field || !option) {
			throw new MonitorRequestError(400, 'The requested model configuration value is unavailable.');
		}
		const sessionId = targetSession.sessionId;
		const file = await this.requireSessionFile(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		await this.rewriteSessionLog(resource, file.filePath, async () => {
			const selectedModel = await this.waitForPersistedModel(sessionId, request.modelId)
				?? this.selectedModelFromCatalog(request.modelId, targetSession.model?.configuration ?? {});
			if (!selectedModel) {
				throw new MonitorRequestError(409, 'VS Code has not persisted the selected model for this chat yet. Try again in a moment.');
			}
			const mutation = createSessionModelConfigurationMutation({ inputState: { selectedModel } }, request.modelId, request.key, request.value);
			await this.appendMutation(file.filePath, mutation);
		});
		await this.updateProfileModelConfiguration(model, field.key, request.value, field.defaultValue);
		await this.core.pokeSession(sessionId);
		if (this.nativeModelOverride?.resource === request.sessionResource) {
			const current = this.nativeModelOverride.model;
			const configuration = { ...current.configuration, [request.key]: request.value };
			this.nativeModelOverride = {
				resource: request.sessionResource,
				model: { ...current, configuration, configurationFields: current.configurationFields.map(item => ({ ...item, value: configuration[item.key] ?? item.value })) },
			};
		}
		this.emit();
	}

	/**
	 * VS Code only reads a session log when it loads the session, so a change written to the log
	 * reaches VS Code by releasing every live reference, letting VS Code persist its own pending
	 * state, appending ours, and showing the session again so it is loaded from disk.
	 */
	private async rewriteSessionLog(resource: vscode.Uri, filePath: string, append: () => Promise<void>): Promise<void> {
		await releaseChatSession(resource);
		try {
			await waitForFileToSettle(filePath);
			await append();
		} finally {
			await focusChatSession(resource);
			this.nativeCurrentSessionResource = resource.toString();
		}
	}

	/**
	 * VS Code persists `inputState.selectedModel` as the cached catalog entry plus the model
	 * configuration, so the same value can be produced from the catalog when the session log
	 * has not caught up with a selection VS Code already made.
	 */
	private selectedModelFromCatalog(modelId: string, configuration: Readonly<Record<string, string | number | boolean>>): Record<string, unknown> | undefined {
		const entry = this.catalog.entries.get(modelId);
		return entry ? selectedModelValue(entry, configuration) : undefined;
	}

	async renameSession(request: RenameSessionRequest): Promise<void> {
		const title = request.title.trim();
		if (!title || title.length > 160) {
			throw new MonitorRequestError(400, 'A chat title between 1 and 160 characters is required.');
		}
		const target = this.requireIdleSession(request.sessionResource);
		const file = await this.requireSessionFile(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		await this.rewriteSessionLog(resource, file.filePath, () => this.appendMutation(file.filePath, createSessionValueMutation(['customTitle'], title)));
		await this.core.pokeSession(target.sessionId);
		this.emit();
	}

	async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
		if (!request.id) {
			return this.createSessionOnce(request);
		}
		const existing = this.createSessionOperations.get(request.id);
		if (existing) {
			return existing;
		}
		const operation = this.createSessionOnce(request).catch(error => {
			this.createSessionOperations.delete(request.id!);
			throw error;
		});
		this.createSessionOperations.set(request.id, operation);
		while (this.createSessionOperations.size > 32) {
			const oldest = this.createSessionOperations.keys().next().value as string | undefined;
			if (!oldest || oldest === request.id) {
				break;
			}
			this.createSessionOperations.delete(oldest);
		}
		return operation;
	}

	async setPermissionLevel(request: PermissionLevelRequest): Promise<void> {
		const target = this.requireIdleSession(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		if (await setChatPermissionLevel(resource, request.permissionLevel)) {
			void this.pokeAfterCommand(request.sessionResource);
			return;
		}
		const file = await this.requireSessionFile(request.sessionResource);
		await this.rewriteSessionLog(resource, file.filePath, () => this.appendMutation(file.filePath, createSessionValueMutation(['inputState', 'permissionLevel'], request.permissionLevel)));
		await this.core.pokeSession(target.sessionId);
		this.emit();
	}

	async decideTool(request: ToolDecisionRequest): Promise<void> {
		this.requirePendingTool(request);
		const resource = vscode.Uri.parse(request.sessionResource);
		await focusChatSession(resource);
		await decideTool(resource, request.decision);
		await new Promise(resolve => setTimeout(resolve, 25));
		await this.syncNow(request.sessionResource);
	}

	/**
	 * Runs VS Code's chat export for the selected session once, on demand. This is the only
	 * path that touches the renderer's chat model, so it is never scheduled automatically.
	 */
	async syncNow(sessionResource?: string): Promise<void> {
		const target = sessionResource ?? this.core.getState().activeSessionResource;
		if (!target) {
			return;
		}
		if (this.exportRunning) {
			await this.exportRunning;
			return;
		}
		this.exportRunning = this.runExport(target).finally(() => {
			this.exportRunning = undefined;
		});
		await this.exportRunning;
	}

	dispose(): void {
		this.disposed = true;
		this.clearStallProbe();
		this.nativeInputStateSync.dispose();
		this.core.dispose();
		this.closeNativeStateDatabases();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	// #region state assembly

	private onCoreChanged(): void {
		const coreState = this.core.getState();
		for (const session of coreState.sessions) {
			if (session.turns.length > 0) {
				this.completePendingTurn(session.resource, session.turns);
			}
		}
		this.error = undefined;
		this.scheduleStallProbe(coreState.sessions.find(session => session.resource === coreState.activeSessionResource));
		this.emit();
	}

	/**
	 * Live sources cannot see whether a tool is waiting for confirmation. When a tool on the
	 * newest turn is still running after a grace period, run one export so the dashboard learns
	 * the renderer's real state. Auto-approving sessions never wait, so they are never probed.
	 */
	private scheduleStallProbe(active: ActiveSessionState | undefined): void {
		if (!active || this.eventClientCount === 0 || this.stallProbeTimer || active.permissionLevel !== 'default') {
			return;
		}
		const lastTurn = active.turns.at(-1);
		const candidate = lastTurn?.status === 'working'
			? lastTurn.activities.find(activity => activity.toolId !== undefined && activity.status !== 'completed' && !this.probedToolCalls.has(`${active.resource}:${activity.id}`))
			: undefined;
		if (!candidate) {
			return;
		}
		const key = `${active.resource}:${candidate.id}`;
		this.stallProbeTimer = setTimeout(() => {
			this.stallProbeTimer = undefined;
			if (this.disposed || this.eventClientCount === 0) {
				return;
			}
			const current = this.getSessions().find(session => session.resource === active.resource);
			const stillPending = current?.turns.at(-1)?.activities.some(activity => activity.id === candidate.id && activity.status !== 'completed');
			if (!stillPending) {
				return;
			}
			this.rememberProbe(key);
			void this.syncNow(active.resource);
		}, stallProbeDelayMs);
		this.stallProbeTimer.unref();
	}

	private rememberProbe(key: string): void {
		this.probedToolCalls.add(key);
		while (this.probedToolCalls.size > maximumProbedToolCalls) {
			const oldest = this.probedToolCalls.values().next().value as string | undefined;
			if (!oldest) {
				break;
			}
			this.probedToolCalls.delete(oldest);
		}
	}

	private clearStallProbe(): void {
		if (this.stallProbeTimer) {
			clearTimeout(this.stallProbeTimer);
			this.stallProbeTimer = undefined;
		}
	}

	private decorateSession(session: ActiveSessionState): ActiveSessionState {
		let decorated = session;
		if (this.exportSnapshot && this.exportSnapshot.resource === session.resource) {
			decorated = applyExportSnapshot(decorated, this.exportSnapshot);
		}
		if (this.nativeModelOverride && this.nativeModelOverride.resource === session.resource) {
			decorated = { ...decorated, model: this.nativeModelOverride.model };
		}
		return decorated;
	}

	private emit(): void {
		if (this.disposed) {
			return;
		}
		const state = this.getState();
		const signature = stateSignature(state);
		if (signature === this.lastEmittedSignature) {
			return;
		}
		this.lastEmittedSignature = signature;
		this.changeEmitter.fire(state);
	}

	private getSessions(): readonly ActiveSessionState[] {
		return this.getState().sessions;
	}

	// #endregion

	// #region export (on demand)

	private async runExport(sessionResource: string): Promise<void> {
		try {
			const sessions = this.getSessions();
			const target = sessions.find(session => session.resource === sessionResource);
			if (!target || target.status === 'loading') {
				return;
			}
			await focusChatSession(vscode.Uri.parse(sessionResource));
			this.liveExportFileSystem.reset();
			await vscode.commands.executeCommand('workbench.action.chat.export', this.liveExportUri);
			const bytes = this.liveExportFileSystem.readFile();
			if (bytes.byteLength === 0) {
				return;
			}
			const exported = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
			if (!isRecord(exported)) {
				return;
			}
			const transcript = normalizeTranscript(exported);
			if (transcript.turns.length === 0) {
				return;
			}
			const matched = findMatchingSession(sessions, transcript) ?? target;
			const stabilized = this.liveExportTracker.stabilize(matched.resource, transcript);
			this.completePendingTurn(matched.resource, stabilized.turns);
			const requests = Array.isArray(exported.requests) ? exported.requests : [];
			const lastRequest = requests.at(-1);
			this.exportSnapshot = {
				resource: matched.resource,
				turnId: stabilized.turns.at(-1)?.id,
				pendingToolIds: isRecord(lastRequest) ? pendingConfirmationToolIds(lastRequest) : [],
				model: parseSessionModelState(exported),
				capturedAt: Date.now(),
			};
			this.emit();
		} catch (error) {
			this.log(`export failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async pokeAfterCommand(sessionResource: string): Promise<void> {
		const sessionId = sessionIdFromResource(sessionResource);
		if (sessionId) {
			await this.core.pokeSession(sessionId);
		}
	}

	// #endregion

	// #region model catalog & native input state

	private createNativeInputStateWatcher(onChange: () => void, onError: () => void): NativeInputStateWatcher {
		const directories = new Set([path.dirname(this.profileStateDatabasePath), path.dirname(this.applicationStateDatabasePath)]);
		const watchers = [...directories].map(directory => {
			const watcher = watch(directory, { persistent: false }, (eventType, fileName) => {
				const name = fileName ? path.basename(String(fileName)) : undefined;
				if (name && !nativeStateDatabaseFiles.has(name)) {
					return;
				}
				if (!name || (eventType === 'rename' && name === 'state.vscdb')) {
					this.nativeStateDatabaseNeedsReconnect = true;
				}
				onChange();
			});
			watcher.on('error', onError);
			return watcher;
		});
		return { dispose: () => watchers.forEach(watcher => watcher.close()) };
	}

	private closeNativeStateDatabases(): void {
		this.nativeStateDatabase?.close();
		this.nativeStateDatabase = undefined;
		if (this.applicationStateDatabase !== undefined) {
			this.applicationStateDatabase.close();
			this.applicationStateDatabase = undefined;
		}
	}

	private openNativeStateDatabases(): { profile: DatabaseSync; application: DatabaseSync } {
		if (this.nativeStateDatabaseNeedsReconnect) {
			this.closeNativeStateDatabases();
			this.nativeStateDatabaseNeedsReconnect = false;
		}
		const profile = this.nativeStateDatabase ??= new DatabaseSync(this.profileStateDatabasePath, { readOnly: true });
		const application = this.applicationStateDatabasePath === this.profileStateDatabasePath
			? profile
			: this.applicationStateDatabase ??= new DatabaseSync(this.applicationStateDatabasePath, { readOnly: true });
		return { profile, application };
	}

	/**
	 * One read of VS Code's storage answers three questions: which models exist (the picker's
	 * cached list), which model the panel currently has selected, and how it is configured.
	 * Runs only on storage file events, so it must never leave stale derived state behind.
	 */
	private async refreshNativeInputState(): Promise<void> {
		try {
			const resource = await this.readNativeCurrentSession();
			const { profile, application } = this.openNativeStateDatabases();
			try {
				const rows = [
					...profile.prepare("SELECT key, value FROM ItemTable WHERE key = 'chat.currentLanguageModel.panel'").all() as Array<{ key: string; value: string }>,
					...application.prepare(`SELECT key, value FROM ItemTable WHERE key IN ('chat.modelConfiguration.panel', '${cachedLanguageModelsStorageKey}')`).all() as Array<{ key: string; value: string }>,
				];
				this.nativeStateRetryAttempted = false;
				let changed = this.updateCatalog(rows.find(row => row.key === cachedLanguageModelsStorageKey)?.value);
				const snapshot = createNativeChatInputStateSnapshot(rows);
				this.storedModelConfigurations = snapshot.configurations;
				const fingerprint = JSON.stringify([resource, this.catalogRaw?.length, snapshot.rawModelId, snapshot.rawConfiguration, this.modelIntent?.modelId]);
				if (fingerprint !== this.lastNativeInputFingerprint) {
					this.lastNativeInputFingerprint = fingerprint;
					changed = this.updateNativeModelOverride(resource, snapshot.state.modelId, snapshot.state.configuration) || changed;
				}
				if (changed) {
					this.emit();
				}
			} catch (error) {
				this.closeNativeStateDatabases();
				this.nativeStateDatabaseNeedsReconnect = false;
				this.lastNativeInputFingerprint = undefined;
				if (!this.nativeStateRetryAttempted) {
					this.nativeStateRetryAttempted = true;
					this.nativeInputStateSync.requestRefresh();
				}
				throw error;
			}
		} catch (error) {
			// Storage reads are opportunistic; the persisted session log remains the fallback.
			this.log(`native state read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private updateCatalog(raw: string | undefined): boolean {
		if (raw === this.catalogRaw) {
			return false;
		}
		const parsed = raw === undefined ? emptyModelCatalog : parseCachedLanguageModels(raw);
		if (!parsed) {
			return false;
		}
		this.catalogRaw = raw;
		this.catalog = parsed;
		return true;
	}

	/**
	 * The panel's stored selection describes the chat VS Code has focused. When it cannot be
	 * resolved (no focused chat, model unknown) the override is dropped rather than kept, so
	 * the session log's own value shows instead of a selection that is no longer current.
	 *
	 * VS Code flushes storage lazily, so right after the dashboard picks a model the stored value
	 * still names the previous one; a fresh intent outranks such reads until storage agrees.
	 */
	private updateNativeModelOverride(resource: string | undefined, storedModelId: string | undefined, configuration: Readonly<Record<string, string | number | boolean>>): boolean {
		let modelId = storedModelId;
		const intent = this.modelIntent;
		if (intent) {
			if (intent.resource !== resource || Date.now() - intent.at > modelIntentGraceMs) {
				this.modelIntent = undefined;
			} else if (storedModelId === intent.modelId) {
				this.modelIntent = undefined;
			} else {
				modelId = intent.modelId;
				configuration = this.storedModelConfigurations[intent.modelId] ?? {};
			}
		}
		const session = resource ? this.core.getState().sessions.find(candidate => candidate.resource === resource) : undefined;
		const model = modelId ? this.catalog.models.find(candidate => candidate.identifier === modelId) : undefined;
		if (!session || !model) {
			const had = this.nativeModelOverride !== undefined;
			this.nativeModelOverride = undefined;
			return had;
		}
		const next = withNativeModelState(session.model, model, configuration);
		const current = this.nativeModelOverride;
		if (current && current.resource === resource && current.model.selectedModelId === next.selectedModelId
			&& configurationEquals(current.model.configuration, next.configuration)) {
			return false;
		}
		this.nativeModelOverride = { resource: session.resource, model: next };
		return true;
	}

	private async updateProfileModelConfiguration(
		model: ChatModelDescriptor,
		key: string,
		value: string | number | boolean,
		defaultValue: string | number | boolean | undefined,
	): Promise<void> {
		try {
			let current: unknown = [];
			try {
				current = JSON.parse(await fs.readFile(this.languageModelsConfigurationPath, 'utf8')) as unknown;
			} catch (error) {
				if (!isFileNotFound(error)) {
					throw error;
				}
			}
			const updated = updateProfileModelConfiguration(current, {
				vendor: model.vendor,
				modelId: model.id,
				groupName: model.vendor === 'copilot' ? 'Copilot' : model.providerName,
				key,
				value,
				defaultValue,
			});
			await fs.writeFile(this.languageModelsConfigurationPath, JSON.stringify(updated, undefined, '\t'), 'utf8');
		} catch (error) {
			this.error = `Chat configuration changed, but the profile default could not be updated: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	// #endregion

	// #region session file helpers

	private async waitForPersistedModel(sessionId: string, modelId: string): Promise<Record<string, unknown> | undefined> {
		for (let attempt = 0; attempt < persistWaitAttempts; attempt++) {
			await this.core.pokeSession(sessionId);
			const session = this.core.getState().sessions.find(candidate => candidate.sessionId === sessionId);
			const selected = session?.model?.selectedModelId;
			if (selected && (selected === modelId || selected.split('/').at(-1) === modelId.split('/').at(-1))) {
				return {
					identifier: selected,
					...(session?.model?.selectedModelName ? { metadata: { name: session.model.selectedModelName } } : {}),
					modelConfiguration: session?.model?.configuration ?? {},
				};
			}
			await new Promise(resolve => setTimeout(resolve, persistWaitDelayMs));
		}
		return undefined;
	}

	/** Appends one mutation line, refusing to write into a log whose last line is still being written. */
	private async appendMutation(filePath: string, mutation: unknown): Promise<void> {
		const handle = await fs.open(filePath, 'r');
		let endsWithNewline: boolean;
		try {
			const stat = await handle.stat();
			if (stat.size === 0) {
				throw new MonitorRequestError(409, 'VS Code has not persisted this chat yet. Try again in a moment.');
			}
			const last = Buffer.alloc(1);
			await handle.read(last, 0, 1, stat.size - 1);
			endsWithNewline = last[0] === 0x0a;
		} finally {
			await handle.close();
		}
		if (!endsWithNewline) {
			throw new MonitorRequestError(409, 'VS Code is still persisting this chat. Try again.');
		}
		await fs.appendFile(filePath, `${JSON.stringify(mutation)}\n`, 'utf8');
	}

	private async requireSessionFile(resource: string): Promise<{ filePath: string }> {
		const sessionId = requireSessionId(resource);
		const known = this.core.sessionFile(sessionId);
		if (known) {
			return known;
		}
		for (const directory of this.sessionDirectories) {
			const filePath = path.join(directory, `${sessionId}.jsonl`);
			try {
				await fs.access(filePath);
				return { filePath };
			} catch {
				continue;
			}
		}
		throw new MonitorRequestError(404, 'The persisted Copilot session file is no longer available.');
	}

	// #endregion

	// #region commands helpers

	private async createSessionOnce(request: CreateSessionRequest): Promise<CreateSessionResult> {
		const source = request.sourceSessionResource
			? this.getSessions().find(session => session.resource === request.sourceSessionResource)
			: undefined;
		if (request.sourceSessionResource && !source) {
			throw new MonitorRequestError(404, 'The source Copilot session is no longer available.');
		}
		const resource = await this.createIdentifiedChat(source);
		const sessionId = decodeLocalSessionId(resource);
		this.createdSessionResources.add(resource.toString());
		this.nativeCurrentSessionResource = resource.toString();
		await this.core.selectSession(sessionId);
		await this.core.pokeSession(sessionId);
		this.emit();
		return { sessionResource: resource.toString() };
	}

	private requirePendingTool(request: ToolDecisionRequest): void {
		if (!isActivePendingTool(this.getSessions(), request)) {
			throw new MonitorRequestError(409, 'The requested tool is no longer the active pending confirmation.');
		}
	}

	private requireIdleSession(resource: string, busyMessage = 'Wait for the active response to finish.'): ActiveSessionState {
		const session = this.getSessions().find(candidate => candidate.resource === resource);
		if (!session) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		if (session.status === 'working') {
			throw new MonitorRequestError(409, busyMessage);
		}
		return session;
	}

	private setOutboundMessage(message: OutboundMessageState): void {
		this.outboundMessages.set(message.id, message);
		while (this.outboundMessages.size > maximumOutboundHistory) {
			const oldest = this.outboundMessages.keys().next().value as string | undefined;
			if (!oldest) {
				break;
			}
			this.outboundMessages.delete(oldest);
		}
		this.emit();
	}

	private updateOutboundMessage(id: string, update: Pick<OutboundMessageState, 'status'> & { error?: string }): void {
		const current = this.outboundMessages.get(id);
		if (!current) {
			return;
		}
		this.outboundMessages.set(id, { ...current, ...update });
		this.emit();
	}

	private completePendingTurn(sessionResource: string, turns: readonly TranscriptTurn[]): void {
		const completedTurn = this.liveExportTracker.observe(sessionResource, turns);
		if (completedTurn) {
			this.updateOutboundMessage(completedTurn.outboundMessageId, { status: 'completed' });
		}
	}

	// #endregion
}

export function resolveSessionDirectories(context: vscode.ExtensionContext): string[] {
	const globalStorageHome = path.dirname(context.globalStorageUri.fsPath);
	if (context.storageUri) {
		return [path.join(path.dirname(context.storageUri.fsPath), 'chatSessions')];
	}
	return [path.join(globalStorageHome, 'emptyWindowChatSessions')];
}

export function resolveCopilotTranscriptDirectories(context: vscode.ExtensionContext): string[] {
	if (!context.storageUri) {
		return [];
	}
	return [path.join(path.dirname(context.storageUri.fsPath), 'GitHub.copilot-chat', 'transcripts')];
}

export function resolveCopilotDebugLogDirectories(context: vscode.ExtensionContext): string[] {
	if (!context.storageUri) {
		return [];
	}
	return [path.join(path.dirname(context.storageUri.fsPath), 'GitHub.copilot-chat', 'debug-logs')];
}

/** PROFILE-scoped storage lives next to the extension's global storage folder. */
export function resolveProfileStateDatabasePath(context: vscode.ExtensionContext): string {
	return path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
}

/**
 * APPLICATION-scoped storage is always `User/globalStorage/state.vscdb`. For the default
 * profile that is the profile database; for a custom profile the extension's global storage
 * sits under `User/profiles/<id>/globalStorage`, so walk back to `User`.
 */
export function resolveApplicationStateDatabasePath(context: vscode.ExtensionContext): string {
	const globalStorage = path.dirname(context.globalStorageUri.fsPath);
	const profileDirectory = path.dirname(globalStorage);
	if (path.basename(path.dirname(profileDirectory)) === 'profiles') {
		return path.join(path.dirname(path.dirname(profileDirectory)), 'globalStorage', 'state.vscdb');
	}
	return path.join(globalStorage, 'state.vscdb');
}

/** Workspace windows keep the chat index in workspace storage; empty windows in application storage. */
export function resolveSessionIndexDatabasePath(context: vscode.ExtensionContext): string {
	if (context.storageUri) {
		return path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb');
	}
	return path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
}

/** The digest lives next to the sessions it describes: per workspace, or global for empty windows. */
export function resolveDigestDatabasePath(context: vscode.ExtensionContext): string {
	if (context.storageUri) {
		return path.join(context.storageUri.fsPath, 'history.db');
	}
	return path.join(context.globalStorageUri.fsPath, 'history-empty-window.db');
}

/** Resolves once the file's size has stopped changing (VS Code's dispose-time write has landed). */
async function waitForFileToSettle(filePath: string, quietMs = 150, maximumMs = 2_000): Promise<void> {
	const deadline = Date.now() + maximumMs;
	let lastSize = -1;
	let quietSince = Date.now();
	while (Date.now() < deadline) {
		let size: number;
		try {
			size = (await fs.stat(filePath)).size;
		} catch {
			size = -1;
		}
		if (size !== lastSize) {
			lastSize = size;
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function stateSignature(state: MonitorState): string {
	const parts: string[] = [state.activeSessionResource ?? '', state.error ?? '', state.models.map(model => model.identifier).join(',')];
	for (const session of state.sessions) {
		parts.push(session.resource, session.revision, session.status, session.title, String(session.updatedAt ?? 0), String(session.isEmpty), session.model?.selectedModelId ?? '', JSON.stringify(session.model?.configuration ?? {}));
	}
	for (const message of state.outboundMessages) {
		parts.push(message.id, message.status);
	}
	return parts.join('\u0000');
}

function requireSessionId(resource: string): string {
	const sessionId = sessionIdFromResource(resource);
	if (!sessionId) {
		throw new MonitorRequestError(400, 'The session resource is not a local Copilot chat session.');
	}
	return sessionId;
}

function decodeLocalSessionId(resource: vscode.Uri): string {
	const sessionId = sessionIdFromResource(resource.toString());
	if (!sessionId) {
		throw new MonitorRequestError(409, 'VS Code created an unsupported chat session resource.');
	}
	return sessionId;
}

function summarize(value: string, length: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function configurationEquals(
	left: Readonly<Record<string, string | number | boolean>>,
	right: Readonly<Record<string, string | number | boolean>>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return leftKeys.length === rightKeys.length
		&& leftKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
