import { Check, ChevronDown } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';

export type PickerValue = string | number | boolean;

export type PickerOption = {
  value: PickerValue;
  label: string;
  hint?: string;
};

type PickerFieldProps = {
  label: string;
  value?: PickerValue;
  options: PickerOption[];
  disabled?: boolean;
  onSelect: (value: PickerValue) => void;
};

export function PickerField({ label, value, options, disabled, onSelect }: PickerFieldProps) {
  const [open, setOpen] = useState(false);
  const dismissReady = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selected = options.find(option => option.value === value);

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  const close = () => {
    dismissReady.current = false;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = undefined;
    setOpen(false);
  };

  const handleShow = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    // Android can deliver the same finger-up event that opened a native Modal
    // to its newly mounted backdrop. Delay backdrop dismissal until that gesture
    // has fully completed; option rows remain interactive immediately.
    dismissTimer.current = setTimeout(() => {
      dismissReady.current = true;
      dismissTimer.current = undefined;
    }, 150);
  };

  return (
    <>
      <Pressable
        accessibilityLabel={`${label}: ${selected?.label ?? 'none'}`}
        accessibilityRole="button"
        disabled={disabled || options.length === 0}
        onPress={() => {
          dismissReady.current = false;
          setOpen(true);
        }}
        style={[styles.field, (disabled || options.length === 0) && styles.fieldDisabled]}
      >
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.fieldValueRow}>
          <Text numberOfLines={1} style={styles.fieldValue}>{selected?.label ?? '—'}</Text>
          <ChevronDown color={colors.textMuted} size={14} />
        </View>
      </Pressable>

      <Modal animationType="fade" onRequestClose={close} onShow={handleShow} transparent visible={open}>
        <View style={styles.overlay}>
          <Pressable
            accessibilityLabel={`Close ${label}`}
            onPress={() => { if (dismissReady.current) close(); }}
            style={styles.backdrop}
          />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{label}</Text>
            <ScrollView style={styles.sheetScroll}>
              {options.map(option => {
                const active = option.value === value;
                return (
                  <Pressable
                    accessibilityRole="button"
                    key={String(option.value)}
                    onPress={() => { close(); onSelect(option.value); }}
                    style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  >
                    <View style={styles.optionCopy}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      {!!option.hint && <Text style={styles.optionHint}>{option.hint}</Text>}
                    </View>
                    {active && <Check color={colors.accentBlue} size={17} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: 34, paddingHorizontal: spacing.sm, paddingVertical: 5, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.button, backgroundColor: colors.bgBase, justifyContent: 'center' },
  fieldDisabled: { opacity: 0.45 },
  fieldLabel: { color: colors.textMuted, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: '700' },
  fieldValueRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  fieldValue: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '600', maxWidth: 120 },
  overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { maxHeight: '70%', borderRadius: radii.card, borderWidth: 1, borderColor: colors.borderSubtle, backgroundColor: colors.bgPanel, paddingVertical: spacing.md },
  sheetTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '700', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  sheetScroll: { paddingHorizontal: spacing.sm },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: radii.button },
  optionPressed: { backgroundColor: colors.bgRaised },
  optionCopy: { flex: 1, minWidth: 0 },
  optionLabel: { color: colors.textPrimary, fontSize: typography.bodySize },
  optionHint: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});
