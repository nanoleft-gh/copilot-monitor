export type HostProfile = {
  id: string;
  name: string;
  endpoint: string;
  lastConnected: number;
};

export type GatewayHealth = {
  service: 'githubcopilot-monitor-gateway';
  hostId: string;
  registryId: string;
  apiVersion: number;
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
  turnCount?: number;
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