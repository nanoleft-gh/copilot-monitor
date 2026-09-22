export type HostProfile = {
  id: string;
  name: string;
  /** The address that worked most recently; tried first on every connection. */
  endpoint: string;
  /** Every address the computer advertised (LAN interfaces, tunnel URLs); probed when `endpoint` fails. */
  endpoints?: string[];
  lastConnected: number;
  /** Pairing secret, held in memory only; persisted separately in the device keystore. */
  secret?: string;
};

export type GatewayHealth = {
  service: 'githubcopilot-monitor-gateway';
  hostId: string;
  registryId: string;
  apiVersion: number;
  authRequired: boolean;
  authorized: boolean;
  endpoints: string[];
};

export type TranscriptActivity = {
  id: string;
  label: string;
  status: string;
  command?: string;
  output?: string;
  canApprove?: boolean;
};

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; title: string }
  | { kind: 'activity'; activity: TranscriptActivity };

export type TranscriptTurn = {
  id: string;
  editable: boolean;
  timestamp: number;
  userText: string;
  assistantText: string;
  thinking?: string;
  thinkingTitle?: string;
  status: string;
  activities: TranscriptActivity[];
  blocks: TranscriptBlock[];
};

export type ModelConfigurationOption = {
  value: string | number | boolean;
  label: string;
  isDefault: boolean;
};

export type ModelConfigurationField = {
  key: string;
  title: string;
  value?: string | number | boolean;
  defaultValue?: string | number | boolean;
  options: ModelConfigurationOption[];
};

export type ChatModelDescriptor = {
  id: string;
  identifier: string;
  name: string;
  vendor: string;
  family: string;
  category?: string;
  preview: boolean;
  configurationFields: ModelConfigurationField[];
};

export type SessionModelState = {
  selectedModelId?: string;
  selectedModelName?: string;
  configuration: Record<string, string | number | boolean>;
  configurationFields: ModelConfigurationField[];
  configurationWritable: boolean;
};

export type SessionSummary = {
  resource: string;
  sessionId: string;
  revision: string;
  title: string;
  status: 'idle' | 'working' | 'loading';
  updatedAt?: number;
  /** Exact request count; only known for the chat the computer is currently tailing and for empty chats. */
  turnCount?: number;
  /** Whether the chat has no requests, from VS Code's index; undefined while unknown. */
  isEmpty?: boolean;
  historyUnavailable?: 'archived' | 'oversized' | 'indexing';
  historyTruncated?: boolean;
  historyStart?: number;
  turns: TranscriptTurn[];
  modelName?: string;
  model?: SessionModelState;
  permissionLevel: 'default' | 'autoApprove' | 'autopilot';
};

export type WindowSnapshot = {
  windowId: string;
  workspaceName: string;
  workspaceFolders: string[];
  connected: boolean;
  sessions: SessionSummary[];
  activeSessionResource?: string;
  models: ChatModelDescriptor[];
};

export type GatewaySnapshot = {
  version: 2;
  gatewayStartedAt: number;
  windows: WindowSnapshot[];
};

export type HistoryPage = {
  turns: TranscriptTurn[];
  totalCount: number;
  start: number;
  end: number;
  hasEarlier: boolean;
  revision: string;
};