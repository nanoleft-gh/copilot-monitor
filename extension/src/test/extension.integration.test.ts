import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface MonitorAddress {
	readonly port: number;
	readonly url: string;
}

suite('Copilot Monitor extension', () => {
	teardown(async () => {
		await vscode.commands.executeCommand('githubCopilotMonitor.stop', false);
	});

	test('activates and serves its tokenless aggregate dashboard', async () => {
		const extension = vscode.extensions.getExtension('maheshdoiphode.githubcopilot-monitor');
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
});