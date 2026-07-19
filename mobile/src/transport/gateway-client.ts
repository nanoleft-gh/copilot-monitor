import type {
  ChatModelDescriptor,
  GatewaySnapshot,
  HostProfile,
  ModelConfigurationField,
  ModelConfigurationOption,
  SessionModelState,
  SessionSummary,
  TranscriptActivity,
  TranscriptBlock,
  TranscriptTurn,
  WindowSnapshot,
} from './types';
import { pairGateway } from './pairing';
import { replaceHost } from './host-store';
import { discoverHostEndpoint } from './host-discovery';

const requestTimeoutMs = 10_000;

export async function fetchGatewaySnapshot(host: HostProfile): Promise<GatewaySnapshot> {
  let currentHost = host;
  let value: unknown;
  try {
    value = await requestJson(new URL('/api/state', currentHost.endpoint));
  } catch (error) {
    const recoveryEndpoint = preferredPortEndpoint(currentHost.endpoint);
    if (recoveryEndpoint === currentHost.endpoint) throw error;
    try {
      const recovered = await pairGateway(recoveryEndpoint);
      currentHost = { ...recovered, name: host.name };
      await replaceHost(host.id, currentHost);
      Object.assign(host, currentHost);
      value = await requestJson(new URL('/api/state', currentHost.endpoint));
    } catch {
      const discoveredEndpoint = await discoverHostEndpoint(host);
      if (!discoveredEndpoint) {
        throw new Error(`Cannot find ${host.name} on this local network. Confirm VS Code is running, then try again or scan its current QR code.`);
      }
      const discovered = await pairGateway(discoveredEndpoint);
      currentHost = { ...discovered, name: host.name };
      await replaceHost(host.id, currentHost);
      Object.assign(host, currentHost);
      value = await requestJson(new URL('/api/state', currentHost.endpoint));
    }
  }
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.windows)) {
    throw new Error('The computer returned an unsupported monitor state.');
  }
  return parseGatewaySnapshot(value);
}

export function parseGatewaySnapshot(value: unknown): GatewaySnapshot {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.windows)) {
    throw new Error('The computer returned an unsupported monitor state.');
  }
  return {
    version: 2,
    gatewayStartedAt: numberValue(value.gatewayStartedAt),
    windows: value.windows.flatMap(parseWindow),
  };
}

export async function selectSession(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
): Promise<void> {
  await requestJson(new URL('/api/sessions/select', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource }),
  });
}

export async function sendMessage(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  text: string,
): Promise<void> {
  await requestJson(new URL('/api/messages', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource, text, id: createRequestId() }),
  });
}

export async function editTurn(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  sessionRevision: string,
  requestId: string,
  text: string,
): Promise<void> {
  await requestJson(new URL('/api/turns/edit', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      windowId,
      sessionResource,
      sessionRevision,
      requestId,
      text,
      id: createRequestId('edit'),
    }),
  });
}

export async function decideTool(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  requestId: string,
  toolCallId: string,
  decision: 'allow' | 'skip',
): Promise<void> {
  await requestJson(new URL('/api/tools/decision', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource, requestId, toolCallId, decision }),
  });
}

export async function selectModel(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  modelId: string,
): Promise<void> {
  await requestJson(new URL('/api/models/select', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource, modelId }),
  });
}

export async function configureModel(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  modelId: string,
  key: string,
  value: string | number | boolean,
): Promise<void> {
  await requestJson(new URL('/api/models/configure', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource, modelId, key, value }),
  });
}

export async function setPermissionLevel(
  host: HostProfile,
  windowId: string,
  sessionResource: string,
  permissionLevel: 'default' | 'autoApprove' | 'autopilot',
): Promise<void> {
  await requestJson(new URL('/api/sessions/permission', host.endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId, sessionResource, permissionLevel }),
  });
}

async function requestJson(url: URL, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === 'string') detail = body.error;
      } catch {}
      throw new Error(detail);
    }
    return response.status === 204 ? undefined : response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The computer did not respond.');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function parseWindow(value: unknown): WindowSnapshot[] {
  if (!isRecord(value) || typeof value.windowId !== 'string' || !Array.isArray(value.sessions)) return [];
  return [{
    windowId: value.windowId,
    workspaceName: stringValue(value.workspaceName, 'VS Code'),
    workspaceFolders: Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter((folder): folder is string => typeof folder === 'string') : [],
    connected: value.connected !== false,
    sessions: value.sessions.flatMap(parseSession),
    activeSessionResource: typeof value.activeSessionResource === 'string' ? value.activeSessionResource : undefined,
    models: Array.isArray(value.models) ? value.models.flatMap(parseModel) : [],
  }];
}

function parseSession(value: unknown): SessionSummary[] {
  if (!isRecord(value) || typeof value.resource !== 'string' || typeof value.sessionId !== 'string') return [];
  const model = isRecord(value.model) ? value.model : undefined;
  return [{
    resource: value.resource,
    sessionId: value.sessionId,
    revision: stringValue(value.revision),
    title: stringValue(value.title, 'Copilot chat'),
    status: value.status === 'working' || value.status === 'loading' ? value.status : 'idle',
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    turnCount: typeof value.turnCount === 'number' ? value.turnCount : undefined,
    turns: Array.isArray(value.turns) ? value.turns.flatMap(parseTurn) : [],
    modelName: model && typeof model.selectedModelName === 'string' ? model.selectedModelName : undefined,
    model: parseModelState(model),
    permissionLevel: value.permissionLevel === 'autoApprove' || value.permissionLevel === 'autopilot'
      ? value.permissionLevel : 'default',
  }];
}

