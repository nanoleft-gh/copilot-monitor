import * as vscode from 'vscode';

const localChatSessionScheme = 'vscode-chat-session';
const localChatSessionAuthority = 'local';
const targetedPromptCommand = 'workbench.action.chat.openSessionWithPrompt.local';
const activeChatOpenCommand = 'workbench.action.chat.open';
const internalSwitchSessionCommand = '_chat.voice.switchToSession';
const openSessionInEditorCommand = 'workbench.action.chat.openSessionInEditorGroup';
const acceptToolCommand = 'workbench.action.chat.acceptTool';
const skipToolCommand = 'workbench.action.chat.skipTool';
const closeActiveEditorCommand = 'workbench.action.closeActiveEditor';
const revertAndCloseActiveEditorCommand = 'workbench.action.revertAndCloseActiveEditor';
const inspectChatModelReferencesCommand = 'workbench.action.chat.inspectChatModelReferences';
const inspectChatModelCommand = 'workbench.action.chat.inspectChatModel';
const newLocalChatCommand = 'workbench.action.chat.newLocalChat';
const getCurrentSessionCommand = '_chat.voice.getCurrentSession';
const agentSessionContextMarshalledId = 25;

export interface ChatModelSelector {
	readonly id: string;
	readonly vendor: string;
}

/**
 * Rebuilds the local chat session resource URI from a persisted session id, so
 * the extension can address a specific session without the proposed
 * `activeChatPanelSessionResource` API.
 */
export function buildLocalSessionResource(sessionId: string): vscode.Uri {
	const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
	return vscode.Uri.from({
		scheme: localChatSessionScheme,
		authority: localChatSessionAuthority,
		path: `/${encoded}`,
	});
}

/**
 * Sends a prompt to the target chat session. Prefers the session-targeted
 * command when the running VS Code build exposes it, and otherwise falls back
 * to submitting to the active chat view.
 */
export async function sendPrompt(resource: vscode.Uri, prompt: string): Promise<void> {
	const commands = await vscode.commands.getCommands(true);

	if (commands.includes(targetedPromptCommand)) {
		await vscode.commands.executeCommand(targetedPromptCommand, { resource, prompt });
		return;
	}

	if (commands.includes(activeChatOpenCommand)) {
		await focusChatSession(resource, commands);
		await vscode.commands.executeCommand(activeChatOpenCommand, { query: prompt });
		return;
	}

	throw new Error('No available VS Code command to send a Copilot chat prompt.');
}

export async function focusChatSession(resource: vscode.Uri, availableCommands?: readonly string[]): Promise<void> {
	const commands = availableCommands ?? await vscode.commands.getCommands(true);
	if (commands.includes(internalSwitchSessionCommand)) {
		const switched = await vscode.commands.executeCommand<boolean>(
			internalSwitchSessionCommand,
			resource.toString(),
		);
		if (switched) {
			return;
		}
	}

	if (commands.includes(openSessionInEditorCommand)) {
		await openChatSessionInEditor(resource);
		return;
	}

	throw new Error('No available VS Code command can activate the selected Copilot chat session.');
}

export async function decideTool(resource: vscode.Uri, decision: 'allow' | 'skip'): Promise<void> {
	const command = decision === 'allow' ? acceptToolCommand : skipToolCommand;
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(command)) {
		throw new Error(`VS Code does not expose the ${decision} tool command.`);
	}
	await vscode.commands.executeCommand(command, { sessionResource: resource });
}

export async function selectChatModel(resource: vscode.Uri, selector: ChatModelSelector): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(activeChatOpenCommand)) {
		throw new Error('VS Code does not expose the chat model selection command.');
	}
	if (commands.includes(openSessionInEditorCommand)) {
		await openChatSessionInEditor(resource);
	} else {
		await focusChatSession(resource, commands);
	}
	await vscode.commands.executeCommand(activeChatOpenCommand, { modelSelector: selector });
}

