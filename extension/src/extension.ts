import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GatewayCoordinator } from './gatewayCoordinator';
import { GatewayAddress } from './gatewayServer';
import { getOrCreateHostIdentity, getSharedStateDirectory } from './hostIdentity';
import { findLanAddress } from './lanAddress';
import { MonitorServer, MonitorServerAddress } from './monitorServer';
import { MobileViewProvider, mobileViewId } from './mobileViewProvider';
import { SessionMonitor } from './sessionMonitor';
import { WindowRegistry } from './windowRegistry';

const defaultGatewayPort = 43_121;

class MonitorRuntime implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('Copilot Monitor');
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	private readonly windowId = randomUUID();
	private monitor: SessionMonitor | undefined;
	private localServer: MonitorServer | undefined;
	private registry: WindowRegistry | undefined;
	private gateway: GatewayCoordinator | undefined;
	private address: GatewayAddress | undefined;
	private startPromise: Promise<GatewayAddress> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar.command = 'githubCopilotMonitor.open';
		this.statusBar.text = '$(radio-tower) Copilot Monitor';
		this.statusBar.tooltip = 'Open the Copilot Monitor dashboard';
	}

	async start(notify = true): Promise<GatewayAddress> {
		if (this.address) {
			const address = await this.getCurrentAddress();
			if (notify) {
				await this.showStartedMessage(address);
			}
			return address;
		}
		if (this.startPromise) {
			return this.startPromise;
		}

		this.startPromise = this.startServer();
		try {
			const address = await this.startPromise;
			if (notify) {
				await this.showStartedMessage(address);
			}
			return address;
		} finally {
			this.startPromise = undefined;
		}
	}

	async stop(notify = true): Promise<void> {
		const localServer = this.localServer;
		const registry = this.registry;
		const gateway = this.gateway;
		this.localServer = undefined;
		this.registry = undefined;
		this.gateway = undefined;
		this.address = undefined;
		this.statusBar.hide();
		await vscode.commands.executeCommand('setContext', 'githubCopilotMonitor.running', false);
		await registry?.stop();
		await localServer?.stop();
		this.monitor?.dispose();
		this.monitor = undefined;
		await gateway?.stop();
		this.output.appendLine('Dashboard stopped.');
		if (notify) {
			void vscode.window.showInformationMessage('Copilot Monitor stopped.');
		}
	}

	async open(): Promise<void> {
		const address = await this.start(false);
		await vscode.env.openExternal(vscode.Uri.parse(address.url));
	}

	async copyUrl(): Promise<void> {
		const address = await this.start(false);
		await vscode.env.clipboard.writeText(address.url);
		void vscode.window.showInformationMessage('Copilot Monitor URL copied.');
	}

	async getCurrentAddress(): Promise<GatewayAddress> {
		if (!this.gateway) {
			return this.start(false);
		}
		const address = await this.gateway.resolveAddress();
		this.address = address;
		this.statusBar.tooltip = `Copilot Monitor · ${address.url}`;
		return address;
	}

	dispose(): void {
		void this.stop(false);
		this.statusBar.dispose();
		this.output.dispose();
	}

	private async startServer(): Promise<GatewayAddress> {
		const configuration = vscode.workspace.getConfiguration('githubCopilotMonitor');
		const configuredPort = configuration.get<number>('port', defaultGatewayPort);
		const gatewayPort = Number.isInteger(configuredPort) && configuredPort > 0
			? configuredPort
			: defaultGatewayPort;

		const html = await fs.readFile(this.context.asAbsolutePath('media/dashboard.html'), 'utf8');
		const mermaidScript = await fs.readFile(
			this.context.asAbsolutePath('media/vendor/mermaid-11.16.0.min.js'),
			'utf8',
		);
		const iconSvg = await fs.readFile(this.context.asAbsolutePath('public/icon.svg'), 'utf8');
		const monitor = new SessionMonitor(this.context, this.windowId);
		const localServer = new MonitorServer(monitor, {
			host: '127.0.0.1',
			port: 0,
			mermaidScript,
			iconSvg,
		});
		const sharedStateDirectory = getSharedStateDirectory();
		const hostIdentity = await getOrCreateHostIdentity(sharedStateDirectory);
		const registryDirectory = path.join(sharedStateDirectory, 'windows');
		const registry = new WindowRegistry(registryDirectory, this.windowId);
		const gateway = new GatewayCoordinator({
			registryDirectory,
			registryId: hostIdentity.hostId,
			leaseDirectory: sharedStateDirectory,
			hostId: hostIdentity.hostId,
			ownerId: this.windowId,
			port: gatewayPort,
			advertisedHost: findLanAddress(),
			html,
			mermaidScript,
			iconSvg,
		});
		try {
			const localAddress: MonitorServerAddress = await localServer.start();
			const localState = monitor.getState();
			await registry.start({
				hostId: hostIdentity.hostId,
				productName: vscode.env.appName,
				productVersion: vscode.version,
				localPort: localAddress.port,
				workspaceName: localState.workspaceName,
				workspaceFolders: localState.workspaceFolders,
				startedAt: localState.startedAt,
				pid: process.pid,
			});
			const address = await gateway.start();
			this.monitor = monitor;
			this.localServer = localServer;
			this.registry = registry;
			this.gateway = gateway;
			this.address = address;
			this.statusBar.tooltip = `Copilot Monitor · ${address.url}`;
			this.statusBar.show();
			await vscode.commands.executeCommand('setContext', 'githubCopilotMonitor.running', true);
			this.output.appendLine(`Window bridge listening at http://127.0.0.1:${localAddress.port}/`);
			this.output.appendLine(`Shared dashboard available at ${address.url}`);
			return address;
		} catch (error) {
			await registry.stop();
			await gateway.stop();
			monitor.dispose();
			await localServer.stop().catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(`Failed to start: ${message}`);
			void vscode.window.showErrorMessage(`Copilot Monitor could not start: ${message}`);
			throw error;
		}
	}

	private async showStartedMessage(address: GatewayAddress): Promise<void> {
		const action = await vscode.window.showInformationMessage(
			`Copilot Monitor is running on ${address.url}`,
			'Open Dashboard',
			'Copy URL',
		);
		if (action === 'Open Dashboard') {
			await this.open();
		} else if (action === 'Copy URL') {
			await this.copyUrl();
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const runtime = new MonitorRuntime(context);
	context.subscriptions.push(runtime);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(
		mobileViewId,
		new MobileViewProvider(context.extensionUri, runtime),
	));
	context.subscriptions.push(vscode.commands.registerCommand(
		'githubCopilotMonitor.start',
		(options?: { silent?: boolean }) => runtime.start(options?.silent !== true),
	));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.stop', () => runtime.stop()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.open', () => runtime.open()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.copyUrl', () => runtime.copyUrl()));

	if (vscode.workspace.getConfiguration('githubCopilotMonitor').get<boolean>('autoStart', true)) {
		void runtime.start(false);
	}
}

export function deactivate() {}
