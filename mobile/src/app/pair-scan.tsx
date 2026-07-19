import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { Camera, ChevronLeft, Clipboard, QrCode } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';
import { saveHost } from '@/transport/host-store';
import { pairGateway } from '@/transport/pairing';

export default function PairScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairing, setPairing] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const pair = useCallback(async (value: string) => {
    if (pairing) {
      return;
    }
    setPairing(true);
    setError(null);
    try {
      const host = await pairGateway(value);
      await saveHost(host);
      router.replace('/');
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : String(pairError));
      setPairing(false);
    }
  }, [pairing]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={colors.textPrimary} size={24} />
        </Pressable>
        <Text style={styles.headerTitle}>Pair computer</Text>
        <View style={styles.iconButton} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
        >
        <Text style={styles.title}>Scan the pairing code</Text>
        <Text style={styles.body}>Open the Copilot Monitor sidebar in VS Code, then point your camera at its QR code.</Text>

        <View style={styles.cameraFrame}>
          {permission?.granted ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={pairing ? undefined : event => void pair(event.data)}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={styles.permissionState}>
              <Camera color={colors.textSecondary} size={30} strokeWidth={1.5} />
              <Text style={styles.permissionText}>Camera access is used only to scan pairing codes.</Text>
              <Pressable onPress={() => void requestPermission()} style={styles.permissionButton}>
                <Text style={styles.permissionButtonText}>Allow camera</Text>
              </Pressable>
            </View>
          )}
          <View pointerEvents="none" style={styles.scanGuide}>
            <QrCode color="rgba(255,255,255,0.82)" size={56} strokeWidth={1.2} />
          </View>
        </View>

        {pairing && <Text style={styles.pending}>Connecting to Copilot Monitor...</Text>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}

        <Pressable accessibilityRole="button" onPress={() => setManualEntry(value => !value)} style={styles.manualButton}>
          <Clipboard color={colors.textSecondary} size={18} />
          <Text style={styles.manualText}>Paste pairing code</Text>
        </Pressable>
        {manualEntry && (
          <View style={styles.manualEntry}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onFocus={() => requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))}
              onChangeText={value => {
                setAddress(value);
                setError(null);
              }}
              placeholder="http://192.168.1.10:43121/"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              value={address}
            />
            <Pressable
              accessibilityRole="button"
              disabled={pairing || !address.trim()}
              onPress={() => void pair(address)}
              style={({ pressed }) => [styles.connectButton, (pairing || !address.trim()) && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={styles.connectButtonText}>Connect</Text>
            </Pressable>
          </View>
        )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bgBase },
  header: { height: 58, paddingHorizontal: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  keyboardArea: { flex: 1 },
  content: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xl, alignItems: 'center' },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '700', marginTop: spacing.md },
  body: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 21, textAlign: 'center', maxWidth: 360, marginTop: spacing.sm },
  cameraFrame: { width: '100%', maxWidth: 380, aspectRatio: 1, borderRadius: radii.camera, overflow: 'hidden', backgroundColor: colors.bgPanel, marginTop: spacing.xl, borderWidth: 1, borderColor: colors.borderSubtle },
  permissionState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  permissionText: { color: colors.textSecondary, textAlign: 'center', fontSize: typography.bodySize, lineHeight: 20, marginTop: spacing.md },
  permissionButton: { marginTop: spacing.lg, minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radii.button, backgroundColor: colors.surfaceBright, justifyContent: 'center' },
  permissionButtonText: { color: colors.onBright, fontWeight: '700' },
  scanGuide: { position: 'absolute', width: 156, height: 156, left: '50%', top: '50%', marginLeft: -78, marginTop: -78, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', borderRadius: radii.camera, alignItems: 'center', justifyContent: 'center' },
  pending: { color: colors.statusAmber, fontSize: typography.metaSize, textAlign: 'center', marginTop: spacing.md },
  error: { color: colors.statusRed, fontSize: typography.metaSize, lineHeight: 18, textAlign: 'center', marginTop: spacing.md, maxWidth: 380 },
  manualButton: { minHeight: 46, marginTop: spacing.lg, paddingHorizontal: spacing.lg, borderRadius: radii.button, borderWidth: 1, borderColor: colors.borderSubtle, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  manualText: { color: colors.textSecondary, fontSize: typography.bodySize, fontWeight: '600' },
  manualEntry: { width: '100%', maxWidth: 380, marginTop: spacing.md, gap: spacing.sm },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.input, backgroundColor: colors.bgPanel, color: colors.textPrimary, paddingHorizontal: spacing.md, fontSize: typography.bodySize },
  connectButton: { minHeight: 46, borderRadius: radii.button, backgroundColor: colors.surfaceBright, alignItems: 'center', justifyContent: 'center' },
  connectButtonText: { color: colors.onBright, fontSize: typography.bodySize, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.78 },
});