export async function releaseChatSession(resource: vscode.Uri): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(openSessionInEditorCommand)
		|| !commands.includes(closeActiveEditorCommand)
		|| !commands.includes(inspectChatModelReferencesCommand)) {
		throw new Error('VS Code does not expose the commands required to reload a chat configuration.');
	}

	await openChatSessionInEditor(resource);
	await vscode.commands.executeCommand(closeActiveEditorCommand);
	for (let attempt = 0; attempt < 50; attempt++) {
		const report = await inspectChatModelReferences();
		if (!report.includes(`- Session: ${resource.toString()}\n`)) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('The chat is still held open by VS Code. Finish pending work or edits and try again.');
}

async function openChatSessionInEditor(resource: vscode.Uri): Promise<void> {
	const session = { resource };
	await vscode.commands.executeCommand(openSessionInEditorCommand, {
		$mid: agentSessionContextMarshalledId,
		session,
		sessions: [session],
	});
}

async function inspectChatModelReferences(): Promise<string> {
	await vscode.commands.executeCommand(inspectChatModelReferencesCommand);
	const editor = vscode.window.activeTextEditor;
	const report = editor?.document.getText() ?? '';
	if (!report.startsWith('# Chat Model References')) {
		throw new Error('VS Code did not return its chat model reference report.');
	}
	await discardActiveInspectEditor();
	return report;
}

export async function inspectChatSession(resource: vscode.Uri): Promise<Record<string, unknown>> {
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(openSessionInEditorCommand) || !commands.includes(inspectChatModelCommand)) {
		throw new Error('VS Code does not expose the commands required to verify chat configuration.');
	}
	await openChatSessionInEditor(resource);
	return inspectActiveChatModel();
}

async function inspectActiveChatModel(): Promise<Record<string, unknown>> {
	await vscode.commands.executeCommand(inspectChatModelCommand);
	const report = vscode.window.activeTextEditor?.document.getText() ?? '';
	const marker = '## Full Chat Model\n\n```json\n';
	const start = report.indexOf(marker);
	const end = start >= 0 ? report.indexOf('\n```', start + marker.length) : -1;
	if (start < 0 || end < 0) {
		await discardActiveInspectEditor();
		throw new Error('VS Code did not return its native chat model inspection.');
	}
	await discardActiveInspectEditor();
	const value = JSON.parse(report.slice(start + marker.length, end)) as unknown;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('VS Code returned an invalid native chat model inspection.');
	}
	return value as Record<string, unknown>;
}

/**
 * Closes the scratch markdown editor that VS Code's inspect commands open.
 * Those editors are untitled and dirty from creation (they are opened with
 * inline `contents`), so a plain close prompts to save. `revertAndClose`
 * discards the buffer first, avoiding the dialog; older builds without that
 * command fall back to a plain close.
 */
async function discardActiveInspectEditor(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes(revertAndCloseActiveEditorCommand)) {
		await vscode.commands.executeCommand(revertAndCloseActiveEditorCommand);
		return;
	}
	await vscode.commands.executeCommand(closeActiveEditorCommand);
}

export async function createNewChat(sourceResource?: vscode.Uri): Promise<vscode.Uri> {
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(newLocalChatCommand)) {
		throw new Error('VS Code does not expose the commands required to create and identify a new local chat.');
	}
	if (sourceResource) {
		await focusChatSession(sourceResource, commands);
	}
	await vscode.commands.executeCommand(newLocalChatCommand);
	if (commands.includes(getCurrentSessionCommand)) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const value = await vscode.commands.executeCommand<string | undefined>(getCurrentSessionCommand);
			if (value && value !== sourceResource?.toString()) {return vscode.Uri.parse(value);}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
	if (commands.includes(inspectChatModelCommand)) {
		const model = await inspectActiveChatModel();
		if (typeof model.sessionId === 'string' && model.sessionId) {return buildLocalSessionResource(model.sessionId);}
	}
	throw new Error('VS Code created a chat but did not expose its session identity.');
}