import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/extension.integration.test.js',
	version: 'insiders',
	useInstallation: process.env.VSCODE_INSIDERS_PATH
		? { fromPath: process.env.VSCODE_INSIDERS_PATH }
		: undefined,
	workspaceFolder: '.',
});
