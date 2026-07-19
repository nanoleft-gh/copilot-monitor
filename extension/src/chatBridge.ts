import * as vscode from 'vscode';

const localChatSessionScheme = 'vscode-chat-session';
const localChatSessionAuthority = 'local';
const targetedPromptCommand = 'workbench.action.chat.openSessionWithPrompt.local';
const activeChatOpenCommand = 'workbench.action.chat.open';
const editChatRequestCommand = 'workbench.action.chat.editRequests';
const submitChatRequestCommand = 'workbench.action.chat.submit';
const previousChatRequestCommand = 'workbench.action.chat.previousUserPrompt';
const nextChatRequestCommand = 'workbench.action.chat.nextUserPrompt';
const internalSwitchSessionCommand = '_chat.voice.switchToSession';
const openSessionInEditorCommand = 'workbench.action.chat.openSessionInEditorGroup';
const acceptToolCommand = 'workbench.action.chat.acceptTool';
const skipToolCommand = 'workbench.action.chat.skipTool';
const closeActiveEditorCommand = 'workbench.action.closeActiveEditor';
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

export async function editAndResubmitPrompt(
	resource: vscode.Uri,
	requestIndex: number,
	requestCount: number,
	prompt: string,
): Promise<void> {
	await focusChatSession(resource);
	for (let index = 0; index < requestCount; index++) {
		await vscode.commands.executeCommand(previousChatRequestCommand);
	}
	for (let index = 0; index < requestIndex; index++) {
		await vscode.commands.executeCommand(nextChatRequestCommand);
	}
	await vscode.commands.executeCommand(editChatRequestCommand);
	await vscode.commands.executeCommand(submitChatRequestCommand, { inputValue: prompt });
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
	if (commands.includes(internalSwitchSessionCommand) && commands.includes(getCurrentSessionCommand)) {
		const expectedResource = resource.toString();
		const switched = await vscode.commands.executeCommand<boolean>(internalSwitchSessionCommand, expectedResource);
		if (!switched) {
			throw new Error('VS Code could not activate the selected Copilot chat session.');
		}
		let activeResource: string | undefined;
		for (let attempt = 0; attempt < 10; attempt++) {
			activeResource = await vscode.commands.executeCommand<string | undefined>(getCurrentSessionCommand);
			if (activeResource === expectedResource) {
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		if (activeResource !== expectedResource) {
			throw new Error('VS Code activated a different Copilot chat session than requested.');
		}
	} else if (commands.includes(openSessionInEditorCommand)) {
		await openChatSessionInEditor(resource);
	} else {
		await focusChatSession(resource, commands);
	}
	await vscode.commands.executeCommand(activeChatOpenCommand, { modelSelector: selector });
}

export async function releaseChatSession(resource: vscode.Uri): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(openSessionInEditorCommand)
		|| !commands.includes(closeActiveEditorCommand)) {
		throw new Error('VS Code does not expose the commands required to reload a chat configuration.');
	}

	await openChatSessionInEditor(resource);
	await vscode.commands.executeCommand(closeActiveEditorCommand);
}

async function openChatSessionInEditor(resource: vscode.Uri): Promise<void> {
	const session = { resource };
	await vscode.commands.executeCommand(openSessionInEditorCommand, {
		$mid: agentSessionContextMarshalledId,
		session,
		sessions: [session],
	});
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
	throw new Error('VS Code created a chat but did not expose its session identity.');
}