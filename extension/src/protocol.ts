import type { TranscriptTurn } from './transcript';

/** Advertised by `/api/health` on both the per-window bridge and the shared gateway. */
export const apiVersion = 4;
export const apiCapabilities = ['sessionRename', 'sessionCreate', 'sessionPermission', 'turnEdit', 'sessionSync', 'eventsV2', 'remoteAccess'] as const;

export interface ActiveSessionState {
	readonly resource: string;
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'idle' | 'working' | 'loading';
	readonly revision: string;
	readonly updatedAt?: number;
	readonly turns: readonly TranscriptTurn[];
	/** Exact request count; only known for the selected (tailed) session and for empty chats. */
	readonly turnCount?: number;
	/** Whether the chat has no requests, from VS Code's index; undefined while unknown. */
	readonly isEmpty?: boolean;
	readonly historyUnavailable?: 'archived' | 'oversized' | 'indexing';
	readonly historyTruncated?: boolean;
	readonly historyStart?: number;
	readonly model?: SessionModelState;
	readonly permissionLevel: ChatPermissionLevel;
}

export type ChatPermissionLevel = 'default' | 'autoApprove' | 'autopilot';

export type ModelConfigurationValue = string | number | boolean;

export interface ModelConfigurationOption {
	readonly value: ModelConfigurationValue;
	readonly label: string;
	readonly description?: string;
	readonly isDefault: boolean;
}

export interface ModelConfigurationField {
	readonly key: string;
	readonly title: string;
	readonly group?: string;
	readonly value?: ModelConfigurationValue;
	readonly defaultValue?: ModelConfigurationValue;
	readonly options: readonly ModelConfigurationOption[];
}

export interface ChatModelDescriptor {
	readonly identifier: string;
	readonly id: string;
	readonly name: string;
	readonly vendor: string;
	readonly providerName: string;
	readonly family: string;
	readonly version: string;
	readonly category?: string;
	readonly preview: boolean;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsVision: boolean;
	readonly supportsTools: boolean;
	readonly configurationFields: readonly ModelConfigurationField[];
}

export interface SessionModelState {
	readonly selectedModelId?: string;
	readonly selectedModelName?: string;
	readonly lastUsedModelId?: string;
	readonly configuration: Readonly<Record<string, ModelConfigurationValue>>;
	readonly configurationFields: readonly ModelConfigurationField[];
	readonly configurationWritable: boolean;
}

export interface OutboundMessageState {
	readonly id: string;
	readonly preview: string;
	readonly status: 'accepted' | 'completed' | 'failed';
	readonly createdAt: number;
	readonly error?: string;
}

export interface MonitorState {
	readonly version: 1;
	readonly windowId: string;
	readonly workspaceName: string;
	readonly workspaceFolders: readonly string[];
	readonly startedAt: number;
	readonly models: readonly ChatModelDescriptor[];
	readonly sessions: readonly ActiveSessionState[];
	readonly activeSession?: ActiveSessionState;
	readonly activeSessionResource?: string;
	readonly outboundMessages: readonly OutboundMessageState[];
	readonly error?: string;
}

export interface SendMessageRequest {
	readonly id: string;
	readonly sessionResource: string;
	readonly text: string;
}

export interface SendMessageResult {
	readonly id: string;
	readonly accepted: true;
}

export interface EditTurnRequest {
	readonly id: string;
	readonly sessionResource: string;
	readonly sessionRevision: string;
	readonly requestId: string;
	readonly text: string;
	readonly sourceText?: string;
	readonly sourceTimestamp?: number;
}

export type EditTurnResult = SendMessageResult;

export interface SelectSessionRequest {
	readonly sessionResource: string;
}

export interface SyncSessionRequest {
	readonly sessionResource: string;
}

export interface GatewaySyncSessionRequest extends SyncSessionRequest {
	readonly windowId: string;
}

export interface HistoryPageRequest {
	readonly sessionResource: string;
	readonly sessionRevision: string;
	readonly before: number;
	readonly limit?: number;
}

export interface HistoryPageResult {
	readonly turns: readonly TranscriptTurn[];
	readonly totalCount: number;
	readonly start: number;
	readonly end: number;
	readonly hasEarlier: boolean;
	readonly revision: string;
}

