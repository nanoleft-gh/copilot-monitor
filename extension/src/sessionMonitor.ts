import { FSWatcher, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { readStableUtf8 } from './boundedFileRead';
import { buildLocalSessionResource, createNewChat, decideTool, editAndResubmitPrompt, focusChatSession, releaseChatSession, selectChatModel, sendPrompt, setChatPermissionLevel } from './chatBridge';
import { LiveExportFileSystem, liveExportScheme } from './liveExportFileSystem';
import { LiveExportTracker } from './liveExportTracker';
import { mergeConfigurationFields, mergeSessionModelState, parseSessionModelState, readLatestModelCatalog, withNativeModelState, withSelectedModel } from './modelCatalog';
import { createSessionModelConfigurationMutation, createSessionValueMutation, updateProfileModelConfiguration } from './modelConfigurationUpdate';
import { createNativeChatInputStateSnapshot } from './nativeChatInputState';
import { NativeInputStateSync, NativeInputStateWatcher } from './nativeInputStateSync';
import { findMatchingSession } from './sessionMatcher';
import {
	isPersistedSessionWithinMemoryBudget,
	maximumPersistedSessionBytes,
	maximumWorkspaceSessionBytes,
	SessionStateCache,
} from './sessionStateCache';
import { planSessionLoads } from './sessionLoadPolicy';
import {
	indexProgressiveTranscript,
	loadProgressiveTranscriptPage,
	ProgressiveTranscriptIndex,
} from './progressiveTranscript';
import {
	deserializePagedMutationHistoryIndex,
	PagedMutationHistoryIndex,
	serializePagedMutationHistoryIndex,
	SerializedPagedMutationHistoryIndex,
} from './pagedMutationHistory';
import { indexPagedMutationHistoryInWorker, loadPagedMutationHistoryInWorker } from './pagedMutationHistoryWorkerClient';
import { readProgressiveMutationSummary } from './progressiveMutationSummary';
import { readProgressiveMutationValue } from './progressiveMutationValue';
import { shouldPreserveProgressiveSession } from './progressiveSessionPolicy';
import { isActivePendingTool } from './toolDecision';
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
	ToolDecisionRequest,
} from './protocol';
import {
	mergeTranscriptSupplement,
	normalizeTranscript,
	parseCopilotTranscriptLog,
	parseMutationLogSnapshot,
	Transcript,
} from './transcript';

const fallbackPollIntervalMs = 1_000;
const liveExportIntervalMs = 2_000;
const fileEventDebounceMs = 20;
const partialWriteRetryMs = 500;
const maximumMessageLength = 32_000;
const maximumOutboundHistory = 20;
const modelCatalogRefreshIntervalMs = 10_000;
const maximumProgressiveIndexCacheFiles = 64;
const maximumProgressiveIndexCacheBytes = 64 * 1024 * 1024;
const nativeStateDatabaseFiles = new Set(['state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm']);

