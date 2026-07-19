import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, Pencil, Send, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PickerField, type PickerOption } from '@/components/ui/picker-field';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';
import { configureModel, decideTool, editTurn, fetchGatewaySnapshot, selectModel, selectSession, sendMessage, setPermissionLevel } from '@/transport/gateway-client';
import { getHost } from '@/transport/host-store';
import { subscribeToGateway } from '@/transport/gateway-stream';
import type { ChatModelDescriptor, HostProfile, ModelConfigurationField, SessionSummary, TranscriptActivity, WindowSnapshot } from '@/transport/types';

const permissionOptions: PickerOption[] = [
  { value: 'default', label: 'Default Approvals', hint: 'Ask before running tools' },
  { value: 'autoApprove', label: 'Bypass Approvals', hint: 'Run tools without asking' },
  { value: 'autopilot', label: 'Autopilot', hint: 'Fully autonomous' },
];

type OptimisticValue<T> = { sequence: number; value: T };
type PermissionLevel = 'default' | 'autoApprove' | 'autopilot';

function mergeConfigurationFields(
  catalogFields: readonly ModelConfigurationField[],
  sessionFields: readonly ModelConfigurationField[],
): ModelConfigurationField[] {
  const fields = new Map(catalogFields.map(field => [field.key, field]));
  for (const field of sessionFields) {
    const catalogField = fields.get(field.key);
    fields.set(field.key, {
      ...catalogField,
      ...field,
      options: field.options.length > 0 ? field.options : catalogField?.options ?? [],
    });
  }
  return [...fields.values()];
}

