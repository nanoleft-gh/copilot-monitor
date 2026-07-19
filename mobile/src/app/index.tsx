import { router, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { ChevronRight, Laptop, Monitor, QrCode, Settings, Trash2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';
import { loadHosts, removeHost } from '@/transport/host-store';
import type { HostProfile } from '@/transport/types';

export default function HomeScreen() {
  const [hosts, setHosts] = useState<HostProfile[]>([]);

  const deleteHost = useCallback((host: HostProfile) => {
    Alert.alert(
      'Remove computer?',
      `${host.name} will be removed from this phone. You can pair it again later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void removeHost(host.id).then(() => setHosts(current => current.filter(candidate => candidate.id !== host.id))),
        },
      ],
    );
  }, []);

  useFocusEffect(useCallback(() => {
    let active = true;
    void loadHosts().then(value => {
      if (active) {
        setHosts(value.sort((left, right) => right.lastConnected - left.lastConnected));
      }
    });
    return () => { active = false; };
  }, []));

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Image contentFit="contain" source={require('../../assets/images/copilot-monitor-icon.png')} style={styles.mark} />
            <View>
              <Text style={styles.title}>Copilot Monitor</Text>
              <Text style={styles.subtitle}>Your coding sessions, close at hand</Text>
            </View>
          </View>
          <Pressable accessibilityLabel="Settings" disabled style={styles.iconButton}>
            <Settings color={colors.textSecondary} size={20} strokeWidth={1.8} />
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Computers</Text>
          <Text style={styles.count}>{hosts.length} paired</Text>
        </View>

        {hosts.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Laptop color={colors.textSecondary} size={30} strokeWidth={1.5} />
            </View>
            <Text style={styles.emptyTitle}>No computers paired</Text>
            <Text style={styles.emptyBody}>
              Pair a computer running the Copilot Monitor extension to follow chats and respond from this device.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/pair-scan')}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            >
              <QrCode color={colors.onBright} size={19} strokeWidth={2} />
              <Text style={styles.primaryButtonText}>Pair computer</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.hostList}>
            {hosts.map(host => (
              <View key={host.id} style={styles.hostCard}>
                <Pressable
                  accessibilityLabel={`Open ${host.name}`}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/host', params: { hostId: host.id } })}
                  style={({ pressed }) => [styles.hostOpen, pressed && styles.pressed]}
                >
                  <View style={styles.hostIcon}><Monitor color={colors.textPrimary} size={22} strokeWidth={1.7} /></View>
                  <View style={styles.hostCopy}>
                    <View style={styles.hostTitleRow}>
                      <Text numberOfLines={1} style={styles.hostTitle}>{host.name}</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.hostEndpoint}>{host.endpoint}</Text>
                    <Text style={styles.hostStatus}>Saved local pairing</Text>
                  </View>
                  <ChevronRight color={colors.textMuted} size={20} />
                </Pressable>
                <Pressable accessibilityLabel={`Remove ${host.name}`} onPress={() => deleteHost(host)} style={styles.deleteButton}>
                  <Trash2 color={colors.statusRed} size={18} />
                </Pressable>
              </View>
            ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/pair-scan')}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
              <QrCode color={colors.textSecondary} size={18} strokeWidth={2} />
              <Text style={styles.secondaryButtonText}>Pair another computer</Text>
          </Pressable>
          </View>
        )}

        <View style={styles.privacyNote}>
          <View style={styles.onlineDot} />
          <Text style={styles.privacyText}>Connections stay on your local network.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bgBase },
  content: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  header: { minHeight: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0, flex: 1 },
  mark: { width: 38, height: 38, borderRadius: radii.button },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 2 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  count: { color: colors.textMuted, fontSize: typography.metaSize },
  emptyState: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.card, backgroundColor: colors.bgPanel, paddingHorizontal: spacing.xl, paddingVertical: 36, alignItems: 'center' },
  emptyIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.bgRaised, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  emptyTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '600' },
  emptyBody: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 21, textAlign: 'center', maxWidth: 330, marginTop: spacing.sm },
  primaryButton: { minHeight: 46, marginTop: spacing.xl, paddingHorizontal: spacing.lg, borderRadius: radii.button, backgroundColor: colors.surfaceBright, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: colors.onBright, fontSize: typography.bodySize, fontWeight: '700' },
  hostList: { gap: spacing.md },
  hostCard: { minHeight: 82, flexDirection: 'row', alignItems: 'stretch', borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.card, backgroundColor: colors.bgPanel, overflow: 'hidden' },
  hostOpen: { minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  hostIcon: { width: 46, height: 46, borderRadius: radii.button, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  hostCopy: { minWidth: 0, flex: 1 },
  hostTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hostTitle: { minWidth: 0, flex: 1, color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700' },
  hostEndpoint: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 3 },
  hostStatus: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  deleteButton: { width: 48, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: colors.borderSubtle },
  secondaryButton: { minHeight: 46, borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  secondaryButtonText: { color: colors.textSecondary, fontSize: typography.bodySize, fontWeight: '600' },
  pressed: { opacity: 0.78 },
  privacyNote: { marginTop: 'auto', paddingTop: spacing.xl, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.statusGreen },
  privacyText: { color: colors.textMuted, fontSize: typography.metaSize },
});