export class SessionMonitor implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<MonitorState>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly outboundMessages = new Map<string, OutboundMessageState>();
	private readonly startedAt = Date.now();
	private readonly sessionDirectories: string[];
	private readonly copilotTranscriptDirectories: string[];
	private readonly copilotModelDirectories: string[];
	private readonly languageModelsConfigurationPath: string;
	private readonly stateDatabasePath: string;
	private nativeStateDatabase: DatabaseSync | undefined;
	private nativeStateDatabaseNeedsReconnect = false;
	private nativeStateRetryAttempted = false;
	private lastNativeInputFingerprint: string | undefined;
	private readonly watchedDirectories: string[];
	private readonly directoryWatchers = new Map<string, FSWatcher>();
	private readonly sessionStateCache = new SessionStateCache();
	private readonly fileFingerprints = new Map<string, string>();
	private activeSession: ActiveSessionState | undefined;
	private error: string | undefined;
	private liveExportRunning = false;
	private readonly liveExportTracker = new LiveExportTracker();
	private liveExportTargetResource: string | undefined;
	private scheduledPoll: NodeJS.Timeout | undefined;
	private pollQueue = Promise.resolve();
	private readonly fallbackPollTimer: NodeJS.Timeout;
	private readonly liveExportTimer: NodeJS.Timeout;
	private readonly nativeInputStateSync: NativeInputStateSync;
	private readonly liveExportUri: vscode.Uri;
	private readonly liveExportFileSystem = new LiveExportFileSystem();
	private models: readonly ChatModelDescriptor[] = [];
	private modelCatalogRevision: string | undefined;
	private nextModelCatalogScanAt = 0;
	private eventClientCount = 0;
	private readonly progressiveIndexes = new Map<string, ProgressiveTranscriptIndex>();
	private readonly progressiveMutationIndexes = new Map<string, PagedMutationHistoryIndex>();
	private readonly progressiveMutationIndexing = new Map<string, Promise<PagedMutationHistoryIndex>>();
	private readonly progressiveMutationLoading = new Set<string>();
	private readonly progressiveSupplementMissingSince = new Map<string, number>();
	private readonly progressiveIndexDirectory: string;
	private readonly progressiveAbortController = new AbortController();
	private readonly diagnosticSessionSignatures = new Map<string, string>();
	private readonly createSessionOperations = new Map<string, Promise<CreateSessionResult>>();
	private disposed = false;

	readonly onDidChange = this.changeEmitter.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly windowId: string,
		private readonly log: (message: string) => void = () => undefined,
	) {
		this.progressiveIndexDirectory = path.join(context.globalStorageUri.fsPath, 'progressive-history');
		this.disposables.push(this.changeEmitter);
		this.sessionDirectories = resolveSessionDirectories(context);
		this.copilotTranscriptDirectories = resolveCopilotTranscriptDirectories(context);
		this.copilotModelDirectories = resolveCopilotModelDirectories(context);
		this.languageModelsConfigurationPath = path.join(
			path.dirname(path.dirname(context.globalStorageUri.fsPath)),
			'chatLanguageModels.json',
		);
		this.stateDatabasePath = path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
		this.nativeInputStateSync = new NativeInputStateSync({
			refresh: () => this.refreshNativeInputState(),
			createWatcher: (onChange, onError) => this.createNativeInputStateWatcher(onChange, onError),
		});
		this.watchedDirectories = [...new Set([
			...this.sessionDirectories,
			...this.copilotTranscriptDirectories,
			...this.copilotModelDirectories,
		])];
		this.liveExportUri = vscode.Uri.from({
			scheme: liveExportScheme,
			authority: this.windowId,
			path: '/chat.json',
		});
		this.disposables.push(this.liveExportFileSystem);
		this.disposables.push(vscode.workspace.registerFileSystemProvider(
			liveExportScheme,
			this.liveExportFileSystem,
			{ isCaseSensitive: true },
		));

		this.ensureDirectoryWatchers();
		this.fallbackPollTimer = setInterval(() => this.schedulePoll(), fallbackPollIntervalMs);
		this.fallbackPollTimer.unref();
		this.liveExportTimer = setInterval(() => void this.refreshLiveExport(), liveExportIntervalMs);
		this.liveExportTimer.unref();
		this.nativeInputStateSync.start();
		this.schedulePoll();
	}

	getState(): MonitorState {
		const sessions = this.getSessions();
		const activeResource = this.activeSession?.resource;
		const serializedSessions = sessions.map(session => activeResource === session.resource
			? session
			: { ...session, turns: [] });
		return {
			version: 1,
			windowId: this.windowId,
			workspaceName: vscode.workspace.name ?? 'Untitled workspace',
			workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
			startedAt: this.startedAt,
			models: this.models,
			sessions: serializedSessions,
			activeSession: this.activeSession ? { ...this.activeSession, turns: [] } : undefined,
			activeSessionResource: activeResource,
			outboundMessages: [...this.outboundMessages.values()],
			error: this.error,
		};
	}

	setEventClientCount(count: number): void {
		const hadClients = this.eventClientCount > 0;
		this.eventClientCount = count;
		if (count > 0 && !hadClients) {
			void this.refreshLiveExport(true);
		}
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

		this.setOutboundMessage({
			id: request.id,
			preview: summarize(text, 120),
			status: 'accepted',
			createdAt: Date.now(),
		});
		this.liveExportTracker.begin(text, request.id, Date.now(), request.sessionResource);
		this.liveExportTargetResource = request.sessionResource;
		void this.refreshLiveExport(true);

		void sendPrompt(vscode.Uri.parse(request.sessionResource), text).catch(error => {
			this.liveExportTracker.cancel(request.id);
			this.updateOutboundMessage(request.id, {
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
			});
		});

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
		const usesEventTranscript = this.progressiveIndexes.has(request.sessionResource);
		const localRequestIndex = usesEventTranscript
			? -1
			: targetSession.turns.findIndex(turn => turn.id === request.requestId && turn.editable);
		let requestIndex = localRequestIndex < 0 ? -1 : (targetSession.historyStart ?? 0) + localRequestIndex;
		let progressiveMutationIndex = this.progressiveMutationIndexes.get(request.sessionResource);
		if (usesEventTranscript && request.sourceText) {
			const sessionFile = await this.requireSessionFile(request.sessionResource);
			progressiveMutationIndex ??= await this.getProgressiveMutationIndex(sessionFile);
			this.progressiveMutationIndexes.set(request.sessionResource, progressiveMutationIndex);
			requestIndex = findProgressiveRequestIndex(
				progressiveMutationIndex.requests,
				request.sourceText,
				request.sourceTimestamp,
			);
		}
		if (requestIndex < 0 && progressiveMutationIndex) {
			requestIndex = progressiveMutationIndex.requests.findIndex(value => value.requestId === request.requestId);
		}
		if (requestIndex < 0) {
			throw new MonitorRequestError(409, 'The selected request is no longer editable.');
		}
		const nativeRequestId = progressiveMutationIndex && usesEventTranscript
			? progressiveMutationIndex.requests[requestIndex]?.requestId
			: request.requestId;
		if (typeof nativeRequestId !== 'string' || !nativeRequestId) {
			throw new MonitorRequestError(409, 'The selected request could not be resolved in VS Code.');
		}
		if (this.outboundMessages.has(request.id)) {
			return { id: request.id, accepted: true };
		}

		this.setOutboundMessage({
			id: request.id,
			preview: `Edit: ${summarize(text, 114)}`,
			status: 'accepted',
			createdAt: Date.now(),
		});
		this.liveExportTracker.begin(text, request.id, Date.now(), request.sessionResource);
		this.liveExportTargetResource = request.sessionResource;
		void editAndResubmitPrompt(
			vscode.Uri.parse(request.sessionResource),
			requestIndex,
			targetSession.turnCount ?? targetSession.turns.length,
			text,
		).then(() => this.refreshLiveExportWhenIdle()).catch(error => {
			this.liveExportTracker.cancel(request.id);
			this.updateOutboundMessage(request.id, {
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return { id: request.id, accepted: true };
	}

	async selectSession(sessionResource: string): Promise<void> {
		let targetSession = this.getSessions().find(session => session.resource === sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		let mutationFileToIndex: SessionFile | undefined;
		if (targetSession.revision.startsWith('placeholder:')) {
			const file = (await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories))
				.find(candidate => buildLocalSessionResource(candidate.sessionId).toString() === sessionResource);
			if (file && isPersistedSessionWithinMemoryBudget(file.size + file.supplementSize)) {
				this.fileFingerprints.delete(file.filePath);
				await this.refreshSession(file, true);
				targetSession = this.getSessions().find(session => session.resource === sessionResource) ?? targetSession;
			} else if (file && file.supplementSize === 0) {
				mutationFileToIndex = file;
			}
		}
		await focusChatSession(vscode.Uri.parse(targetSession.resource));
		this.activeSession = targetSession;
		this.liveExportTargetResource = targetSession.resource;
		this.emit();
		if (mutationFileToIndex) {
			this.markProgressiveMutationIndexing(mutationFileToIndex);
			void this.loadProgressiveMutationSession(mutationFileToIndex).catch(error => {
				if (this.disposed) {return;}
				this.restoreProgressiveMutationPlaceholder(mutationFileToIndex);
				this.error = error instanceof Error ? error.message : String(error);
				this.emit();
			});
			return;
		}
		void this.refreshLiveExport(true);
	}

	async loadHistory(request: HistoryPageRequest): Promise<HistoryPageResult> {
		const session = this.getSessions().find(candidate => candidate.resource === request.sessionResource);
		if (!session) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		if (session.revision !== request.sessionRevision) {
			throw new MonitorRequestError(409, 'The conversation changed before history could be loaded. Refresh and try again.');
		}
		let index = this.progressiveIndexes.get(request.sessionResource);
		let mutationIndex = this.progressiveMutationIndexes.get(request.sessionResource);
		if (!index && !mutationIndex) {
			const file = (await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories))
				.find(candidate => buildLocalSessionResource(candidate.sessionId).toString() === request.sessionResource);
			if (file) {
				const supplementPath = await findExistingFile(this.copilotTranscriptDirectories, `${file.sessionId}.jsonl`);
				if (supplementPath) {
					index = await indexProgressiveTranscript(supplementPath);
					if (index.complete) {
						this.progressiveIndexes.set(request.sessionResource, index);
					}
				} else {
					mutationIndex = await this.getProgressiveMutationIndex(file);
					this.progressiveMutationIndexes.set(request.sessionResource, mutationIndex);
				}
			}
		}
		if (!index && !mutationIndex) {
			throw new MonitorRequestError(409, 'Earlier history remains available only in VS Code.');
		}
		const totalCount = index?.turnOffsets.length ?? mutationIndex!.requests.length;
		const end = Math.max(0, Math.min(Math.floor(request.before), totalCount));
		const limit = Math.max(1, Math.min(Math.floor(request.limit ?? 40), 40));
		const start = Math.max(0, end - limit);
		const page = index
			? await loadProgressiveTranscriptPage(index, start, end - start)
			: await loadPagedMutationHistoryInWorker(
				mutationIndex!, start, end - start, session.revision, this.progressiveAbortController.signal,
			);
		return { ...page, revision: session.revision };
	}

	async selectModel(request: ModelSelectionRequest): Promise<void> {
		const targetSession = this.getSessions().find(session => session.resource === request.sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		if (targetSession.status === 'working') {
			throw new MonitorRequestError(409, 'Wait for the active response to finish before changing models.');
		}
		const model = this.models.find(candidate => candidate.identifier === request.modelId || candidate.id === request.modelId);
		if (!model) {
			throw new MonitorRequestError(409, 'The requested model is no longer available in this VS Code window.');
		}

		this.liveExportTargetResource = targetSession.resource;
		await selectChatModel(vscode.Uri.parse(targetSession.resource), { id: model.id, vendor: model.vendor });
		if (this.sessionStateCache.updateModel(targetSession.resource, withSelectedModel(targetSession.model, model))) {
			this.activeSession = this.getSessions().find(session => session.resource === this.activeSession?.resource);
			this.emit();
		}
		void this.refreshLiveExportWhenIdle();
	}

	async configureModel(request: ModelConfigurationRequest): Promise<void> {
		const targetSession = this.getSessions().find(session => session.resource === request.sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		if (targetSession.status === 'working') {
			throw new MonitorRequestError(409, 'Wait for the active response to finish before changing model configuration.');
		}
		if (targetSession.model?.selectedModelId !== request.modelId) {
			throw new MonitorRequestError(409, 'The selected model changed before its configuration could be updated.');
		}
		const model = this.models.find(candidate => candidate.identifier === request.modelId);
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

		const sessionFile = (await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories))
			.find(file => buildLocalSessionResource(file.sessionId).toString() === request.sessionResource);
		if (!sessionFile) {
			throw new MonitorRequestError(404, 'The persisted Copilot session file is no longer available.');
		}

		const resource = vscode.Uri.parse(request.sessionResource);
		this.liveExportTargetResource = request.sessionResource;
		await releaseChatSession(resource);
		try {
			let content = '';
			let snapshot: ReturnType<typeof parseMutationLogSnapshot> | undefined;
			for (let attempt = 0; attempt < 40; attempt++) {
				const currentStat = await fs.stat(sessionFile.filePath);
				if (isPersistedSessionWithinMemoryBudget(currentStat.size + sessionFile.supplementSize)) {
					const sessionRead = await readStableUtf8(sessionFile.filePath, currentStat);
					if (sessionRead.stable) {
						const candidate = parseMutationLogSnapshot(sessionRead.content);
						if (candidate.complete && selectedModelMatches(candidate.state, request.modelId)) {
							content = sessionRead.content;
							snapshot = candidate;
							break;
						}
					}
				} else {
					const candidate = await readProgressiveMutationValue(
						sessionFile.filePath,
						['inputState', 'selectedModel'],
					);
					const state = { inputState: { selectedModel: candidate.value } };
					if (candidate.complete && candidate.stable && selectedModelMatches(state, request.modelId)) {
						snapshot = { state, complete: true };
						break;
					}
				}
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			if (!snapshot) {
				throw new MonitorRequestError(409, 'VS Code is still applying the selected model. Try the configuration change again.');
			}
			const mutation = createSessionModelConfigurationMutation(
				snapshot.state,
				request.modelId,
				request.key,
				request.value,
			);
			const separator = content.length === 0 || !content.endsWith('\n') ? '\n' : '';
			await fs.appendFile(sessionFile.filePath, `${separator}${JSON.stringify(mutation)}\n`, 'utf8');
			await this.updateProfileModelConfiguration(model, field.key, request.value, field.defaultValue);
			this.fileFingerprints.delete(sessionFile.filePath);
			await this.refreshSession(sessionFile);
			this.activeSession = this.getSessions().find(session => session.resource === request.sessionResource);
			this.emit();
		} finally {
			await focusChatSession(resource);
		}
		void this.refreshLiveExportWhenIdle();
	}

	async renameSession(request: RenameSessionRequest): Promise<void> {
		const title = request.title.trim();
		if (!title || title.length > 160) {
			throw new MonitorRequestError(400, 'A chat title between 1 and 160 characters is required.');
		}
		const target = this.requireIdleSession(request.sessionResource);
		const sessionFile = await this.requireSessionFile(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		await releaseChatSession(resource);
		try {
			await this.appendSessionMutation(sessionFile, createSessionValueMutation(['customTitle'], title));
		} finally {
			await focusChatSession(resource);
		}
		this.activeSession = this.getSessions().find(session => session.resource === target.resource);
		this.emit();
	}

	async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
		if (!request.id) {return this.createSessionOnce(request);}
		const existing = this.createSessionOperations.get(request.id);
		if (existing) {return existing;}
		const operation = this.createSessionOnce(request).catch(error => {
			this.createSessionOperations.delete(request.id!);
			throw error;
		});
		this.createSessionOperations.set(request.id, operation);
		while (this.createSessionOperations.size > 32) {
			const oldest = this.createSessionOperations.keys().next().value as string | undefined;
			if (!oldest || oldest === request.id) {break;}
			this.createSessionOperations.delete(oldest);
		}
		return operation;
	}

	private async createSessionOnce(request: CreateSessionRequest): Promise<CreateSessionResult> {
		const source = request.sourceSessionResource
			? this.getSessions().find(session => session.resource === request.sourceSessionResource)
			: undefined;
		if (request.sourceSessionResource && !source) {
			throw new MonitorRequestError(404, 'The source Copilot session is no longer available.');
		}
		const previousResources = new Set(this.getSessions().map(session => session.resource));
		const previousSessionIds = new Set(
			(await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories)).map(file => file.sessionId),
		);
		let resource: vscode.Uri;
		try {
			resource = await createNewChat(source ? vscode.Uri.parse(source.resource) : undefined);
		} catch (error) {
			let createdFile: SessionFile | undefined;
			for (let attempt = 0; attempt < 100 && !createdFile; attempt++) {
				createdFile = (await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories))
					.find(file => !previousSessionIds.has(file.sessionId));
				if (!createdFile) {await new Promise(resolve => setTimeout(resolve, 100));}
			}
			if (!createdFile) {throw error;}
			resource = buildLocalSessionResource(createdFile.sessionId);
			await this.refreshSession(createdFile, true);
		}
		const persisted = this.getSessions().find(session => session.resource === resource.toString());
		if (persisted) {
			this.activeSession = persisted;
			this.liveExportTargetResource = persisted.resource;
			this.emit();
			return { sessionResource: persisted.resource };
		}
		const sessionId = decodeLocalSessionId(resource);
		const session: ActiveSessionState = {
			resource: resource.toString(),
			sessionId,
			title: 'New chat',
			status: 'idle',
			revision: `transient:${Date.now()}`,
			updatedAt: Date.now(),
			turns: [],
			model: source?.model,
			permissionLevel: source?.permissionLevel ?? 'default',
		};
		this.sessionStateCache.upsertTransient(session);
		this.activeSession = session;
		this.liveExportTargetResource = session.resource;
		this.emit();
		return { sessionResource: session.resource };
	}

	async setPermissionLevel(request: PermissionLevelRequest): Promise<void> {
		const target = this.requireIdleSession(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		if (await setChatPermissionLevel(resource, request.permissionLevel)) {
			this.liveExportTargetResource = request.sessionResource;
			void this.refreshLiveExportWhenIdle();
			return;
		}
		const sessionFile = await this.requireSessionFile(request.sessionResource);
		await releaseChatSession(resource);
		try {
			await this.appendSessionMutation(
				sessionFile,
				createSessionValueMutation(['inputState', 'permissionLevel'], request.permissionLevel),
			);
			this.activeSession = this.getSessions().find(session => session.resource === target.resource);
			this.emit();
		} finally {
			await focusChatSession(resource);
		}
	}

	async decideTool(request: ToolDecisionRequest): Promise<void> {
		this.requirePendingTool(request);
		const resource = vscode.Uri.parse(request.sessionResource);
		this.liveExportTargetResource = request.sessionResource;
		await focusChatSession(resource);

		let confirmedPending = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			await this.refreshLiveExportWhenIdle();
			try {
				this.requirePendingTool(request);
				confirmedPending = true;
				break;
			} catch {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		}
		if (!confirmedPending) {
			throw new MonitorRequestError(409, 'The pending tool changed before the decision could be applied.');
		}

		await decideTool(resource, request.decision);
		await new Promise(resolve => setTimeout(resolve, 25));
		await this.refreshLiveExportWhenIdle();
	}

	dispose(): void {
		this.disposed = true;
		this.progressiveAbortController.abort();
		clearInterval(this.fallbackPollTimer);
		clearInterval(this.liveExportTimer);
		this.nativeInputStateSync.dispose();
		if (this.scheduledPoll) {
			clearTimeout(this.scheduledPoll);
		}
		for (const watcher of this.directoryWatchers.values()) {
			watcher.close();
		}
		this.directoryWatchers.clear();
		this.nativeStateDatabase?.close();
		this.nativeStateDatabase = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private schedulePoll(delayMs = 0): void {
		if (this.scheduledPoll) {
			return;
		}
		this.scheduledPoll = setTimeout(() => {
			this.scheduledPoll = undefined;
			this.pollQueue = this.pollQueue.then(() => this.poll()).catch(error => {
				this.error = error instanceof Error ? error.message : String(error);
				this.emit();
			});
		}, delayMs);
		this.scheduledPoll.unref();
	}

	private ensureDirectoryWatchers(): void {
		for (const directory of this.watchedDirectories) {
			if (this.directoryWatchers.has(directory)) {
				continue;
			}
			try {
				const watcher = watch(directory, { persistent: false }, (_eventType, fileName) => {
					const name = fileName ? String(fileName) : undefined;
					if (!name || name.endsWith('.jsonl') || name.endsWith('models.json')) {
						if (!name || name.endsWith('models.json')) {
							this.nextModelCatalogScanAt = 0;
						}
						this.schedulePoll(fileEventDebounceMs);
					}
				});
				watcher.on('error', () => {
					watcher.close();
					this.directoryWatchers.delete(directory);
				});
				this.directoryWatchers.set(directory, watcher);
			} catch {
				// The fallback poll retries if VS Code has not created the directory yet.
			}
		}
	}

	private createNativeInputStateWatcher(onChange: () => void, onError: () => void): NativeInputStateWatcher {
		const watcher = watch(path.dirname(this.stateDatabasePath), { persistent: false }, (eventType, fileName) => {
			const name = fileName ? path.basename(String(fileName)) : undefined;
			if (name && !nativeStateDatabaseFiles.has(name)) {
				return;
			}
			if (!name || (eventType === 'rename' && name === path.basename(this.stateDatabasePath))) {
				this.nativeStateDatabaseNeedsReconnect = true;
			}
			onChange();
		});
		watcher.on('error', onError);
		return { dispose: () => watcher.close() };
	}

	private async poll(): Promise<void> {
		this.ensureDirectoryWatchers();
		let changed = await this.refreshModelCatalog();
		if (changed) {
			this.nativeInputStateSync.requestRefresh(0);
		}
		const files = await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories);
		const currentPaths = new Set(files.map(file => file.filePath));
		changed = this.sessionStateCache.removeMissingPaths(currentPaths) || changed;
		for (const filePath of this.fileFingerprints.keys()) {
			if (!currentPaths.has(filePath)) {
				this.fileFingerprints.delete(filePath);
			}
		}
		const activeSessionIds = new Set(files.map(file => file.sessionId));
		for (const sessionId of this.progressiveSupplementMissingSince.keys()) {
			if (!activeSessionIds.has(sessionId)) {
				this.progressiveSupplementMissingSince.delete(sessionId);
			}
		}

		const candidates = files.map(file => ({
			resource: buildLocalSessionResource(file.sessionId).toString(),
			size: file.size + file.supplementSize,
		}));
		const loadPlan = planSessionLoads(
			candidates,
			this.activeSession?.resource,
			maximumPersistedSessionBytes,
			maximumWorkspaceSessionBytes,
		);
		for (let index = 0; index < files.length; index++) {
			const file = files[index];
			const shouldLoad = loadPlan[index];
			changed = await this.refreshSession(file, shouldLoad) || changed;
		}

		const sessions = this.getSessions();
		const active = sessions.find(session => session.resource === this.activeSession?.resource) ?? sessions[0];
		if (this.activeSession !== active) {
			this.activeSession = active;
			changed = true;
		}
		if (changed) {
			this.error = undefined;
			this.emit('poll');
		}
	}

	private async refreshSession(file: SessionFile, shouldLoad = true): Promise<boolean> {
		try {
			const statBefore = await fs.stat(file.filePath);
			const supplementPath = await findExistingFile(
				this.copilotTranscriptDirectories,
				`${file.sessionId}.jsonl`,
			);
			if (supplementPath) {
				this.progressiveSupplementMissingSince.delete(file.sessionId);
			} else if (!this.progressiveSupplementMissingSince.has(file.sessionId)) {
				this.progressiveSupplementMissingSince.set(file.sessionId, Date.now());
			}
			const supplementStatBefore = supplementPath ? await fs.stat(supplementPath) : undefined;
			const totalSessionBytes = statBefore.size + (supplementStatBefore?.size ?? 0);
			const resource = buildLocalSessionResource(file.sessionId).toString();
			const currentSession = this.getSessions().find(session => session.resource === resource);
			if (shouldPreserveProgressiveSession({
				currentRevision: currentSession?.revision,
				primarySize: file.size,
				primaryMtimeMs: file.mtimeMs,
				supplementPresent: supplementPath !== undefined,
				supplementMissingSince: this.progressiveSupplementMissingSince.get(file.sessionId),
				now: Date.now(),
				mutationIndexing: this.progressiveMutationLoading.has(file.sessionId),
			})) {
				this.logProgressive('preserve', file, currentSession, {
					supplementPresent: supplementPath !== undefined,
					supplementMissingMs: supplementPath ? 0 : Date.now() - (this.progressiveSupplementMissingSince.get(file.sessionId) ?? Date.now()),
					mutationLoading: this.progressiveMutationLoading.has(file.sessionId),
				});
				return false;
			}
			if (!shouldLoad || !isPersistedSessionWithinMemoryBudget(totalSessionBytes)) {
				const isOversized = !isPersistedSessionWithinMemoryBudget(totalSessionBytes);
				if (isOversized && supplementPath && supplementStatBefore) {
					const progressive = await this.loadProgressiveSession(file, supplementPath, supplementStatBefore);
					return progressive.changed;
				}
				const mutationRevision = `mutation-progressive:${file.size}:${file.mtimeMs}`;
				if (isOversized && !supplementPath && this.progressiveMutationIndexes.has(resource)
					&& this.fileFingerprints.get(file.filePath) === mutationRevision) {
					return false;
				}
				if (isOversized && !supplementPath && this.fileFingerprints.get(file.filePath) !== mutationRevision) {
					this.progressiveMutationIndexes.delete(resource);
				}
				const summary = isOversized && !supplementPath
					? await readProgressiveMutationSummary(file.filePath)
					: undefined;
				const revision = `placeholder:${createFingerprint(statBefore, supplementStatBefore)}`;
				if (revision === this.fileFingerprints.get(file.filePath)) {
					return false;
				}
				this.fileFingerprints.set(file.filePath, revision);
				this.sessionStateCache.upsertPersisted(file.filePath, {
					resource,
					sessionId: summary?.sessionId || file.sessionId,
					title: summary?.title || `${isOversized ? 'Large' : 'Archived'} chat · open in VS Code (${formatBytes(totalSessionBytes)})`,
					status: 'idle',
					revision,
					updatedAt: Math.max(statBefore.mtimeMs, supplementStatBefore?.mtimeMs ?? 0),
					turns: [],
					historyUnavailable: isOversized ? 'oversized' : 'archived',
					permissionLevel: 'default',
				});
				this.logProgressive('placeholder', file, this.getSessions().find(session => session.resource === resource), {
					supplementPresent: supplementPath !== undefined,
					oversized: isOversized,
				});
				return true;
			}
			const fingerprint = createFingerprint(statBefore, supplementStatBefore);
			if (fingerprint === this.fileFingerprints.get(file.filePath)) {
				return false;
			}

			const primaryRead = await readStableUtf8(file.filePath, statBefore);
			const content = primaryRead.content;
			const statAfter = primaryRead.statAfter;
			const stableRead = primaryRead.stable;
			const snapshot = parseMutationLogSnapshot(content);
			let transcript = normalizeTranscript(snapshot.state);
			let supplementComplete = true;
			let supplementStable = true;
			let supplementStatAfter = supplementStatBefore;

			if (supplementPath && supplementStatBefore && isPersistedSessionWithinMemoryBudget(supplementStatBefore.size)) {
				const supplementRead = await readStableUtf8(supplementPath, supplementStatBefore);
				const supplementContent = supplementRead.content;
				supplementStatAfter = supplementRead.statAfter;
				supplementStable = supplementRead.stable;
				const supplement = parseCopilotTranscriptLog(supplementContent);
				supplementComplete = supplement.complete;
				transcript = mergeTranscriptSupplement(transcript, supplement);
			}

			const revision = createFingerprint(statAfter, supplementStatAfter);
			if (!snapshot.complete || !stableRead || !supplementComplete || !supplementStable) {
				this.schedulePoll(partialWriteRetryMs);
			} else {
				this.fileFingerprints.set(file.filePath, revision);
			}
			const state: ActiveSessionState = {
				resource: buildLocalSessionResource(file.sessionId).toString(),
				sessionId: transcript.sessionId || file.sessionId,
				title: transcript.title,
				status: transcript.status,
				revision,
				updatedAt: Math.max(statAfter.mtimeMs, supplementStatAfter?.mtimeMs ?? 0),
				turns: transcript.turns,
				model: parseSessionModelState(snapshot.state),
				permissionLevel: parsePermissionLevel(snapshot.state),
			};
			this.sessionStateCache.upsertPersisted(file.filePath, state);
			this.completePendingTurn(state.resource, transcript.turns);
			return true;
		} catch (error) {
			if (isFileNotFound(error)) {
				return false;
			}
			this.error = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	private async loadProgressiveSession(
		file: SessionFile,
		supplementPath: string,
		supplementStat: { size: number; mtimeMs: number },
	): Promise<{ readonly handled: true; readonly changed: boolean }> {
		const resource = buildLocalSessionResource(file.sessionId).toString();
		const revision = `progressive:${file.size}:${file.mtimeMs}|${supplementStat.size}:${supplementStat.mtimeMs}`;
		if (revision === this.fileFingerprints.get(file.filePath)) {
			return { handled: true, changed: false };
		}
		let index = this.progressiveIndexes.get(resource);
		if (!index || index.filePath !== supplementPath || index.size !== supplementStat.size || index.mtimeMs !== supplementStat.mtimeMs) {
			index = await indexProgressiveTranscript(supplementPath);
			if (!index.complete) {
				this.schedulePoll(partialWriteRetryMs);
				return { handled: true, changed: false };
			}
			this.progressiveIndexes.set(resource, index);
		}
		const start = Math.max(0, index.turnOffsets.length - 40);
		const page = await loadProgressiveTranscriptPage(index, start, 40);
		this.fileFingerprints.set(file.filePath, revision);
		this.sessionStateCache.upsertPersisted(file.filePath, {
			resource,
			sessionId: index.sessionId || file.sessionId,
			title: index.title,
			status: page.turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
			revision,
			updatedAt: Math.max(file.mtimeMs, supplementStat.mtimeMs),
			turns: page.turns,
			turnCount: page.totalCount,
			historyStart: page.start,
			historyTruncated: page.hasEarlier,
			permissionLevel: 'default',
		});
		this.logProgressive('transcript-page-ready', file, this.getSessions().find(session => session.resource === resource), {
			supplementPresent: true,
			indexTurns: index.turnOffsets.length,
		});
		return { handled: true, changed: true };
	}

	private async loadProgressiveMutationSession(file: SessionFile): Promise<void> {
		this.progressiveMutationLoading.add(file.sessionId);
		this.logProgressive('mutation-load-start', file, this.getSessions().find(session => session.sessionId === file.sessionId));
		try {
			const resource = buildLocalSessionResource(file.sessionId).toString();
			let index = this.progressiveMutationIndexes.get(resource);
			if (!index || index.size !== file.size || index.mtimeMs !== file.mtimeMs) {
				index = await this.getProgressiveMutationIndex(file);
				this.progressiveMutationIndexes.set(resource, index);
			}
			const revision = `mutation-progressive:${file.size}:${file.mtimeMs}`;
			const start = Math.max(0, index.requests.length - 40);
			const page = await loadPagedMutationHistoryInWorker(index, start, 40, revision, this.progressiveAbortController.signal);
			this.fileFingerprints.set(file.filePath, revision);
			this.sessionStateCache.upsertPersisted(file.filePath, {
				resource,
				sessionId: index.sessionId || file.sessionId,
				title: index.title,
				status: page.turns.some(turn => turn.status === 'working') ? 'working' : 'idle',
				revision,
				updatedAt: file.mtimeMs,
				turns: page.turns,
				turnCount: page.totalCount,
				historyStart: page.start,
				historyTruncated: page.hasEarlier,
				permissionLevel: 'default',
			});
			this.logProgressive('mutation-page-ready', file, this.getSessions().find(session => session.resource === resource), {
				indexTurns: index.requests.length,
			});
			this.activeSession = this.getSessions().find(session => session.resource === resource) ?? this.activeSession;
			this.error = undefined;
			this.emit();
		} finally {
			this.progressiveMutationLoading.delete(file.sessionId);
			this.logProgressive('mutation-load-finish', file, this.getSessions().find(session => session.sessionId === file.sessionId));
		}
	}

	private markProgressiveMutationIndexing(file: SessionFile): void {
		const resource = buildLocalSessionResource(file.sessionId).toString();
		const current = this.getSessions().find(session => session.resource === resource);
		if (!current) {return;}
		this.sessionStateCache.upsertPersisted(file.filePath, {
			...current,
			status: 'loading',
			historyUnavailable: 'indexing',
		});
		this.logProgressive('mutation-indexing', file, this.getSessions().find(session => session.resource === resource));
		this.activeSession = this.getSessions().find(session => session.resource === resource) ?? current;
		this.emit();
	}

	private restoreProgressiveMutationPlaceholder(file: SessionFile): void {
		const resource = buildLocalSessionResource(file.sessionId).toString();
		const current = this.getSessions().find(session => session.resource === resource);
		if (!current) {return;}
		this.sessionStateCache.upsertPersisted(file.filePath, {
			...current,
			status: 'idle',
			historyUnavailable: 'oversized',
		});
		this.activeSession = this.getSessions().find(session => session.resource === resource) ?? current;
	}

	private async getProgressiveMutationIndex(file: SessionFile): Promise<PagedMutationHistoryIndex> {
		const existing = this.progressiveMutationIndexing.get(file.sessionId);
		if (existing) {return existing;}
		const indexing = this.loadOrBuildProgressiveMutationIndex(file);
		this.progressiveMutationIndexing.set(file.sessionId, indexing);
		try {
			return await indexing;
		} finally {
			this.progressiveMutationIndexing.delete(file.sessionId);
		}
	}

	private async loadOrBuildProgressiveMutationIndex(file: SessionFile): Promise<PagedMutationHistoryIndex> {
		const cachePath = path.join(this.progressiveIndexDirectory, `${file.sessionId}.json`);
		try {
			const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as SerializedPagedMutationHistoryIndex;
			if (cached.filePath === file.filePath && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
				return deserializePagedMutationHistoryIndex(cached);
			}
		} catch {
			// Missing or stale cache is rebuilt below.
		}
		const index = await indexPagedMutationHistoryInWorker(file.filePath, this.progressiveAbortController.signal);
		await fs.mkdir(this.progressiveIndexDirectory, { recursive: true });
		const temporaryPath = `${cachePath}.${process.pid}.tmp`;
		await fs.writeFile(temporaryPath, JSON.stringify(serializePagedMutationHistoryIndex(index)), 'utf8');
		await fs.rename(temporaryPath, cachePath).catch(async () => {
			await fs.rm(cachePath, { force: true });
			await fs.rename(temporaryPath, cachePath);
		});
		await pruneProgressiveIndexCache(this.progressiveIndexDirectory, cachePath);
		return index;
	}

	private async refreshLiveExport(force = false): Promise<void> {
		const targetSession = this.liveExportTargetResource
			? this.getSessions().find(session => session.resource === this.liveExportTargetResource)
			: this.activeSession;
		const now = Date.now();
		if (this.liveExportRunning
			|| !targetSession
			|| targetSession.revision.startsWith('placeholder:')
			|| targetSession.revision.startsWith('progressive:')
			|| targetSession.revision.startsWith('mutation-progressive:')
			|| !this.liveExportTracker.shouldSample(force, targetSession.status, now)) {
			return;
		}

		this.liveExportRunning = true;
		try {
			this.liveExportFileSystem.reset();
			await vscode.commands.executeCommand('workbench.action.chat.export', this.liveExportUri);
			const bytes = this.liveExportFileSystem.readFile();
			if (bytes.byteLength === 0) {
				return;
			}
			const serialized = Buffer.from(bytes).toString('utf8');
			const exported = JSON.parse(serialized) as unknown;
			if (!isRecord(exported)) {
				return;
			}

			const rawTranscript = normalizeTranscript(exported);
			if (rawTranscript.turns.length === 0) {
				return;
			}
			const matchedSession = findMatchingSession(this.getSessions(), rawTranscript);
			if (!matchedSession) {
				return;
			}
			const transcript = this.liveExportTracker.stabilize(matchedSession.resource, rawTranscript);
			this.completePendingTurn(matchedSession.resource, transcript.turns);
			const revision = `live:${serialized.length}:${hashString(serialized)}`;
			if (revision === matchedSession.revision) {
				return;
			}

			const liveSession: ActiveSessionState = {
				...matchedSession,
				status: transcript.status,
				revision,
				updatedAt: Date.now(),
				turns: transcript.turns,
				model: mergeSessionModelState(matchedSession.model, parseSessionModelState(exported)),
			};
			if (!this.sessionStateCache.applyLive(liveSession)) {
				return;
			}
			if (this.activeSession?.resource === liveSession.resource) {
				this.activeSession = this.getSessions().find(session => session.resource === liveSession.resource);
			}
			this.emit();
		} catch {
			// Internal export is opportunistic; persisted transcript watching remains the fallback.
		} finally {
			this.liveExportRunning = false;
		}
	}

	private async refreshLiveExportWhenIdle(): Promise<void> {
		const deadline = Date.now() + 2_000;
		while (this.liveExportRunning && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		await this.refreshLiveExport(true);
	}

	private async refreshModelCatalog(): Promise<boolean> {
		const now = Date.now();
		if (now < this.nextModelCatalogScanAt) {
			return false;
		}
		this.nextModelCatalogScanAt = now + modelCatalogRefreshIntervalMs;
		const snapshot = await readLatestModelCatalog(this.copilotModelDirectories);
		if (!snapshot || snapshot.revision === this.modelCatalogRevision) {
			return false;
		}
		this.modelCatalogRevision = snapshot.revision;
		this.models = snapshot.models;
		return true;
	}

	private async refreshNativeInputState(): Promise<void> {
		try {
			const resource = await vscode.commands.executeCommand<string | undefined>('_chat.voice.getCurrentSession');
			if (!resource) {return;}
			const session = this.getSessions().find(candidate => candidate.resource === resource);
			if (!session) {return;}

			if (this.nativeStateDatabaseNeedsReconnect) {
				this.nativeStateDatabase?.close();
				this.nativeStateDatabase = undefined;
				this.nativeStateDatabaseNeedsReconnect = false;
			}
			const database = this.nativeStateDatabase ??= new DatabaseSync(this.stateDatabasePath, { readOnly: true });
			try {
				const rows = database.prepare("SELECT key, value FROM ItemTable WHERE key IN ('chat.currentLanguageModel.panel', 'chat.modelConfiguration.panel')").all() as Array<{ key: string; value: string }>;
				this.nativeStateRetryAttempted = false;
				const snapshot = createNativeChatInputStateSnapshot(rows);
				const fingerprint = JSON.stringify([
					resource,
					this.modelCatalogRevision,
					snapshot.rawModelId,
					snapshot.rawConfiguration,
				]);
				if (fingerprint === this.lastNativeInputFingerprint) {return;}
				this.lastNativeInputFingerprint = fingerprint;
				const nativeState = snapshot.state;
				const modelId = nativeState.modelId;
				const model = this.models.find(candidate => candidate.identifier === modelId);
				if (!model) {return;}
				const next = withNativeModelState(session.model, model, nativeState.configuration);
				const selectedModelChanged = session.model?.selectedModelId !== next.selectedModelId;
				const configurationChanged = !configurationEquals(session.model?.configuration ?? {}, next.configuration);
				if ((selectedModelChanged || configurationChanged) && this.sessionStateCache.updateModel(resource, next)) {
					this.activeSession = this.getSessions().find(candidate => candidate.resource === resource);
					this.emit();
				}
			} catch (error) {
				this.nativeStateDatabase?.close();
				this.nativeStateDatabase = undefined;
				this.nativeStateDatabaseNeedsReconnect = false;
				this.lastNativeInputFingerprint = undefined;
				if (!this.nativeStateRetryAttempted) {
					this.nativeStateRetryAttempted = true;
					this.nativeInputStateSync.requestRefresh();
				}
				throw error;
			}
		} catch {
			// Native storage polling is opportunistic; persisted session watching remains the fallback.
		}
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

	private requirePendingTool(request: ToolDecisionRequest): void {
		if (!isActivePendingTool(this.getSessions(), request)) {
			throw new MonitorRequestError(409, 'The requested tool is no longer the active pending confirmation.');
		}
	}

	private requireIdleSession(resource: string): ActiveSessionState {
		const session = this.getSessions().find(candidate => candidate.resource === resource);
		if (!session) {throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');}
		if (session.status === 'working') {throw new MonitorRequestError(409, 'Wait for the active response to finish.');}
		return session;
	}

	private async requireSessionFile(resource: string): Promise<SessionFile> {
		const file = (await findSessionFiles(this.sessionDirectories, this.copilotTranscriptDirectories))
			.find(candidate => buildLocalSessionResource(candidate.sessionId).toString() === resource);
		if (!file) {throw new MonitorRequestError(404, 'The persisted Copilot session file is no longer available.');}
		return file;
	}

	private async appendSessionMutation(file: SessionFile, mutation: unknown): Promise<void> {
		const statBefore = await fs.stat(file.filePath);
		if (!isPersistedSessionWithinMemoryBudget(statBefore.size + file.supplementSize)) {
			throw new MonitorRequestError(413, 'This chat is too large for safe mobile changes. Open it in VS Code.');
		}
		const read = await readStableUtf8(file.filePath, statBefore);
		if (!read.stable) {throw new MonitorRequestError(409, 'VS Code is still persisting this chat. Try again.');}
		const content = read.content;
		const snapshot = parseMutationLogSnapshot(content);
		if (!snapshot.complete) {throw new MonitorRequestError(409, 'VS Code is still persisting this chat. Try again.');}
		const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
		await fs.appendFile(file.filePath, `${separator}${JSON.stringify(mutation)}\n`, 'utf8');
		this.fileFingerprints.delete(file.filePath);
		await this.refreshSession(file);
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

	private completePendingTurn(sessionResource: string, turns: readonly Transcript['turns'][number][]): void {
		const completedTurn = this.liveExportTracker.observe(sessionResource, turns);
		if (completedTurn) {
			this.updateOutboundMessage(completedTurn.outboundMessageId, { status: 'completed' });
		}
	}

	private emit(reason = 'update'): void {
		const state = this.getState();
		for (const session of state.sessions) {
			const signature = diagnosticSessionSignature(session);
			const previous = this.diagnosticSessionSignatures.get(session.resource);
			if (previous !== signature) {
				this.log(`[state:${reason}] ${diagnosticSessionLabel(session)} ${previous ?? '(new)'} -> ${signature}`);
				this.diagnosticSessionSignatures.set(session.resource, signature);
			}
		}
		const visibleResources = new Set(state.sessions.map(session => session.resource));
		for (const resource of this.diagnosticSessionSignatures.keys()) {
			if (!visibleResources.has(resource)) {
				this.log(`[state:${reason}] ${shortResourceId(resource)} removed`);
				this.diagnosticSessionSignatures.delete(resource);
			}
		}
		this.changeEmitter.fire(state);
	}

	private logProgressive(
		event: string,
		file: SessionFile,
		session?: ActiveSessionState,
		details: Record<string, unknown> = {},
	): void {
		this.log(`[history:${event}] session=${file.sessionId.slice(-8)} primary=${file.size} supplement=${file.supplementSize} ${session ? diagnosticSessionSignature(session) : 'state=missing'} ${JSON.stringify(details)}`);
	}

	private getSessions(): ActiveSessionState[] {
		return this.sessionStateCache.getVisibleSessions();
	}
}

export function resolveSessionDirectories(context: vscode.ExtensionContext): string[] {
	const globalStorageHome = path.dirname(context.globalStorageUri.fsPath);
	if (context.storageUri) {
		return [path.join(path.dirname(context.storageUri.fsPath), 'chatSessions')];
	}
	return [path.join(globalStorageHome, 'emptyWindowChatSessions')];
}

interface SessionFile {
	readonly filePath: string;
	readonly sessionId: string;
	readonly mtimeMs: number;
	readonly size: number;
	readonly supplementSize: number;
}

async function findSessionFiles(
	directories: readonly string[],
	supplementDirectories: readonly string[] = [],
): Promise<SessionFile[]> {
	const files: SessionFile[] = [];

	for (const directory of directories) {
		let entries: string[];
		try {
			entries = await fs.readdir(directory);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.endsWith('.jsonl')) {
				continue;
			}
			const filePath = path.join(directory, entry);
			try {
				const stat = await fs.stat(filePath);
				const supplementPath = await findExistingFile(supplementDirectories, entry);
				const supplementSize = supplementPath ? (await fs.stat(supplementPath)).size : 0;
				files.push({
					filePath,
					sessionId: entry.slice(0, -'.jsonl'.length),
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					supplementSize,
				});
			} catch {
				continue;
			}
		}
	}

	return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function summarize(value: string, length: number): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine;
}

function findProgressiveRequestIndex(
	requests: readonly Record<string, unknown>[],
	sourceText: string,
	sourceTimestamp: number | undefined,
): number {
	const expected = normalizeComparablePrompt(sourceText);
	let bestIndex = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < requests.length; index++) {
		const request = requests[index];
		const message = request.message && typeof request.message === 'object' && !Array.isArray(request.message)
			? request.message as Record<string, unknown>
			: undefined;
		if (normalizeComparablePrompt(typeof message?.text === 'string' ? message.text : '') !== expected) {continue;}
		const timestamp = typeof request.timestamp === 'number' ? request.timestamp : undefined;
		const distance = sourceTimestamp !== undefined && timestamp !== undefined
			? Math.abs(timestamp - sourceTimestamp)
			: index;
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = index;
		}
	}
	return bestIndex;
}

function normalizeComparablePrompt(value: string): string {
	return value.replace(/^User:\s*/i, '').replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${Math.round(bytes / (1024 * 1024))} MB`;
	}
	return `${Math.round(bytes / 1024)} KB`;
}

async function pruneProgressiveIndexCache(directory: string, retainedPath: string): Promise<void> {
	let entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
	try {
		entries = await Promise.all((await fs.readdir(directory))
			.filter(name => name.endsWith('.json'))
			.map(async name => {
				const filePath = path.join(directory, name);
				const stat = await fs.stat(filePath);
				return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
			}));
	} catch {
		return;
	}
	entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
	let retainedBytes = 0;
	let retainedFiles = 0;
	for (const entry of entries) {
		const keep = entry.path === retainedPath || (
			retainedFiles < maximumProgressiveIndexCacheFiles
			&& retainedBytes + entry.size <= maximumProgressiveIndexCacheBytes
		);
		if (keep) {
			retainedFiles++;
			retainedBytes += entry.size;
		} else {
			await fs.rm(entry.path, { force: true }).catch(() => undefined);
		}
	}
}

function decodeLocalSessionId(resource: vscode.Uri): string {
	if (resource.scheme !== 'vscode-chat-session' || resource.authority !== 'local' || !resource.path.startsWith('/')) {
		throw new MonitorRequestError(409, 'VS Code created an unsupported chat session resource.');
	}
	const sessionId = Buffer.from(resource.path.slice(1), 'base64url').toString('utf8');
	if (!sessionId) {throw new MonitorRequestError(409, 'VS Code created an invalid chat session resource.');}
	return sessionId;
}

export function resolveCopilotTranscriptDirectories(context: vscode.ExtensionContext): string[] {
	if (!context.storageUri) {
		return [];
	}
	const workspaceStorageDirectory = path.dirname(context.storageUri.fsPath);
	return [path.join(workspaceStorageDirectory, 'GitHub.copilot-chat', 'transcripts')];
}

export function resolveCopilotModelDirectories(context: vscode.ExtensionContext): string[] {
	if (!context.storageUri) {
		return [];
	}
	const workspaceStorageDirectory = path.dirname(context.storageUri.fsPath);
	return [path.join(workspaceStorageDirectory, 'GitHub.copilot-chat', 'debug-logs')];
}

async function findExistingFile(directories: readonly string[], fileName: string): Promise<string | undefined> {
	for (const directory of directories) {
		const filePath = path.join(directory, fileName);
		try {
			await fs.access(filePath);
			return filePath;
		} catch {
			continue;
		}
	}
	return undefined;
}

function createFingerprint(
	primary: { size: number; mtimeMs: number },
	supplement?: { size: number; mtimeMs: number },
): string {
	return `${primary.size}:${primary.mtimeMs}|${supplement?.size ?? 0}:${supplement?.mtimeMs ?? 0}`;
}

function diagnosticSessionSignature(session: ActiveSessionState): string {
	const revision = session.revision.split(':', 1)[0] || 'none';
	const rangeStart = session.historyStart ?? Math.max(0, (session.turnCount ?? session.turns.length) - session.turns.length);
	return [
		`revision=${revision}`,
		`status=${session.status}`,
		`history=${session.historyUnavailable ?? (session.historyTruncated ? 'paged' : 'loaded')}`,
		`range=${rangeStart}-${rangeStart + session.turns.length}`,
		`count=${session.turnCount ?? session.turns.length}`,
		`titleLength=${session.title.length}`,
	].join(' ');
}

function diagnosticSessionLabel(session: ActiveSessionState): string {
	return `session=${session.sessionId.slice(-8)} resource=${shortResourceId(session.resource)}`;
}

function shortResourceId(resource: string): string {
	return resource.length <= 20 ? resource : resource.slice(-20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectedModelMatches(state: Record<string, unknown>, requestedIdentifier: string): boolean {
	const inputState = isRecord(state.inputState) ? state.inputState : undefined;
	const selectedModel = isRecord(inputState?.selectedModel) ? inputState.selectedModel : undefined;
	const persistedIdentifier = selectedModel?.identifier;
	return typeof persistedIdentifier === 'string'
		&& (persistedIdentifier === requestedIdentifier
			|| persistedIdentifier.split('/').at(-1) === requestedIdentifier.split('/').at(-1));
}

function parsePermissionLevel(state: Record<string, unknown>): 'default' | 'autoApprove' | 'autopilot' {
	const inputState = isRecord(state.inputState) ? state.inputState : undefined;
	const level = inputState?.permissionLevel;
	return level === 'autoApprove' || level === 'autopilot' ? level : 'default';
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
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