function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, event => setHeight(event.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return height;
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ hostId: string; windowId: string; sessionResource: string }>();
  const [host, setHost] = useState<HostProfile>();
  const [window, setWindow] = useState<WindowSnapshot>();
  const [session, setSession] = useState<SessionSummary>();
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState<{ requestId: string; text: string }>();
  const [editText, setEditText] = useState('');
  const [error, setError] = useState<string>();
  const [optimisticModel, setOptimisticModel] = useState<OptimisticValue<string>>();
  const [optimisticConfigurations, setOptimisticConfigurations] = useState<Record<string, OptimisticValue<string | number | boolean>>>({});
  const [optimisticPermission, setOptimisticPermission] = useState<OptimisticValue<PermissionLevel>>();
  const scrollRef = useRef<ScrollView>(null);
  const loadedRef = useRef(false);
  const modelSequence = useRef(0);
  const configurationSequence = useRef(0);
  const permissionSequence = useRef(0);
  const optimisticModelRef = useRef<OptimisticValue<string> | undefined>(undefined);
  const optimisticConfigurationsRef = useRef<Record<string, OptimisticValue<string | number | boolean>>>({});
  const optimisticPermissionRef = useRef<OptimisticValue<PermissionLevel> | undefined>(undefined);
  const keyboardHeight = useKeyboardHeight();

  const applySnapshot = useCallback((windows: WindowSnapshot[]) => {
    const nextWindow = windows.find(candidate => candidate.windowId === params.windowId);
    const nextSession = nextWindow?.sessions.find(candidate => candidate.resource === params.sessionResource);
    setWindow(nextWindow);
    if (nextSession) {
      const pendingModel = optimisticModelRef.current;
      const authoritativeModelId = nextSession.model?.selectedModelId;
      if (pendingModel && authoritativeModelId) {
        const intended = nextWindow?.models.find(model => model.identifier === pendingModel.value || model.id === pendingModel.value);
        const authoritative = nextWindow?.models.find(model => model.identifier === authoritativeModelId || model.id === authoritativeModelId);
        if (authoritativeModelId === pendingModel.value || (intended && authoritative?.identifier === intended.identifier)) {
          optimisticModelRef.current = undefined;
          setOptimisticModel(current => current?.sequence === pendingModel.sequence ? undefined : current);
        }
      }

      const pendingConfigurations = optimisticConfigurationsRef.current;
      if (Object.keys(pendingConfigurations).length > 0) {
        const nextPending = { ...pendingConfigurations };
        let changed = false;
        for (const [key, optimistic] of Object.entries(pendingConfigurations)) {
          const authoritative = nextSession.model?.configuration[key]
            ?? nextSession.model?.configurationFields.find(field => field.key === key)?.value;
          if (Object.is(authoritative, optimistic.value)) {
            delete nextPending[key];
            changed = true;
          }
        }
        if (changed) {
          optimisticConfigurationsRef.current = nextPending;
          setOptimisticConfigurations(nextPending);
        }
      }

      const pendingPermission = optimisticPermissionRef.current;
      if (pendingPermission && nextSession.permissionLevel === pendingPermission.value) {
        optimisticPermissionRef.current = undefined;
        setOptimisticPermission(current => current?.sequence === pendingPermission.sequence ? undefined : current);
      }
      setSession(nextSession);
      setError(undefined);
    } else if (loadedRef.current) {
      setError('This conversation is no longer available.');
    }
    loadedRef.current = true;
    setLoading(false);
  }, [params.sessionResource, params.windowId]);

  useEffect(() => {
    if (!params.hostId || !params.windowId || !params.sessionResource) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const nextHost = await getHost(params.hostId);
        if (!nextHost) throw new Error('This paired computer is no longer available.');
        if (!active) return;
        setHost(nextHost);
        await selectSession(nextHost, params.windowId, params.sessionResource).catch(() => undefined);
        const snapshot = await fetchGatewaySnapshot(nextHost);
        if (!active) return;
        applySnapshot(snapshot.windows);
        unsubscribe = subscribeToGateway(nextHost, {
          onSnapshot: value => { if (active) applySnapshot(value.windows); },
        });
      } catch (initError) {
        if (active) {
          setError(initError instanceof Error ? initError.message : String(initError));
          setLoading(false);
        }
      }
    })();
    return () => { active = false; unsubscribe?.(); };
  }, [applySnapshot, params.hostId, params.sessionResource, params.windowId]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!host || !text || sending || !params.windowId || !params.sessionResource) return;
    setSending(true);
    setError(undefined);
    try {
      await sendMessage(host, params.windowId, params.sessionResource, text);
      setDraft('');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  }, [draft, host, params.sessionResource, params.windowId, sending]);

  const decide = useCallback(async (requestId: string, toolCallId: string, decision: 'allow' | 'skip') => {
    if (!host || deciding || !params.windowId || !params.sessionResource) return;
    setDeciding(true);
    setError(undefined);
    try {
      await decideTool(host, params.windowId, params.sessionResource, requestId, toolCallId, decision);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : String(decisionError));
    } finally {
      setDeciding(false);
    }
  }, [deciding, host, params.sessionResource, params.windowId]);

  const openEditor = useCallback((requestId: string, text: string) => {
    setEditTarget({ requestId, text });
    setEditText(text);
    setError(undefined);
  }, []);

  const closeEditor = useCallback(() => {
    if (editing) return;
    setEditTarget(undefined);
    setEditText('');
  }, [editing]);

  const submitEdit = useCallback(async () => {
    const text = editText.trim();
    if (!host || !session || !editTarget || !text || editing || !params.windowId || !params.sessionResource) return;
    setEditing(true);
    setError(undefined);
    try {
      await editTurn(host, params.windowId, params.sessionResource, session.revision, editTarget.requestId, text);
      setEditTarget(undefined);
      setEditText('');
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setEditing(false);
    }
  }, [editTarget, editText, editing, host, params.sessionResource, params.windowId, session]);

  const working = session?.status === 'working';

  const changeModel = useCallback(async (modelId: string) => {
    if (!host || !params.windowId || !params.sessionResource) return;
    const sequence = ++modelSequence.current;
    const optimistic = { sequence, value: modelId };
    optimisticModelRef.current = optimistic;
    setOptimisticModel(optimistic);
    setError(undefined);
    try {
      await selectModel(host, params.windowId, params.sessionResource, modelId);
      if (optimisticModelRef.current?.sequence === sequence) {
        optimisticModelRef.current = undefined;
        setOptimisticModel(current => current?.sequence === sequence ? undefined : current);
      }
    } catch (modelError) {
      if (modelSequence.current === sequence) {
        if (optimisticModelRef.current?.sequence === sequence) optimisticModelRef.current = undefined;
        setOptimisticModel(current => current?.sequence === sequence ? undefined : current);
        setError(modelError instanceof Error ? modelError.message : String(modelError));
      }
    }
  }, [host, params.sessionResource, params.windowId]);

  const changeConfiguration = useCallback(async (modelId: string, key: string, value: string | number | boolean) => {
    if (!host || !params.windowId || !params.sessionResource) return;
    const sequence = ++configurationSequence.current;
    const nextOptimistic = { ...optimisticConfigurationsRef.current, [key]: { sequence, value } };
    optimisticConfigurationsRef.current = nextOptimistic;
    setOptimisticConfigurations(nextOptimistic);
    setError(undefined);
    try {
      await configureModel(host, params.windowId, params.sessionResource, modelId, key, value);
      if (optimisticConfigurationsRef.current[key]?.sequence === sequence) {
        const nextOptimistic = { ...optimisticConfigurationsRef.current };
        delete nextOptimistic[key];
        optimisticConfigurationsRef.current = nextOptimistic;
        setOptimisticConfigurations(nextOptimistic);
      }
    } catch (configError) {
      if (optimisticConfigurationsRef.current[key]?.sequence === sequence) {
        const nextOptimistic = { ...optimisticConfigurationsRef.current };
        delete nextOptimistic[key];
        optimisticConfigurationsRef.current = nextOptimistic;
        setOptimisticConfigurations(current => {
          if (current[key]?.sequence !== sequence) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        setError(configError instanceof Error ? configError.message : String(configError));
      }
    }
  }, [host, params.sessionResource, params.windowId]);

  const changePermission = useCallback(async (permissionLevel: string) => {
    if (!host || !params.windowId || !params.sessionResource) return;
    const nextPermission = permissionLevel as PermissionLevel;
    const sequence = ++permissionSequence.current;
    const optimistic = { sequence, value: nextPermission };
    optimisticPermissionRef.current = optimistic;
    setOptimisticPermission(optimistic);
    setError(undefined);
    try {
      await setPermissionLevel(host, params.windowId, params.sessionResource, nextPermission);
      if (optimisticPermissionRef.current?.sequence === sequence) {
        optimisticPermissionRef.current = undefined;
        setOptimisticPermission(current => current?.sequence === sequence ? undefined : current);
      }
    } catch (permissionError) {
      if (permissionSequence.current === sequence) {
        if (optimisticPermissionRef.current?.sequence === sequence) optimisticPermissionRef.current = undefined;
        setOptimisticPermission(current => current?.sequence === sequence ? undefined : current);
        setError(permissionError instanceof Error ? permissionError.message : String(permissionError));
      }
    }
  }, [host, params.sessionResource, params.windowId]);

  const models = window?.models ?? [];
  const authoritativeModelId = session?.model?.selectedModelId;
  const selectedModelId = optimisticModel?.value ?? authoritativeModelId;
  const selectedModel = models.find(model => model.identifier === selectedModelId || model.id === selectedModelId);
  const modelOptions: PickerOption[] = models.map((model: ChatModelDescriptor) => ({
    value: model.identifier,
    label: model.name,
    hint: model.preview ? 'Preview' : model.family,
  }));
  const sessionFields = session?.model?.configurationFields ?? [];
  const catalogFields = selectedModel?.configurationFields ?? [];
  const configFields = mergeConfigurationFields(catalogFields, sessionFields).map(field => ({
    ...field,
    value: optimisticConfigurations[field.key]?.value
      ?? session?.model?.configuration[field.key]
      ?? sessionFields.find(candidate => candidate.key === field.key)?.value
      ?? field.defaultValue,
  }));
  const displayedPermission = optimisticPermission?.value ?? session?.permissionLevel ?? 'default';

  const lastTurn = session?.turns.at(-1);
  const pendingToolId = lastTurn?.activities.find(activity => activity.canApprove)?.id;
  const headerMeta = working
    ? 'Copilot is working'
    : selectedModel?.name ?? session?.modelName ?? 'GitHub Copilot';

  const renderActivity = (turnId: string, activity: TranscriptActivity, key: string) => {
    const canApprove = activity.id === pendingToolId;
    return (
      <View key={key} style={styles.activity}>
        <Text style={styles.activityLabel}>{activity.label}</Text>
        <Text style={styles.activityStatus}>{activity.status}</Text>
        {!!activity.command && <Text selectable style={styles.code}>{activity.command}</Text>}
        {!!activity.output && <Text selectable style={styles.code}>{activity.output}</Text>}
        {canApprove && (
          <View style={styles.approvalRow}>
            <Pressable
              accessibilityLabel="Allow tool"
              disabled={deciding}
              onPress={() => void decide(turnId, activity.id, 'allow')}
              style={[styles.approveButton, deciding && styles.disabled]}
            >
              <Check color={colors.onBright} size={16} />
              <Text style={styles.approveText}>Allow</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Skip tool"
              disabled={deciding}
              onPress={() => void decide(turnId, activity.id, 'skip')}
              style={[styles.skipButton, deciding && styles.disabled]}
            >
              <X color={colors.textPrimary} size={16} />
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconButton}><ChevronLeft color={colors.textPrimary} size={24} /></Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.headerTitle}>{session?.title ?? 'Conversation'}</Text>
          <Text style={styles.headerMeta}>{headerMeta}</Text>
        </View>
        {working ? <ActivityIndicator color={colors.accentBlue} size="small" style={styles.iconButton} /> : <View style={styles.iconButton} />}
      </View>
      <View style={[styles.body, { paddingBottom: keyboardHeight }]}>
        {loading && !session ? <View style={styles.center}><ActivityIndicator color={colors.accentBlue} /></View> : (
          <ScrollView
            contentContainerStyle={styles.transcript}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            ref={scrollRef}
          >
            {session?.turns.length === 0 && <Text style={styles.empty}>No persisted messages are available yet.</Text>}
            {session?.turns.map((turn, turnIndex) => (
              <View key={`${turn.id}:${turnIndex}`} style={styles.turn}>
                {!!turn.userText && (
                  <View style={styles.userRow}>
                    {turn.editable && !working && (
                      <Pressable accessibilityLabel="Edit and replace from this request" onPress={() => openEditor(turn.id, turn.userText)} style={styles.editButton}>
                        <Pencil color={colors.textMuted} size={15} />
                      </Pressable>
                    )}
                    <View style={styles.userBubble}><Text selectable style={styles.userText}>{turn.userText}</Text></View>
                  </View>
                )}
                {turn.blocks.length > 0
                  ? turn.blocks.map((block, blockIndex) => {
                      const key = `${turn.id}:block:${blockIndex}`;
                      if (block.kind === 'thinking') {
                        return (
                          <View key={key} style={styles.thinking}>
                            <Text style={styles.thinkingTitle}>{block.title || 'Thinking'}</Text>
                            <Text selectable style={styles.thinkingText}>{block.text}</Text>
                          </View>
                        );
                      }
                      if (block.kind === 'text') {
                        return (
                          <View key={key} style={styles.assistant}>
                            <Text selectable style={styles.assistantText}>{block.text}</Text>
                          </View>
                        );
                      }
                      return renderActivity(turn.id, block.activity, key);
                    })
                  : (
                    <>
                      {!!turn.thinking && <View style={styles.thinking}><Text style={styles.thinkingTitle}>{turn.thinkingTitle || 'Thinking'}</Text><Text selectable style={styles.thinkingText}>{turn.thinking}</Text></View>}
                      {!!turn.assistantText && <View style={styles.assistant}><Text selectable style={styles.assistantText}>{turn.assistantText}</Text></View>}
                      {turn.activities.map((activity, activityIndex) => renderActivity(turn.id, activity, `${turn.id}:${activity.id}:${activityIndex}`))}
                    </>
                  )}
              </View>
            ))}
          </ScrollView>
        )}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {(modelOptions.length > 0 || configFields.length > 0) && (
          <ScrollView
            contentContainerStyle={styles.selectorRow}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.selectorBar}
          >
            {modelOptions.length > 0 && (
              <PickerField
                disabled={working}
                label="Model"
                onSelect={value => void changeModel(value as string)}
                options={modelOptions}
                value={selectedModel?.identifier}
              />
            )}
            {configFields.map(field => (
              <PickerField
                disabled={working || !authoritativeModelId || !!optimisticModel || session?.model?.configurationWritable !== true}
                key={field.key}
                label={field.title}
                onSelect={value => authoritativeModelId && void changeConfiguration(authoritativeModelId, field.key, value)}
                options={field.options.map(option => ({ value: option.value, label: option.label }))}
                value={field.value ?? field.defaultValue}
              />
            ))}
            <PickerField
              disabled={working}
              label="Approvals"
              onSelect={value => void changePermission(value as string)}
              options={permissionOptions}
              value={displayedPermission}
            />
          </ScrollView>
        )}
        <View style={styles.composer}>
          <TextInput
            editable
            multiline
            onChangeText={setDraft}
            placeholder={working ? 'Queue your next message' : 'Message Copilot'}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            value={draft}
          />
          <Pressable accessibilityLabel="Send message" disabled={!draft.trim() || sending} onPress={() => void submit()} style={[styles.sendButton, (!draft.trim() || sending) && styles.disabled]}>
            {sending ? <ActivityIndicator color={colors.onBright} size="small" /> : <Send color={colors.onBright} size={19} />}
          </Pressable>
        </View>
      </View>
      <Modal animationType="fade" onRequestClose={closeEditor} transparent visible={!!editTarget}>
        <View style={styles.editOverlay}>
          <Pressable accessibilityLabel="Close request editor" onPress={closeEditor} style={styles.editBackdrop} />
          <View style={styles.editSheet}>
            <View style={styles.editHeader}>
              <Text style={styles.editTitle}>Edit request</Text>
              <Pressable accessibilityLabel="Close request editor" disabled={editing} onPress={closeEditor} style={styles.editClose}>
                <X color={colors.textSecondary} size={20} />
              </Pressable>
            </View>
            <Text style={styles.editWarning}>This request and every response after it will be replaced. File changes may also be undone by VS Code.</Text>
            <TextInput autoFocus editable={!editing} multiline onChangeText={setEditText} style={styles.editInput} value={editText} />
            <View style={styles.editActions}>
              <Pressable disabled={editing} onPress={closeEditor} style={styles.editCancel}><Text style={styles.editCancelText}>Cancel</Text></Pressable>
              <Pressable disabled={editing || !editText.trim()} onPress={() => void submitEdit()} style={[styles.editSubmit, (editing || !editText.trim()) && styles.disabled]}>
                {editing ? <ActivityIndicator color={colors.onBright} size="small" /> : <Text style={styles.editSubmitText}>Replace from here</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bgBase },
  header: { minHeight: 62, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center' },
  headerTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700' },
  headerMeta: { color: colors.textSecondary, fontSize: 10, marginTop: 2 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  transcript: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.xl },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 80 },
  turn: { gap: spacing.md },
  userRow: { alignSelf: 'flex-end', maxWidth: '92%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  userBubble: { alignSelf: 'flex-end', maxWidth: '88%', paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radii.card, backgroundColor: colors.bgRaised },
  userText: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 21 },
  editButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgBase },
  assistant: { alignSelf: 'stretch' },
  assistantText: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 22 },
  thinking: { borderLeftWidth: 2, borderLeftColor: colors.borderSubtle, paddingLeft: spacing.md },
  thinkingTitle: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '700', marginBottom: 4 },
  thinkingText: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  activity: { padding: spacing.md, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.button, backgroundColor: colors.bgPanel },
  activityLabel: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '700' },
  activityStatus: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  code: { color: colors.textSecondary, backgroundColor: colors.bgBase, fontFamily: 'monospace', fontSize: 11, lineHeight: 17, marginTop: spacing.sm, padding: spacing.sm },
  approvalRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  approveButton: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: radii.button, backgroundColor: colors.surfaceBright },
  approveText: { color: colors.onBright, fontSize: typography.bodySize, fontWeight: '700' },
  skipButton: { flex: 1, minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgBase },
  skipText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700' },
  error: { color: colors.statusRed, fontSize: typography.metaSize, textAlign: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  selectorBar: { maxHeight: 58, borderTopWidth: 1, borderTopColor: colors.borderSubtle, backgroundColor: colors.bgPanel },
  selectorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  composer: { padding: spacing.md, flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderSubtle, backgroundColor: colors.bgPanel },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: spacing.md, paddingVertical: 10, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.input, color: colors.textPrimary, backgroundColor: colors.bgBase, fontSize: typography.bodySize },
  sendButton: { width: 44, height: 44, borderRadius: radii.button, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceBright },
  disabled: { opacity: 0.4 },
  editOverlay: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  editBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.68)' },
  editSheet: { maxHeight: '82%', padding: spacing.lg, borderRadius: radii.card, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgPanel },
  editHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  editClose: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  editWarning: { color: colors.statusAmber, fontSize: typography.metaSize, lineHeight: 18, marginTop: spacing.sm },
  editInput: { minHeight: 150, maxHeight: 320, marginTop: spacing.lg, padding: spacing.md, borderRadius: radii.input, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgBase, color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 21, textAlignVertical: 'top' },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  editCancel: { minHeight: 42, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle },
  editCancelText: { color: colors.textPrimary, fontWeight: '600' },
  editSubmit: { minHeight: 42, minWidth: 150, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', borderRadius: radii.button, backgroundColor: colors.statusRed },
  editSubmitText: { color: colors.onBright, fontWeight: '700' },
});