import { FSWatcher, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { buildLocalSessionResource, createNewChat, decideTool, focusChatSession, inspectChatSession, releaseChatSession, selectChatModel, sendPrompt } from './chatBridge';
import { LiveExportFileSystem, liveExportScheme } from './liveExportFileSystem';
import { LiveExportTracker } from './liveExportTracker';
import { mergeSessionModelState, parseSessionModelState, readLatestModelCatalog, withNativeModelState, withSelectedModel } from './modelCatalog';
import { createSessionModelConfigurationMutation, createSessionValueMutation, updateProfileModelConfiguration } from './modelConfigurationUpdate';
import { parseNativeChatInputState } from './nativeChatInputState';
import { findMatchingSession } from './sessionMatcher';
import { SessionStateCache } from './sessionStateCache';
import { isActivePendingTool } from './toolDecision';
import {
	ActiveSessionState,
	ChatModelDescriptor,
	CreateSessionRequest,
	CreateSessionResult,
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
const liveExportIntervalMs = 500;
const fileEventDebounceMs = 20;
const partialWriteRetryMs = 50;
const maximumMessageLength = 32_000;
const maximumOutboundHistory = 20;
const modelCatalogRefreshIntervalMs = 10_000;
const nativeInputStatePollIntervalMs = 1_000;

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
	private readonly nativeInputStateTimer: NodeJS.Timeout;
	private readonly liveExportUri: vscode.Uri;
	private readonly liveExportFileSystem = new LiveExportFileSystem();
	private models: readonly ChatModelDescriptor[] = [];
	private modelCatalogRevision: string | undefined;
	private nextModelCatalogScanAt = 0;

	readonly onDidChange = this.changeEmitter.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly windowId: string,
	) {
		this.disposables.push(this.changeEmitter);
		this.sessionDirectories = resolveSessionDirectories(context);
		this.copilotTranscriptDirectories = resolveCopilotTranscriptDirectories(context);
		this.copilotModelDirectories = resolveCopilotModelDirectories(context);
		this.languageModelsConfigurationPath = path.join(
			path.dirname(path.dirname(context.globalStorageUri.fsPath)),
			'chatLanguageModels.json',
		);
		this.stateDatabasePath = path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
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
		this.nativeInputStateTimer = setInterval(() => void this.refreshNativeInputState(), nativeInputStatePollIntervalMs);
		this.nativeInputStateTimer.unref();
		this.schedulePoll();
	}

	getState(): MonitorState {
		const sessions = this.getSessions();
		const activeResource = this.activeSession?.resource;
		const serializedSessions = sessions.map(session => activeResource === session.resource
			? { ...session, turnCount: session.turns.length }
			: { ...session, turnCount: session.turns.length, turns: [] });
		return {
			version: 1,
			windowId: this.windowId,
			workspaceName: vscode.workspace.name ?? 'Untitled workspace',
			workspaceFolders: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
			startedAt: this.startedAt,
			models: this.models,
			sessions: serializedSessions,
			activeSession: this.activeSession ? { ...this.activeSession, turnCount: this.activeSession.turns.length, turns: [] } : undefined,
			activeSessionResource: activeResource,
			outboundMessages: [...this.outboundMessages.values()],
			error: this.error,
		};
	}

	setEventClientCount(count: number): void {
		if (count > 0) {
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

	async selectSession(sessionResource: string): Promise<void> {
		const targetSession = this.getSessions().find(session => session.resource === sessionResource);
		if (!targetSession) {
			throw new MonitorRequestError(404, 'The selected Copilot session is no longer available.');
		}
		await focusChatSession(vscode.Uri.parse(targetSession.resource));
		this.activeSession = targetSession;
		this.liveExportTargetResource = targetSession.resource;
		this.emit();
		void this.refreshLiveExport(true);
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
		await this.refreshLiveExportWhenIdle();
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
		const fields = targetSession.model.configurationFields.length > 0
			? targetSession.model.configurationFields
			: model?.configurationFields ?? [];
		const field = fields.find(candidate => candidate.key === request.key);
		const option = field?.options.find(candidate => candidate.value === request.value);
		if (!model || !field || !option) {
			throw new MonitorRequestError(400, 'The requested model configuration value is unavailable.');
		}

		const sessionFile = (await findSessionFiles(this.sessionDirectories))
			.find(file => buildLocalSessionResource(file.sessionId).toString() === request.sessionResource);
		if (!sessionFile) {
			throw new MonitorRequestError(404, 'The persisted Copilot session file is no longer available.');
		}

		const resource = vscode.Uri.parse(request.sessionResource);
		this.liveExportTargetResource = request.sessionResource;
		await releaseChatSession(resource);
		try {
			const content = await fs.readFile(sessionFile.filePath, 'utf8');
			const snapshot = parseMutationLogSnapshot(content);
			if (!snapshot.complete) {
				throw new MonitorRequestError(409, 'VS Code is still persisting this chat. Try the configuration change again.');
			}
			const mutation = createSessionModelConfigurationMutation(
				snapshot.state,
				request.modelId,
				request.key,
				request.value,
			);
			const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
			await fs.appendFile(sessionFile.filePath, `${separator}${JSON.stringify(mutation)}\n`, 'utf8');
			await this.updateProfileModelConfiguration(model, field.key, request.value, field.defaultValue);
			this.fileFingerprints.delete(sessionFile.filePath);
			await this.refreshSession(sessionFile);
		} finally {
			await focusChatSession(resource);
		}
		const nativeState = parseSessionModelState(await inspectChatSession(resource));
		if (nativeState?.selectedModelId !== request.modelId || nativeState.configuration[request.key] !== request.value) {
			throw new MonitorRequestError(409, 'VS Code reopened the chat without applying the requested configuration.');
		}

		this.activeSession = this.getSessions().find(session => session.resource === request.sessionResource);
		this.emit();
		await this.refreshLiveExportWhenIdle();
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
		const native = await inspectChatSession(resource);
		if (native.customTitle !== title) {
			throw new MonitorRequestError(409, 'VS Code reopened the chat without applying the requested title.');
		}
		this.activeSession = this.getSessions().find(session => session.resource === target.resource);
		this.emit();
	}

	async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
		const source = request.sourceSessionResource
			? this.getSessions().find(session => session.resource === request.sourceSessionResource)
			: undefined;
		if (request.sourceSessionResource && !source) {
			throw new MonitorRequestError(404, 'The source Copilot session is no longer available.');
		}
		const resource = await createNewChat(source ? vscode.Uri.parse(source.resource) : undefined);
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
		const sessionFile = await this.requireSessionFile(request.sessionResource);
		const resource = vscode.Uri.parse(request.sessionResource);
		await releaseChatSession(resource);
		try {
			await this.appendSessionMutation(
				sessionFile,
				createSessionValueMutation(['inputState', 'permissionLevel'], request.permissionLevel),
			);
		} finally {
			await focusChatSession(resource);
		}
		const native = await inspectChatSession(resource);
		if (parsePermissionLevel(native) !== request.permissionLevel) {
			throw new MonitorRequestError(409, 'VS Code reopened the chat without applying the requested approval mode.');
		}
		this.activeSession = this.getSessions().find(session => session.resource === target.resource);
		this.emit();
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
		clearInterval(this.fallbackPollTimer);
		clearInterval(this.liveExportTimer);
		clearInterval(this.nativeInputStateTimer);
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

	private async poll(): Promise<void> {
		this.ensureDirectoryWatchers();
		let changed = await this.refreshModelCatalog();
		const files = await findSessionFiles(this.sessionDirectories);
		const currentPaths = new Set(files.map(file => file.filePath));
		changed = this.sessionStateCache.removeMissingPaths(currentPaths) || changed;
		for (const filePath of this.fileFingerprints.keys()) {
			if (!currentPaths.has(filePath)) {
				this.fileFingerprints.delete(filePath);
			}
		}

		for (const file of files) {
			changed = await this.refreshSession(file) || changed;
		}

		const sessions = this.getSessions();
		const active = sessions.find(session => session.resource === this.activeSession?.resource) ?? sessions[0];
		if (this.activeSession !== active) {
			this.activeSession = active;
			changed = true;
		}
		if (changed) {
			this.error = undefined;
			this.emit();
		}
	}

	private async refreshSession(file: SessionFile): Promise<boolean> {
		try {
			const statBefore = await fs.stat(file.filePath);
			const supplementPath = await findExistingFile(
				this.copilotTranscriptDirectories,
				`${file.sessionId}.jsonl`,
			);
			const supplementStatBefore = supplementPath ? await fs.stat(supplementPath) : undefined;
			const fingerprint = createFingerprint(statBefore, supplementStatBefore);
			if (fingerprint === this.fileFingerprints.get(file.filePath)) {
				return false;
			}

			const content = await fs.readFile(file.filePath, 'utf8');
			const statAfter = await fs.stat(file.filePath);
			const stableRead = statBefore.size === statAfter.size
				&& statBefore.mtimeMs === statAfter.mtimeMs
				&& Buffer.byteLength(content) === statAfter.size;
			const snapshot = parseMutationLogSnapshot(content);
			let transcript = normalizeTranscript(snapshot.state);
			let supplementComplete = true;
			let supplementStable = true;
			let supplementStatAfter = supplementStatBefore;

			if (supplementPath && supplementStatBefore) {
				const supplementContent = await fs.readFile(supplementPath, 'utf8');
				supplementStatAfter = await fs.stat(supplementPath);
				supplementStable = supplementStatBefore.size === supplementStatAfter.size
					&& supplementStatBefore.mtimeMs === supplementStatAfter.mtimeMs
					&& Buffer.byteLength(supplementContent) === supplementStatAfter.size;
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

	private async refreshLiveExport(force = false): Promise<void> {
		const targetSession = this.liveExportTargetResource
			? this.getSessions().find(session => session.resource === this.liveExportTargetResource)
			: this.activeSession;
		if (this.liveExportRunning
			|| !targetSession
			|| !this.liveExportTracker.shouldSample(force, targetSession.status, Date.now())) {
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
			const exported = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
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
			const serialized = JSON.stringify(exported);
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
			const commands = await vscode.commands.getCommands(true);
			if (!commands.includes('_chat.voice.getCurrentSession')) {return;}
			const resource = await vscode.commands.executeCommand<string | undefined>('_chat.voice.getCurrentSession');
			if (!resource) {return;}
			const session = this.getSessions().find(candidate => candidate.resource === resource);
			if (!session) {return;}

			const database = this.nativeStateDatabase ??= new DatabaseSync(this.stateDatabasePath, { readOnly: true });
			try {
				const rows = database.prepare("SELECT key, value FROM ItemTable WHERE key IN ('chat.currentLanguageModel.panel', 'chat.modelConfiguration.panel')").all() as Array<{ key: string; value: string }>;
				const nativeState = parseNativeChatInputState(rows);
				const modelId = nativeState.modelId;
				const model = this.models.find(candidate => candidate.identifier === modelId);
				if (!model) {return;}
				const next = withNativeModelState(session.model, model, nativeState.configuration);
				const selectedModelChanged = session.model?.selectedModelId !== next.selectedModelId;
				const configurationChanged = JSON.stringify(session.model?.configuration ?? {}) !== JSON.stringify(next.configuration);
				if ((selectedModelChanged || configurationChanged) && this.sessionStateCache.updateModel(resource, next)) {
					this.activeSession = this.getSessions().find(candidate => candidate.resource === resource);
					this.emit();
				}
			} catch (error) {
				this.nativeStateDatabase?.close();
				this.nativeStateDatabase = undefined;
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
		const file = (await findSessionFiles(this.sessionDirectories))
			.find(candidate => buildLocalSessionResource(candidate.sessionId).toString() === resource);
		if (!file) {throw new MonitorRequestError(404, 'The persisted Copilot session file is no longer available.');}
		return file;
	}

	private async appendSessionMutation(file: SessionFile, mutation: unknown): Promise<void> {
		const content = await fs.readFile(file.filePath, 'utf8');
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

	private emit(): void {
		this.changeEmitter.fire(this.getState());
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
}

async function findSessionFiles(directories: readonly string[]): Promise<SessionFile[]> {
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
				files.push({
					filePath,
					sessionId: entry.slice(0, -'.jsonl'.length),
					mtimeMs: stat.mtimeMs,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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


