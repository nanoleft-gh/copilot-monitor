import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GatewayCoordinator } from './gatewayCoordinator';
import { pairingUrl } from './gatewayAuth';
import { GatewayAddress, RemoteAccessController } from './gatewayServer';
import { getOrCreateHostIdentity, getOrCreatePairingSecret, getSharedStateDirectory, resetPairingSecret } from './hostIdentity';
import { findLanAddress, findLanAddresses } from './lanAddress';
import { MonitorServer, MonitorServerAddress } from './monitorServer';
import { MobileViewProvider, mobileViewId, type PairingAddress } from './mobileViewProvider';
import { MonitorRequestError, type RemoteAccessStatus, type RemoteAccessUpdateRequest } from './protocol';
import { readRemoteAccessPreferences, writeRemoteAccessPreferences, type RemoteAccessPreferences } from './remoteAccessStore';
import { RemoteTunnel, readProductInfo, resolveTunnelCli, tunnelCliCandidates } from './remoteTunnel';
import { SessionMonitor } from './sessionMonitor';
import { WindowRegistry } from './windowRegistry';

const defaultGatewayPort = 43_121;

/** Normalises a user-supplied remote address to an origin with a trailing slash, or nothing when unusable. */
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

const githubScopes = ['user:email', 'read:org'];
const gatewayRequestTimeoutMs = 5_000;

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
	/** Last preferences this window read or wrote; refreshed from disk when the tunnel is (re)synced. */
	private remotePreferences: RemoteAccessPreferences = { version: 1, enabled: false };
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

	async copyUrl(target: 'local' | 'remote' = 'local'): Promise<void> {
		const address = await this.getPairingAddress();
		const link = target === 'remote' && address.remotePairingUrl ? address.remotePairingUrl : address.pairingUrl;
		await vscode.env.clipboard.writeText(link);
		void vscode.window.showInformationMessage('Copilot Monitor pairing link copied. It contains this computer\'s pairing secret; share it only with your own devices.');
	}

	// #region remote access

	/**
	 * Remote access is machine-wide and owned by the gateway window, so every window (this one
	 * included) changes it through the gateway API. State lives in the shared directory, not in
	 * VS Code settings, so it needs no registered configuration and survives window reloads.
	 */
	async getRemoteAccess(): Promise<RemoteAccessStatus> {
		const address = await this.getCurrentAddress();
		return this.gatewayRequest<RemoteAccessStatus>(address.port, 'GET');
	}

	async updateRemoteAccess(request: RemoteAccessUpdateRequest): Promise<RemoteAccessStatus> {
		if (typeof request.manualUrl === 'string' && request.manualUrl.trim() && !normalizeRemoteUrl(request.manualUrl)) {
			throw new Error('Enter an http(s) URL without credentials.');
		}
		const address = await this.getCurrentAddress();
		return this.gatewayRequest<RemoteAccessStatus>(address.port, 'POST', request);
	}

	/** Signs in here (accounts are shared by all windows), then asks the gateway owner to retry. */
	async signInForRemoteAccess(): Promise<RemoteAccessStatus> {
		await vscode.authentication.getSession('github', githubScopes, { createIfNone: true });
		return this.updateRemoteAccess({ enabled: true, retry: true });
	}

	/** Handlers the gateway server calls; they run only in the window that owns the gateway. */
	private readonly remoteAccessController: RemoteAccessController = {
		get: async () => this.remoteAccessStatus(await this.loadRemotePreferences()),
		update: async request => {
			const current = await this.loadRemotePreferences();
			const manualUrl = request.manualUrl === undefined
				? current.manualUrl
				: request.manualUrl === null ? undefined : normalizeRemoteUrl(request.manualUrl);
			if (request.manualUrl && !manualUrl) {
				throw new MonitorRequestError(400, 'Enter an http(s) URL without credentials.');
			}
			const next: RemoteAccessPreferences = {
				version: 1,
				enabled: request.enabled ?? current.enabled,
				...(manualUrl ? { manualUrl } : {}),
			};
			await writeRemoteAccessPreferences(getSharedStateDirectory(), next);
			this.remotePreferences = next;
			if (request.retry && next.enabled) {
				await this.tunnel.stop();
			}
			await this.syncRemoteTunnel();
			this.addressChanged.fire();
			return this.remoteAccessStatus(next);
		},
	};

	private remoteAccessStatus(preferences: RemoteAccessPreferences): RemoteAccessStatus {
		return {
			enabled: preferences.enabled,
			...(preferences.manualUrl ? { manualUrl: preferences.manualUrl } : {}),
			tunnel: this.tunnel.state,
		};
	}

	private async loadRemotePreferences(): Promise<RemoteAccessPreferences> {
		this.remotePreferences = await readRemoteAccessPreferences(getSharedStateDirectory());
		return this.remotePreferences;
	}

	/** Only the gateway owner runs the tunnel; called on start, leadership change, and preference change. */
	private async syncRemoteTunnel(): Promise<void> {
		const port = this.address?.port;
		if (this.gateway?.isLeader && port) {
			const preferences = await this.loadRemotePreferences();
			if (preferences.enabled) {
				await this.tunnel.start(port, false);
				return;
			}
		}
		await this.tunnel.stop();
	}

	private async gatewayRequest<T>(port: number, method: 'GET' | 'POST', body?: unknown): Promise<T> {
		const secret = this.pairingSecret ?? await getOrCreatePairingSecret(getSharedStateDirectory());
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), gatewayRequestTimeoutMs);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/remote-access`, {
				method,
				headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: controller.signal,
			});
			const value = await response.json().catch(() => ({})) as T & { error?: string };
			if (!response.ok) {
				throw new Error(value.error ?? `The shared gateway answered HTTP ${response.status}.`);
			}
			return value;
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error('The shared gateway did not respond.');
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	// #endregion

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
		const remote = await this.getRemoteAccess().catch((error: unknown): RemoteAccessStatus => ({
			enabled: false,
			tunnel: { status: 'error', error: error instanceof Error ? error.message : String(error) },
		}));
		const remoteUrl = remote.tunnel.status === 'active' ? remote.tunnel.url : remote.manualUrl;
		// Both codes carry every address, so a phone pairs whichever one is reachable at scan time.
		const everyAddress = [
			...findLanAddresses().map(lan => `http://${lan}:${address.port}/`),
			...(remote.tunnel.status === 'active' ? [remote.tunnel.url] : []),
			...(remote.manualUrl ? [remote.manualUrl] : []),
		];
		return {
			...address,
			pairingUrl: pairingUrl(address.url, secret, everyAddress),
			...(remoteUrl ? { remoteUrl, remotePairingUrl: pairingUrl(remoteUrl, secret, everyAddress) } : {}),
			remote,
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
				// Health is served by the owner, whose cached preferences are refreshed by every sync/update.
				const manualUrl = this.remotePreferences.manualUrl;
				const tunnelUrl = this.tunnel.state.status === 'active' ? this.tunnel.state.url : undefined;
				return [
					...findLanAddresses().map(address => `http://${address}:${port}/`),
					...(tunnelUrl ? [tunnelUrl] : []),
					...(manualUrl && manualUrl !== tunnelUrl ? [manualUrl] : []),
				];
			},
			remoteAccess: this.remoteAccessController,
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
	context.subscriptions.push(vscode.commands.registerCommand('githubCopilotMonitor.resetPairing', () => runtime.resetPairing()));

	if (vscode.workspace.getConfiguration('githubCopilotMonitor').get<boolean>('autoStart', true)) {
		void runtime.start(false);
	}
}

export function deactivate() {}
