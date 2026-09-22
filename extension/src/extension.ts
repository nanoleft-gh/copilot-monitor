import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GatewayCoordinator } from './gatewayCoordinator';
import { pairingUrl } from './gatewayAuth';
import { GatewayAddress } from './gatewayServer';
import { getOrCreateHostIdentity, getOrCreatePairingSecret, getSharedStateDirectory, resetPairingSecret } from './hostIdentity';
import { findLanAddress, findLanAddresses } from './lanAddress';
import { MonitorServer, MonitorServerAddress } from './monitorServer';
import { MobileViewProvider, mobileViewId, type PairingAddress } from './mobileViewProvider';
import { RemoteTunnel, readProductInfo, resolveTunnelCli, tunnelCliCandidates } from './remoteTunnel';
import { SessionMonitor } from './sessionMonitor';
import { WindowRegistry } from './windowRegistry';

const defaultGatewayPort = 43_121;

function isLanUrl(value: string): boolean {
	try {
		const { hostname } = new URL(value);
		return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(hostname) || hostname === 'localhost' || hostname.endsWith('.local');
	} catch {
		return false;
	}
}

/** Normalises the user's remote access setting to an origin with a trailing slash, or nothing when unusable. */
export function normalizeRemoteUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
			return undefined;
		}
		url.pathname = '/';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return undefined;
	}
}

function readRemoteUrl(): string | undefined {
	return normalizeRemoteUrl(vscode.workspace.getConfiguration('githubCopilotMonitor').get<string>('remoteUrl'));
}

function readRemoteAccessEnabled(): boolean {
	return vscode.workspace.getConfiguration('githubCopilotMonitor').get<boolean>('remoteAccess', false) === true;
}

const githubScopes = ['user:email', 'read:org'];

