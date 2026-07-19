import type { TranscriptTurn } from './transcript';

export interface ActiveSessionState {
	readonly resource: string;
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'idle' | 'working' | 'loading';
	readonly revision: string;
	readonly updatedAt?: number;
	readonly turns: readonly TranscriptTurn[];
	readonly turnCount?: number;
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
}

export type EditTurnResult = SendMessageResult;

export interface SelectSessionRequest {
	readonly sessionResource: string;
}

export interface GatewayWindowState extends MonitorState {
	readonly connected: boolean;
	readonly heartbeatAt: number;
}

export interface GatewayState {
	readonly version: 2;
	readonly gatewayStartedAt: number;
	readonly windows: readonly GatewayWindowState[];
}

export interface GatewaySendMessageRequest extends SendMessageRequest {
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