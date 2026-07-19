import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, ChevronRight, MessageSquare, Plus, RefreshCw, WifiOff } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';
import { createSession, fetchGatewaySnapshot, hasVisibleContent, selectSession } from '@/transport/gateway-client';
import { getHost } from '@/transport/host-store';
import { subscribeToGateway } from '@/transport/gateway-stream';
import type { GatewaySnapshot, HostProfile, SessionSummary, WindowSnapshot } from '@/transport/types';

export default function HostOverviewScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const [host, setHost] = useState<HostProfile>();
  const [snapshot, setSnapshot] = useState<GatewaySnapshot>();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string>();
  const [creatingInWindow, setCreatingInWindow] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!hostId) return;
    setLoading(true);
    setError(undefined);
    try {
      const nextHost = await getHost(hostId);
      if (!nextHost) throw new Error('This paired computer is no longer available.');
      setHost(nextHost);
      setSnapshot(await fetchGatewaySnapshot(nextHost));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => {
    if (!hostId) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const nextHost = await getHost(hostId);
        if (!nextHost) throw new Error('This paired computer is no longer available.');
        if (!active) return;
        setHost(nextHost);
        setSnapshot(await fetchGatewaySnapshot(nextHost));
        if (!active) return;
        setLoading(false);
        unsubscribe = subscribeToGateway(nextHost, {
          onSnapshot: value => { if (active) { setSnapshot(value); setError(undefined); } },
        });
      } catch (refreshError) {
        if (active) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
          setLoading(false);
        }
      }
    })();
    return () => { active = false; unsubscribe?.(); };
  }, [hostId]);

  const openSession = useCallback(async (window: WindowSnapshot, session: SessionSummary) => {
    if (!host) return;
    setOpening(session.resource);
    setError(undefined);
    try {
      await selectSession(host, window.windowId, session.resource);
      router.push({
        pathname: '/chat',
        params: { hostId: host.id, windowId: window.windowId, sessionResource: session.resource },
      });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setOpening(undefined);
    }
  }, [host]);

  const createChat = useCallback(async (window: WindowSnapshot) => {
    if (!host || creatingInWindow) return;
    setCreatingInWindow(window.windowId);
    setError(undefined);
    try {
      const result = await createSession(
        host,
        window.windowId,
        window.activeSessionResource,
        window.sessions.map(session => session.resource),
      );
      router.push({
        pathname: '/chat',
        params: { hostId: host.id, windowId: window.windowId, sessionResource: result.sessionResource },
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreatingInWindow(undefined);
    }
  }, [creatingInWindow, host]);

  const visibleWindows = (snapshot?.windows ?? []).map(window => ({
    ...window,
    sessions: window.sessions.filter(session => hasVisibleContent(session) || session.resource === window.activeSessionResource),
  }));
  const sessionCount = visibleWindows.reduce((total, window) => total + window.sessions.length, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={colors.textPrimary} size={24} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.headerTitle}>{host?.name ?? 'Computer'}</Text>
          <Text numberOfLines={1} style={styles.headerMeta}>{host?.endpoint ?? 'Connecting...'}</Text>
        </View>
        <Pressable accessibilityLabel="Refresh" disabled={loading} onPress={() => void refresh()} style={styles.iconButton}>
          <RefreshCw color={colors.textSecondary} size={20} />
        </Pressable>
      </View>

      {loading && !snapshot ? (
        <View style={styles.center}><ActivityIndicator color={colors.accentBlue} /><Text style={styles.muted}>Loading conversations...</Text></View>
      ) : error && !snapshot ? (
        <View style={styles.center}>
          <WifiOff color={colors.statusRed} size={32} />
          <Text style={styles.errorTitle}>Computer unavailable</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => void refresh()} style={styles.primaryButton}><Text style={styles.primaryText}>Try again</Text></Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.summaryRow}>
            <View><Text style={styles.summaryValue}>{snapshot?.windows.length ?? 0}</Text><Text style={styles.summaryLabel}>VS Code windows</Text></View>
            <View style={styles.summaryDivider} />
            <View><Text style={styles.summaryValue}>{sessionCount}</Text><Text style={styles.summaryLabel}>Conversations</Text></View>
          </View>
          {error && <Text accessibilityRole="alert" style={styles.inlineError}>{error}</Text>}
          {visibleWindows.map(window => (
            <View key={window.windowId} style={styles.windowSection}>
              <View style={styles.windowHeader}>
                <View style={[styles.statusDot, { backgroundColor: window.connected ? colors.statusGreen : colors.statusRed }]} />
                <View style={styles.windowCopy}>
                  <Text numberOfLines={1} style={styles.windowTitle}>{window.workspaceName || 'VS Code'}</Text>
                  <Text numberOfLines={1} style={styles.windowPath}>{window.workspaceFolders[0] ?? 'No workspace folder'}</Text>
                </View>
                <Text style={styles.windowCount}>{window.sessions.length}</Text>
                <Pressable
                  accessibilityLabel={`New chat in ${window.workspaceName || 'VS Code'}`}
                  disabled={!window.connected || !!creatingInWindow}
                  onPress={() => void createChat(window)}
                  style={[styles.newChatButton, (!window.connected || !!creatingInWindow) && styles.disabled]}
                >
                  {creatingInWindow === window.windowId ? <ActivityIndicator color={colors.textPrimary} size="small" /> : <Plus color={colors.textPrimary} size={18} />}
                </Pressable>
              </View>
              {window.sessions.length === 0 ? (
                <Text style={styles.emptyWindow}>No Copilot conversations in this window.</Text>
              ) : window.sessions.map(session => {
                const active = window.activeSessionResource === session.resource;
                return (
                  <Pressable
                    accessibilityRole="button"
                    disabled={opening === session.resource}
                    key={session.resource}
                    onPress={() => void openSession(window, session)}
                    style={({ pressed }) => [styles.sessionRow, active && styles.activeSession, pressed && styles.pressed]}
                  >
                    <View style={styles.sessionIcon}><MessageSquare color={active ? colors.accentBlue : colors.textSecondary} size={18} /></View>
                    <View style={styles.sessionCopy}>
                      <View style={styles.sessionTitleRow}>
                        <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
                        {session.status === 'working' && <Text style={styles.workingBadge}>Working</Text>}
                      </View>
                      <Text numberOfLines={1} style={styles.sessionMeta}>
                        {(session.turnCount ?? session.turns.length) === 0
                          ? 'Ready to chat'
                          : `${session.turnCount ?? session.turns.length} messages${session.modelName ? ` · ${session.modelName}` : ''}`}
                      </Text>
                    </View>
                    {opening === session.resource ? <ActivityIndicator color={colors.accentBlue} size="small" /> : <ChevronRight color={colors.textMuted} size={20} />}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bgBase },
  header: { minHeight: 62, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center' },
  headerTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700' },
  headerMeta: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  muted: { color: colors.textSecondary, fontSize: typography.bodySize },
  errorTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
  errorText: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20, textAlign: 'center' },
  primaryButton: { minHeight: 44, paddingHorizontal: spacing.lg, justifyContent: 'center', borderRadius: radii.button, backgroundColor: colors.surfaceBright },
  primaryText: { color: colors.onBright, fontWeight: '700' },
  content: { padding: spacing.lg, paddingBottom: 40, gap: spacing.lg },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: spacing.lg, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.card, backgroundColor: colors.bgPanel },
  summaryValue: { color: colors.textPrimary, fontSize: 24, fontWeight: '700', textAlign: 'center' },
  summaryLabel: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 3 },
  summaryDivider: { width: 1, height: 38, backgroundColor: colors.borderSubtle },
  inlineError: { color: colors.statusRed, fontSize: typography.metaSize, textAlign: 'center' },
  windowSection: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.card, overflow: 'hidden', backgroundColor: colors.bgPanel },
  windowHeader: { minHeight: 62, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  windowCopy: { flex: 1, minWidth: 0 },
  windowTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700' },
  windowPath: { color: colors.textMuted, fontSize: 10, marginTop: 3 },
  windowCount: { color: colors.textSecondary, fontSize: typography.metaSize },
  newChatButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgRaised },
  emptyWindow: { color: colors.textMuted, fontSize: typography.metaSize, padding: spacing.lg, textAlign: 'center' },
  sessionRow: { minHeight: 70, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  activeSession: { backgroundColor: 'rgba(59,130,246,0.08)' },
  sessionIcon: { width: 34, height: 34, borderRadius: radii.button, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  sessionCopy: { flex: 1, minWidth: 0 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sessionTitle: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  workingBadge: { color: colors.statusAmber, fontSize: 10, fontWeight: '700' },
  sessionMeta: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 4 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
});