export interface GatewayWindowState extends MonitorState {
	readonly connected: boolean;
	readonly heartbeatAt: number;
}

export interface GatewayState {
	readonly version: 2;
	readonly gatewayStartedAt: number;
	readonly windows: readonly GatewayWindowState[];
	/** Every address this gateway answers on; streamed so connected clients learn new ones without re-pairing. */
	readonly endpoints?: readonly string[];
}

export interface GatewaySendMessageRequest extends SendMessageRequest {
	readonly windowId: string;
}

export interface GatewayHistoryPageRequest extends HistoryPageRequest {
	readonly windowId: string;
}

export interface GatewayEditTurnRequest extends EditTurnRequest {
	readonly windowId: string;
}

export interface GatewaySelectSessionRequest extends SelectSessionRequest {
	readonly windowId: string;
}

export type ToolDecision = 'allow' | 'skip';

export interface ToolDecisionRequest {
	readonly sessionResource: string;
	readonly requestId: string;
	readonly toolCallId: string;
	readonly decision: ToolDecision;
}

export interface GatewayToolDecisionRequest extends ToolDecisionRequest {
	readonly windowId: string;
}

export interface ModelSelectionRequest {
	readonly sessionResource: string;
	readonly modelId: string;
}

export interface GatewayModelSelectionRequest extends ModelSelectionRequest {
	readonly windowId: string;
}

export interface ModelConfigurationRequest {
	readonly sessionResource: string;
	readonly modelId: string;
	readonly key: string;
	readonly value: ModelConfigurationValue;
}

export interface GatewayModelConfigurationRequest extends ModelConfigurationRequest {
	readonly windowId: string;
}

export interface RenameSessionRequest {
	readonly sessionResource: string;
	readonly title: string;
}

export interface GatewayRenameSessionRequest extends RenameSessionRequest {
	readonly windowId: string;
}

export interface CreateSessionRequest {
	readonly id?: string;
	readonly sourceSessionResource?: string;
}

export interface CreateSessionResult {
	readonly sessionResource: string;
}

export interface GatewayCreateSessionRequest extends CreateSessionRequest {
	readonly windowId: string;
}

export interface PermissionLevelRequest {
	readonly sessionResource: string;
	readonly permissionLevel: ChatPermissionLevel;
}

export interface GatewayPermissionLevelRequest extends PermissionLevelRequest {
	readonly windowId: string;
}

export class MonitorRequestError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
		this.name = 'MonitorRequestError';
	}
}

export type RemoteTunnelStatus =
	| { readonly status: 'inactive' }
	| { readonly status: 'unavailable'; readonly reason: string }
	| { readonly status: 'signin-required' }
	| { readonly status: 'starting' }
	| { readonly status: 'active'; readonly url: string }
	| { readonly status: 'error'; readonly error: string };

export type RemoteTunnelProvider = 'devtunnel' | 'ngrok';

/** Machine-wide remote access state, owned by whichever window runs the shared gateway. */
export interface RemoteAccessStatus {
	readonly enabled: boolean;
	readonly provider: RemoteTunnelProvider;
	readonly manualUrl?: string;
	readonly tunnel: RemoteTunnelStatus;
	/** ngrok settings, minus the authtoken itself. */
	readonly ngrok: { readonly hasAuthtoken: boolean; readonly domain?: string };
}

export interface RemoteAccessUpdateRequest {
	readonly enabled?: boolean;
	readonly provider?: RemoteTunnelProvider;
	/** `null` clears the manual address. */
	readonly manualUrl?: string | null;
	/** `null` clears a field; omitted fields are kept. */
	readonly ngrok?: { readonly authtoken?: string | null; readonly domain?: string | null };
	/** Re-run the tunnel start (after the user signed in, or to retry an error). */
	readonly retry?: boolean;
}

export interface HistoryPageRequest {
	readonly sessionResource: string;
	readonly before: number;
	readonly limit?: number;
}

export interface HistoryPageResult {
	readonly turns: readonly TranscriptTurn[];
	readonly totalCount: number;
	readonly start: number;
	readonly end: number;
	readonly hasEarlier: boolean;
	readonly revision: string;
}

export interface GatewayHistoryPageRequest extends HistoryPageRequest {
	readonly windowId: string;
}