function parseTurn(value: unknown): TranscriptTurn[] {
  if (!isRecord(value) || typeof value.id !== 'string') return [];
  return [{
    id: value.id,
    editable: value.editable === true,
    timestamp: numberValue(value.timestamp),
    userText: stringValue(value.userText),
    assistantText: stringValue(value.assistantText),
    thinking: typeof value.thinking === 'string' ? value.thinking : undefined,
    thinkingTitle: typeof value.thinkingTitle === 'string' ? value.thinkingTitle : undefined,
    status: stringValue(value.status, 'completed'),
    activities: Array.isArray(value.activities) ? value.activities.flatMap(parseActivity) : [],
    blocks: Array.isArray(value.blocks) ? value.blocks.flatMap(parseBlock) : [],
  }];
}

function parseActivity(value: unknown): TranscriptActivity[] {
  if (!isRecord(value) || typeof value.id !== 'string') return [];
  return [{
    id: value.id,
    label: stringValue(value.label, 'Tool'),
    status: stringValue(value.status),
    command: typeof value.command === 'string' ? value.command : undefined,
    output: typeof value.output === 'string' ? value.output : undefined,
    canApprove: value.canApprove === true,
  }];
}

function parseBlock(value: unknown): TranscriptBlock[] {
  if (!isRecord(value)) return [];
  if (value.kind === 'text') {
    const text = stringValue(value.text);
    return text ? [{ kind: 'text', text }] : [];
  }
  if (value.kind === 'thinking') {
    const text = stringValue(value.text);
    return text ? [{ kind: 'thinking', text, title: stringValue(value.title) }] : [];
  }
  if (value.kind === 'activity') {
    const [activity] = parseActivity(value.activity);
    return activity ? [{ kind: 'activity', activity }] : [];
  }
  return [];
}

function parseModel(value: unknown): ChatModelDescriptor[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.identifier !== 'string') return [];
  return [{
    id: value.id,
    identifier: value.identifier,
    name: stringValue(value.name, value.id),
    vendor: stringValue(value.vendor),
    family: stringValue(value.family),
    category: typeof value.category === 'string' ? value.category : undefined,
    preview: value.preview === true,
    configurationFields: Array.isArray(value.configurationFields)
      ? value.configurationFields.flatMap(parseConfigurationField)
      : [],
  }];
}

function parseModelState(value: Record<string, unknown> | undefined): SessionModelState | undefined {
  if (!value) return undefined;
  const configuration: Record<string, string | number | boolean> = {};
  if (isRecord(value.configuration)) {
    for (const [key, entry] of Object.entries(value.configuration)) {
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        configuration[key] = entry;
      }
    }
  }
  return {
    selectedModelId: typeof value.selectedModelId === 'string' ? value.selectedModelId : undefined,
    selectedModelName: typeof value.selectedModelName === 'string' ? value.selectedModelName : undefined,
    configuration,
    configurationFields: Array.isArray(value.configurationFields) ? value.configurationFields.flatMap(parseConfigurationField) : [],
    configurationWritable: value.configurationWritable === true,
  };
}

function parseConfigurationField(value: unknown): ModelConfigurationField[] {
  if (!isRecord(value) || typeof value.key !== 'string') return [];
  return [{
    key: value.key,
    title: stringValue(value.title, value.key),
    value: isConfigurationValue(value.value) ? value.value : undefined,
    defaultValue: isConfigurationValue(value.defaultValue) ? value.defaultValue : undefined,
    options: Array.isArray(value.options) ? value.options.flatMap(parseConfigurationOption) : [],
  }];
}

function parseConfigurationOption(value: unknown): ModelConfigurationOption[] {
  if (!isRecord(value) || !isConfigurationValue(value.value)) return [];
  return [{
    value: value.value,
    label: stringValue(value.label, String(value.value)),
    isDefault: value.isDefault === true,
  }];
}

function isConfigurationValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function createRequestId(kind = 'message'): string {
  return `mobile-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function hasVisibleContent(session: SessionSummary): boolean {
  if (session.revision.startsWith('transient:')) return true;
  const count = session.turnCount ?? session.turns.length;
  if (count > 0) return true;
  return session.turns.some(turn => turn.userText.trim() || turn.assistantText.trim() || turn.blocks.length > 0);
}

function preferredPortEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.port = '43121';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function createSession(
  host: HostProfile,
  windowId: string,
  sourceSessionResource?: string,
  existingSessionResources: readonly string[] = [],
): Promise<{ sessionResource: string }> {
  try {
    return await requestJson(new URL('/api/sessions/new', host.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId, sourceSessionResource }),
    }) as { sessionResource: string };
  } catch (error) {
    const known = new Set(existingSessionResources);
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await fetchGatewaySnapshot(host).catch(() => undefined);
      const window = snapshot?.windows.find(candidate => candidate.windowId === windowId);
      const created = window?.sessions
        .filter(session => !known.has(session.resource))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
      if (created) {
        return { sessionResource: created.resource };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw error;
  }
}