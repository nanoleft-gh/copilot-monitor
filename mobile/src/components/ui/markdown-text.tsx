import { Component, memo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors, radii, spacing, typography } from '@/theme/mobile-theme';

const monospace = Platform.select({ ios: 'Menlo', default: 'monospace' });
const bodyText = { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 22 } as const;
const heading = { color: colors.textPrimary, fontWeight: '700', marginTop: spacing.sm, marginBottom: 2 } as const;
const codeBox = {
  color: colors.textPrimary,
  backgroundColor: colors.bgPanel,
  borderColor: colors.borderSubtle,
  borderWidth: 1,
  borderRadius: radii.button,
  padding: spacing.md,
  marginVertical: spacing.xs,
  fontFamily: monospace,
  fontSize: 12,
  lineHeight: 18,
} as const;

// Keys follow react-native-markdown-display's rule names (markdown-it token types).
const markdownStyles = StyleSheet.create({
  body: bodyText,
  text: bodyText,
  paragraph: { marginTop: 3, marginBottom: 3 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  s: { textDecorationLine: 'line-through' },
  link: { color: colors.accentBlue, textDecorationLine: 'underline' },
  blocklink: { borderColor: colors.accentBlue },
  heading1: { ...heading, fontSize: 22, lineHeight: 28, marginTop: spacing.md, marginBottom: spacing.xs },
  heading2: { ...heading, fontSize: 19, lineHeight: 25, marginTop: spacing.md, marginBottom: spacing.xs },
  heading3: { ...heading, fontSize: 16, lineHeight: 22 },
  heading4: { ...heading, fontSize: typography.bodySize, lineHeight: 21 },
  heading5: { ...heading, color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 21 },
  heading6: { ...heading, color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  code_inline: { color: colors.textPrimary, backgroundColor: colors.bgRaised, borderWidth: 0, borderRadius: 3, paddingHorizontal: 4, fontFamily: monospace, fontSize: 12.5 },
  code_block: codeBox,
  fence: codeBox,
  blockquote: { backgroundColor: 'transparent', borderLeftColor: colors.borderSubtle, borderLeftWidth: 3, paddingLeft: spacing.md, marginLeft: 0, marginVertical: spacing.xs },
  hr: { backgroundColor: colors.borderSubtle, height: 1, marginVertical: spacing.sm },
  bullet_list_icon: { color: colors.textSecondary, marginLeft: 6, marginRight: 8 },
  ordered_list_icon: { color: colors.textSecondary, marginLeft: 6, marginRight: 8 },
  list_item: { marginVertical: 2 },
  table: { borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radii.button, marginVertical: spacing.xs },
  th: { padding: spacing.sm, fontWeight: '700' },
  td: { padding: spacing.sm },
  tr: { borderColor: colors.borderSubtle },
});

/** Renders an assistant message as markdown; falls back to plain text if the renderer throws. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <View style={styles.container}>
      <MarkdownBoundary fallback={<Text selectable style={bodyText}>{text}</Text>}>
        <Markdown mergeStyle={false} style={markdownStyles}>{text}</Markdown>
      </MarkdownBoundary>
    </View>
  );
});

type BoundaryProps = { children: ReactNode; fallback: ReactNode };

class MarkdownBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('Markdown rendering failed; showing plain text.', error);
  }

  componentDidUpdate(previous: BoundaryProps): void {
    // A new message body deserves a fresh attempt.
    if (this.state.failed && previous.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
});
