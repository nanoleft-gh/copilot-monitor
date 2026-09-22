import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface MonitorAddress {
	readonly port: number;
	readonly url: string;
}

suite('Copilot Monitor extension', () => {
	teardown(async () => {
		const commands = await vscode.commands.getCommands(true);
		if (commands.includes('githubCopilotMonitor.stop')) {
			await vscode.commands.executeCommand('githubCopilotMonitor.stop', false);
		}
	});

	test('activates and serves its tokenless aggregate dashboard', async () => {
		const extension = vscode.extensions.getExtension('nanoleft.githubcopilot-monitor');
		assert.ok(extension, 'Extension is installed in the development host.');
		await extension.activate();

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('githubCopilotMonitor.start'));
		assert.ok(commands.includes('githubCopilotMonitor.open'));

		const address = await vscode.commands.executeCommand<MonitorAddress>(
			'githubCopilotMonitor.start',
			{ silent: true },
		);
		assert.ok(address);
		assert.ok(address.port > 0);

		const pageResponse = await fetch(address.url);
		assert.equal(pageResponse.status, 200);
		assert.match(await pageResponse.text(), /<title>Copilot Monitor<\/title>/);

		const stateUrl = new URL(address.url);
		stateUrl.pathname = '/api/state';
		const stateResponse = await fetch(stateUrl);
		assert.equal(stateResponse.status, 200);
		const state = await stateResponse.json() as { version: number; windows: unknown[] };
		assert.equal(state.version, 2);
		assert.ok(Array.isArray(state.windows));
	});

	test('creates new local chats from the gateway and identifies each one', async function () {
		this.timeout(60_000);
		const commands = await vscode.commands.getCommands(true);
		if (!commands.includes('workbench.action.chat.newLocalChat')) {
			return; // Chat is not available in this test host.
		}
		console.log(`[probe] voice bridge available: ${commands.includes('_chat.voice.getCurrentSession')}`);
		const address = await vscode.commands.executeCommand<MonitorAddress>('githubCopilotMonitor.start', { silent: true });
		assert.ok(address);
		const base = new URL(address.url);
		// The gateway is machine-wide and may be owned by another VS Code; wait until it lists this window.
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		let windowId: string | undefined;
		for (let attempt = 0; attempt < 100 && !windowId; attempt++) {
			const state = await (await fetch(new URL('/api/state', base))).json() as { windows: Array<{ windowId: string; workspaceFolders: string[]; connected: boolean }> };
			windowId = state.windows.find(window => window.connected && window.workspaceFolders.some(candidate => candidate.toLowerCase() === folder.toLowerCase()))?.windowId;
			if (!windowId) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
		assert.ok(windowId, `this window (${folder}) is registered with the gateway`);

		// Hold an event stream open so the window counts a viewer and attaches its watchers.
		const abort = new AbortController();
		const events = await fetch(new URL('/api/events?v=2', base), { signal: abort.signal });
		assert.equal(events.status, 200);
		try {
			const create = async (id: string) => {
				const response = await fetch(new URL('/api/sessions/new', base), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, windowId }),
				});
				return { status: response.status, body: await response.json() as { sessionResource?: string; error?: string } };
			};
			const first = await create('it-new-1');
			// Without Copilot Chat there is no agent to run the persisting slash command, so VS Code
			// keeps the new chat in memory only; the API must then fail cleanly instead of hanging.
			const hasAgent = vscode.extensions.getExtension('GitHub.copilot-chat')?.packageJSON?.version !== '0.0.0';
			if (!hasAgent && first.status === 504) {
				console.log(`[probe] no chat agent in this host; creation reported: ${first.body.error}`);
				return;
			}
			assert.equal(first.status, 201, first.body.error);
			assert.ok(first.body.sessionResource?.startsWith('vscode-chat-session://local/'), `got ${first.body.sessionResource}`);
			const second = await create('it-new-2');
			assert.equal(second.status, 201, second.body.error);
			assert.notEqual(first.body.sessionResource, second.body.sessionResource, 'each new chat gets its own identity');

			const after = await (await fetch(new URL('/api/state', base))).json() as { windows: Array<{ windowId: string; activeSessionResource?: string; sessions: Array<{ resource: string; isEmpty?: boolean }> }> };
			const thisWindow = after.windows.find(window => window.windowId === windowId)!;
			assert.ok(thisWindow.sessions.some(session => session.resource === second.body.sessionResource), 'the created chat is listed for the viewer');
			assert.equal(thisWindow.activeSessionResource, second.body.sessionResource, 'the created chat is the selected one');
		} finally {
			abort.abort();
		}
	});
});