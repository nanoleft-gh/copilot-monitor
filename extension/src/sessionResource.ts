/**
 * Local chat session resources have the form `vscode-chat-session://local/<base64url(sessionId)>`.
 * These helpers keep that encoding in one place and free of the `vscode` module so the core
 * can be unit tested outside the extension host.
 */

export const localChatSessionScheme = 'vscode-chat-session';
export const localChatSessionAuthority = 'local';

export function localSessionResource(sessionId: string): string {
	const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
	return `${localChatSessionScheme}://${localChatSessionAuthority}/${encoded}`;
}

export function sessionIdFromResource(resource: string): string | undefined {
	const prefix = `${localChatSessionScheme}://${localChatSessionAuthority}/`;
	if (!resource.startsWith(prefix)) {
		return undefined;
	}
	const encoded = resource.slice(prefix.length).split(/[?#]/, 1)[0];
	if (!encoded) {
		return undefined;
	}
	try {
		const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
		return decoded || undefined;
	} catch {
		return undefined;
	}
}
