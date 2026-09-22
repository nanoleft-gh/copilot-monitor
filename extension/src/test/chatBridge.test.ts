import * as assert from 'node:assert/strict';
import Module = require('node:module');
import { it } from 'node:test';

it('targets the exact request before submitting an edited prompt', async () => {
	const calls: { command: string; argument?: unknown }[] = [];
	const resource = { toString: () => 'vscode-chat-session://local/session' };
	const commands = [
		'_chat.voice.switchToSession',
		'_chat.voice.getCurrentSession',
		'workbench.action.chat.open',
		'workbench.action.chat.previousUserPrompt',
		'workbench.action.chat.nextUserPrompt',
		'workbench.action.chat.editRequests',
		'workbench.action.chat.submit',
	];
	const vscode = {
		commands: {
			getCommands: async () => commands,
			executeCommand: async (command: string, argument?: unknown) => {
				calls.push({ command, argument });
				if (command === '_chat.voice.switchToSession') {return true;}
				if (command === '_chat.voice.getCurrentSession') {return resource.toString();}
				return undefined;
			},
		},
	};
	const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = (request, parent, isMain) => request === 'vscode'
		? vscode
		: originalLoad(request, parent, isMain);
	try {
		delete require.cache[require.resolve('../chatBridge')];
		const bridge = require('../chatBridge') as typeof import('../chatBridge');
		await bridge.editAndResubmitPrompt(resource as never, 1, 3, 'Edited prompt');
	} finally {
		delete require.cache[require.resolve('../chatBridge')];
		moduleLoader._load = originalLoad;
	}

	assert.deepEqual(calls.map(call => call.command), [
		'_chat.voice.switchToSession',
		'_chat.voice.getCurrentSession',
		'workbench.action.chat.previousUserPrompt',
		'workbench.action.chat.previousUserPrompt',
		'workbench.action.chat.previousUserPrompt',
		'workbench.action.chat.nextUserPrompt',
		'workbench.action.chat.editRequests',
		'workbench.action.chat.submit',
	]);
	assert.equal(calls.at(-2)?.argument, undefined);
	assert.deepEqual(calls.at(-1)?.argument, { inputValue: 'Edited prompt' });
});