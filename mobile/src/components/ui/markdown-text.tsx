import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useMarkdown, type MarkedStyles, type useMarkdownHookOptions } from 'react-native-marked';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';

const monospace = 'monospace';
const bodyText = { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 22 } as const;

const markdownStyles: MarkedStyles = {
  text: bodyText,
  em: { ...bodyText, fontStyle: 'italic' },
  strong: { ...bodyText, fontWeight: '700' },
  strikethrough: { ...bodyText, textDecorationLine: 'line-through' },
  link: { ...bodyText, color: colors.accentBlue, fontStyle: 'normal', textDecorationLine: 'underline' },
  li: { ...bodyText, flexShrink: 1 },
  paragraph: { paddingVertical: 3 },
  h1: { color: colors.textPrimary, fontSize: 22, lineHeight: 28, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.xs, borderBottomWidth: 0, paddingBottom: 0 },
  h2: { color: colors.textPrimary, fontSize: 19, lineHeight: 25, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.xs, borderBottomWidth: 0, paddingBottom: 0 },
  h3: { color: colors.textPrimary, fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: spacing.sm, marginBottom: 2 },
  h4: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 21, fontWeight: '700', marginTop: spacing.sm, marginBottom: 2 },
  h5: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 21, fontWeight: '700', marginVertical: 2 },
  h6: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18, fontWeight: '700', marginVertical: 2 },
  codespan: { color: colors.textPrimary, backgroundColor: colors.bgRaised, fontFamily: monospace, fontSize: 12.5, fontStyle: 'normal', fontWeight: '400', borderRadius: 3 },
  code: { backgroundColor: colors.bgPanel, borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radii.button, padding: spacing.md, marginVertical: spacing.xs },
  codeText: { color: colors.textPrimary, fontFamily: monospace, fontSize: 12, lineHeight: 18 },
  blockquote: { borderLeftColor: colors.borderSubtle, borderLeftWidth: 3, paddingLeft: spacing.md, marginVertical: spacing.xs, opacity: 1 },
  hr: { borderBottomColor: colors.borderSubtle, borderBottomWidth: 1, marginVertical: spacing.sm },
  table: { borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radii.button, marginVertical: spacing.xs },
  tableCell: { padding: spacing.sm },
};

const markdownOptions: useMarkdownHookOptions = {
  colorScheme: 'dark',
  styles: markdownStyles,
  theme: { colors: { code: colors.bgPanel, link: colors.accentBlue, text: colors.textPrimary, border: colors.borderSubtle } },
  selectable: true,
};

/**
 * Renders an assistant message as GitHub-flavoured markdown. Memoised so that, while a
 * reply streams, only the block whose text actually changed is re-parsed.
 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const elements = useMarkdown(text, markdownOptions);
  return <View style={styles.container}>{elements}</View>;
});

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
});