class MonitorRuntime implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('Copilot Monitor');
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	private readonly addressChanged = new vscode.EventEmitter<void>();
	private readonly windowId = randomUUID();
	private monitor: SessionMonitor | undefined;
	private localServer: MonitorServer | undefined;
	private registry: WindowRegistry | undefined;
	private gateway: GatewayCoordinator | undefined;
	private gatewayAddressSubscription: { dispose(): void } | undefined;
	private address: GatewayAddress | undefined;
	private pairingSecret: string | undefined;
	private startPromise: Promise<GatewayAddress> | undefined;
	private readonly tunnel: RemoteTunnel;
	readonly onDidChangeAddress = this.addressChanged.event;

	get running(): boolean {
		return this.gateway !== undefined || this.startPromise !== undefined;
	}

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar.command = 'githubCopilotMonitor.open';
		this.statusBar.text = '$(radio-tower) Copilot Monitor';
		this.statusBar.tooltip = 'Open the Copilot Monitor dashboard';
		this.tunnel = new RemoteTunnel({
			resolveCommand: async () => {
				const product = await readProductInfo(vscode.env.appRoot);
				return resolveTunnelCli(tunnelCliCandidates(vscode.env.appRoot, product.quality, product.commit));
			},
			getAccessToken: async interactive => {
				const session = await vscode.authentication.getSession('github', githubScopes, interactive ? { createIfNone: true } : { silent: true });
				return session?.accessToken;
			},
			log: message => this.output.appendLine(message),
		});
		context.subscriptions.push(this.tunnel.onDidChangeState(() => this.addressChanged.fire()));
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('githubCopilotMonitor.remoteUrl') || event.affectsConfiguration('githubCopilotMonitor.remoteAccess')) {
				void this.syncRemoteTunnel();
				this.addressChanged.fire();
			}
		}));
		context.subscriptions.push(vscode.authentication.onDidChangeSessions(event => {
			if (event.provider.id === 'github' && this.tunnel.state.status === 'signin-required') {
				void this.syncRemoteTunnel();
			}
		}));
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
		this.gatewayAddressSubscription?.dispose();
		this.gatewayAddressSubscription = undefined;
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
		await this.tunnel.stop();
		this.output.appendLine('Dashboard stopped.');
		this.addressChanged.fire();
		if (notify) {
			void vscode.window.showInformationMessage('Copilot Monitor stopped.');
		}
	}

	async open(): Promise<void> {
		const address = await this.getPairingAddress();
		await vscode.env.openExternal(vscode.Uri.parse(address.pairingUrl));
	}

	async copyUrl(): Promise<void> {
		const address = await this.getPairingAddress();
		await vscode.env.clipboard.writeText(address.pairingUrl);
		void vscode.window.showInformationMessage('Copilot Monitor pairing link copied. It contains this computer\'s pairing secret; share it only with your own devices.');
	}

	async setRemoteUrl(): Promise<void> {
		const configuration = vscode.workspace.getConfiguration('githubCopilotMonitor');
		const value = await vscode.window.showInputBox({
			title: 'Copilot Monitor: Manual Remote URL',
			prompt: 'Paste a public address that reaches this computer\'s gateway (Tailscale, Cloudflare Tunnel, your own proxy). Leave empty to clear. Prefer the automatic tunnel in the Copilot Monitor sidebar.',
			placeHolder: 'https://my-pc.tailnet-name.ts.net:43121/',
			value: configuration.get<string>('remoteUrl') ?? '',
			ignoreFocusOut: true,
			validateInput: input => input.trim() && !normalizeRemoteUrl(input) ? 'Enter an http(s) URL without credentials.' : undefined,
		});
		if (value === undefined) {
			return;
		}
		await this.saveManualRemoteUrl(value);
	}

	async saveManualRemoteUrl(value: string): Promise<void> {
		if (value.trim() && !normalizeRemoteUrl(value)) {
			throw new Error('Enter an http(s) URL without credentials.');
		}
		await vscode.workspace.getConfiguration('githubCopilotMonitor').update('remoteUrl', normalizeRemoteUrl(value) ?? '', vscode.ConfigurationTarget.Global);
	}

	async setRemoteAccess(enabled: boolean): Promise<void> {
		await vscode.workspace.getConfiguration('githubCopilotMonitor').update('remoteAccess', enabled, vscode.ConfigurationTarget.Global);
		await this.syncRemoteTunnel(enabled);
	}

	/** Runs the sign-in flow if needed and (re)starts the tunnel; the user asked for it, so prompts are fine. */
	async retryRemoteAccess(): Promise<void> {
		if (!readRemoteAccessEnabled()) {
			await this.setRemoteAccess(true);
			return;
		}
		await this.syncRemoteTunnel(true);
	}

	/** The gateway owner runs the tunnel; followers show the address it advertises. */
	private async syncRemoteTunnel(interactive = false): Promise<void> {
		const port = this.address?.port;
		if (readRemoteAccessEnabled() && this.gateway?.isLeader && port) {
			if (interactive && this.tunnel.state.status !== 'active' && this.tunnel.state.status !== 'starting') {
				await this.tunnel.stop();
			}
			await this.tunnel.start(port, interactive);
		} else {
			await this.tunnel.stop();
		}
	}

	/** Remote (non-LAN) addresses the gateway currently advertises, whichever window owns it. */
	private async readAdvertisedRemoteUrls(port: number): Promise<string[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1_000);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
			if (!response.ok) {
				return [];
			}
			const value = await response.json() as { endpoints?: unknown };
			return Array.isArray(value.endpoints)
				? value.endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string' && !isLanUrl(endpoint))
				: [];
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
		}
	}

	async resetPairing(): Promise<void> {
		const confirmed = await vscode.window.showWarningMessage(
			'Reset the pairing secret? Every paired phone and browser will need to scan the new code.',
			{ modal: true },
			'Reset',
		);
		if (confirmed !== 'Reset') {
			return;
		}
		const wasRunning = this.running;
		await this.stop(false);
		await resetPairingSecret(getSharedStateDirectory());
		this.pairingSecret = undefined;
		if (wasRunning) {
			await this.start(false);
		}
		void vscode.window.showInformationMessage('Copilot Monitor pairing secret reset. Other open VS Code windows pick it up when their monitor restarts.');
	}

	async getCurrentAddress(): Promise<GatewayAddress> {
		if (!this.gateway) {
			return this.start(false);
		}
		const resolved = await this.gateway.resolveAddress();
		const address = {
			...resolved,
			url: `http://${findLanAddress()}:${resolved.port}/`,
		};
		this.address = address;
		this.statusBar.tooltip = `Copilot Monitor · ${address.url}`;
		return address;
	}

	async getPairingAddress(): Promise<PairingAddress> {
		const address = await this.getCurrentAddress();
		const secret = this.pairingSecret ?? await getOrCreatePairingSecret(getSharedStateDirectory());
		const manualRemoteUrl = readRemoteUrl();
		const isLeader = this.gateway?.isLeader === true;
		const tunnelUrl = this.tunnel.state.status === 'active' ? this.tunnel.state.url : undefined;
		const advertised = isLeader ? [] : await this.readAdvertisedRemoteUrls(address.port);
		const remoteUrl = tunnelUrl ?? advertised.find(url => url !== manualRemoteUrl) ?? manualRemoteUrl;
		return {
			...address,
			pairingUrl: pairingUrl(address.url, secret),
			...(remoteUrl ? { remoteUrl, remotePairingUrl: pairingUrl(remoteUrl, secret) } : {}),
			...(manualRemoteUrl ? { manualRemoteUrl } : {}),
			remoteAccessEnabled: readRemoteAccessEnabled(),
			isLeader,
			tunnel: isLeader ? this.tunnel.state : advertised.length > 0 ? { status: 'active', url: advertised[0] } : { status: 'inactive' },
		};
	}

	dispose(): void {
		void this.stop(false);
		this.tunnel.dispose();
		this.addressChanged.dispose();
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
		const mermaidScript = (await fs.readFile(
			this.context.asAbsolutePath('media/vendor/mermaid-11.16.0.min.js'),
			'utf8',
		)).replaceAll('Function("return this")()', 'globalThis');
		const iconSvg = await fs.readFile(this.context.asAbsolutePath('public/icon.svg'), 'utf8');
		const monitor = new SessionMonitor(
			this.context,
			this.windowId,
			message => this.output.appendLine(message),
		);
		const localServer = new MonitorServer(monitor, {
			host: '127.0.0.1',
			port: 0,
			mermaidScript,
			iconSvg,
		});
		const sharedStateDirectory = getSharedStateDirectory();
		const hostIdentity = await getOrCreateHostIdentity(sharedStateDirectory);
		const pairingSecret = await getOrCreatePairingSecret(sharedStateDirectory);
		this.pairingSecret = pairingSecret;
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
			readPairingSecret: () => getOrCreatePairingSecret(sharedStateDirectory),
			getEndpoints: port => {
				const remoteUrl = readRemoteUrl();
				const tunnelUrl = this.tunnel.state.status === 'active' ? this.tunnel.state.url : undefined;
				return [
					...findLanAddresses().map(address => `http://${address}:${port}/`),
					...(tunnelUrl ? [tunnelUrl] : []),
					...(remoteUrl && remoteUrl !== tunnelUrl ? [remoteUrl] : []),
				];
			},
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
			this.gatewayAddressSubscription = gateway.onDidChangeAddress(() => {
				this.output.appendLine('Shared gateway address changed.');
				this.address = gateway.address;
				void this.syncRemoteTunnel();
				this.addressChanged.fire();
			});
			this.statusBar.tooltip = `Copilot Monitor · ${address.url}`;
			this.statusBar.show();
			await vscode.commands.executeCommand('setContext', 'githubCopilotMonitor.running', true);
			this.output.appendLine(`Internal bridge for this window: http://127.0.0.1:${localAddress.port}/ (not a pairing address)`);
			this.output.appendLine(`Machine-wide pairing address: ${address.url}`);
			void this.syncRemoteTunnel();
			this.addressChanged.fire();
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
			'Copy Pairing Link',
		);
		if (action === 'Open Dashboard') {
			await this.open();
		} else if (action === 'Copy Pairing Link') {
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
		async (options?: { silent?: boolean }) => {
			await runtime.start(options?.silent !== true);
			return runtime.getPairingAddress();
		},
	));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.stop', () => runtime.stop()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.open', () => runtime.open()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.copyUrl', () => runtime.copyUrl()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.setRemoteUrl', () => runtime.setRemoteUrl()));
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.resetPairing', () => runtime.resetPairing()));

	if (vscode.workspace.getConfiguration('githubCopilotMonitor').get<boolean>('autoStart', true)) {
		void runtime.start(false);
	}
}

export function deactivate() {}
