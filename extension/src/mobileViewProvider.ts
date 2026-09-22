import * as vscode from 'vscode';
import type { GatewayAddress } from './gatewayServer';

export const mobileViewId = 'githubCopilotMonitor.mobile';

export interface PairingAddress extends GatewayAddress {
	/** LAN URL carrying the pairing secret in its fragment; what the QR encodes. */
	readonly pairingUrl: string;
	readonly remoteUrl?: string;
	readonly remotePairingUrl?: string;
}

export interface MobileViewRuntime {
	/** Whether the monitor (and therefore a gateway address) currently exists for this window. */
	readonly running: boolean;
	start(notify?: boolean): Promise<GatewayAddress>;
	getPairingAddress(): Promise<PairingAddress>;
	/** Fires whenever the shared gateway address may have changed (election, failover, stop). */
	onDidChangeAddress(listener: () => void): vscode.Disposable;
	open(): Promise<void>;
	copyUrl(): Promise<void>;
	setRemoteUrl(): Promise<void>;
	resetPairing(): Promise<void>;
}

export class MobileViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private refreshRunning: Promise<void> | undefined;
	private renderedUrl: string | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runtime: MobileViewRuntime,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.renderedUrl = undefined;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor')],
		};
		view.webview.onDidReceiveMessage((message: { command?: unknown }) => void this.handleMessage(message));
		const addressSubscription = this.runtime.onDidChangeAddress(() => void this.refresh());
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this.refresh();
			}
		});
		view.onDidDispose(() => {
			addressSubscription.dispose();
			if (this.view === view) {
				this.view = undefined;
			}
		});
		view.webview.html = this.loadingHtml(view.webview);
		// Opening the view is an explicit request for the pairing address, so start on demand once.
		void this.startAndRefresh();
	}

	private async handleMessage(message: { command?: unknown }): Promise<void> {
		if (message.command === 'open') {
			await this.runtime.open();
			return;
		}
		if (message.command === 'copy') {
			await this.runtime.copyUrl();
			return;
		}
		if (message.command === 'remote') {
			await this.runtime.setRemoteUrl();
			return;
		}
		if (message.command === 'ports') {
			try {
				await vscode.commands.executeCommand('~remote.forwardedPorts.focus');
			} catch {
				void vscode.window.showInformationMessage('Open the Ports view from the Panel (View > Open View... > Ports) and choose "Forward a Port".');
			}
			return;
		}
		if (message.command === 'reset') {
			await this.runtime.resetPairing();
			return;
		}
		if (message.command === 'start') {
			await this.startAndRefresh();
		}
	}

	private async startAndRefresh(): Promise<void> {
		const view = this.view;
		try {
			await this.runtime.start(false);
		} catch (error) {
			if (this.view === view && view) {
				this.renderedUrl = undefined;
				view.webview.html = this.errorHtml(view.webview, error instanceof Error ? error.message : String(error));
			}
			return;
		}
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.refreshRunning) {
			return this.refreshRunning;
		}
		this.refreshRunning = this.refreshNow();
		try {
			await this.refreshRunning;
		} finally {
			this.refreshRunning = undefined;
		}
	}

	private async refreshNow(): Promise<void> {
		const view = this.view;
		if (!view) {
			return;
		}
		if (!this.runtime.running) {
			this.renderedUrl = undefined;
			view.webview.html = this.stoppedHtml(view.webview);
			return;
		}
		try {
			const address = await this.runtime.getPairingAddress();
			const rendered = `${address.pairingUrl}|${address.remotePairingUrl ?? ''}`;
			if (this.view === view && this.renderedUrl !== rendered) {
				this.renderedUrl = rendered;
				view.webview.html = this.readyHtml(view.webview, address);
			}
		} catch (error) {
			if (this.view === view) {
				this.renderedUrl = undefined;
				view.webview.html = this.errorHtml(view.webview, error instanceof Error ? error.message : String(error));
			}
		}
	}

	private loadingHtml(webview: vscode.Webview): string {
		return this.document(webview, '<div class="status"><span class="spinner"></span>Starting shared gateway...</div>');
	}

	private stoppedHtml(webview: vscode.Webview): string {
		return this.document(webview, `
			<div class="eyebrow">Mobile access</div>
			<h2>Monitor stopped</h2>
			<p>Start the monitor to get a pairing address for your phone.</p>
			<button class="primary" data-command="start">Start monitor</button>
		`);
	}

	private errorHtml(webview: vscode.Webview, message: string): string {
		return this.document(webview, `
			<div class="eyebrow">Mobile access</div>
			<h2>Gateway unavailable</h2>
			<p>${escapeHtml(message)}</p>
			<button class="primary" data-command="start">Try again</button>
		`);
	}

	private readyHtml(webview: vscode.Webview, address: PairingAddress): string {
		const qrScript = webview.asWebviewUri(vscode.Uri.joinPath(
			this.extensionUri, 'media', 'vendor', 'qrcode-svg-1.1.0.min.js',
		));
		const nonce = createNonce();
		const remote = address.remoteUrl
			? `<p class="remote-on"><span class="dot"></span>Away from home: <code class="inline">${escapeHtml(address.remoteUrl)}</code></p>
				<p>Paired phones switch to this address on their own when your Wi-Fi is out of reach.</p>
				<div class="actions"><button data-command="remote">Change remote URL</button></div>`
			: `<p>Reach this computer from anywhere: forward port <strong>${address.port}</strong> in the <strong>Ports</strong> view, set its visibility to <em>Public</em>, then paste the Forwarded Address here. Paired phones learn it automatically the next time they connect at home. A Tailscale or Cloudflare Tunnel URL works too.</p>
				<div class="actions"><button data-command="ports">Open Ports view</button><button data-command="remote">Set remote URL</button></div>`;
		const body = `
			<div class="eyebrow"><span class="dot"></span>Shared gateway online</div>
			<h2>Open on your phone</h2>
			<p>Scan with the Copilot Monitor app, or with your camera to open the browser dashboard, while both devices share a Wi-Fi network.</p>
			<div id="qr" class="qr" aria-label="Pairing code for ${escapeHtml(address.url)}"></div>
			<code>${escapeHtml(address.url)}</code>
			<div class="actions">
				<button class="primary" data-command="open">Open dashboard</button>
				<button data-command="copy">Copy pairing link</button>
			</div>
			<div class="notice"><strong>Pairing secret</strong><br>The code and link carry this computer's secret; every request must present it. Once a phone is paired it stays paired across Wi-Fi drops and IP changes. <button class="link" data-command="reset">Reset secret</button></div>
			<h3>Remote access</h3>
			${remote}
		`;
		const script = `
			<script nonce="${nonce}" src="${qrScript}"></script>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				document.getElementById('qr').innerHTML = new QRCode({
					content: ${JSON.stringify(address.pairingUrl)}, padding: 2, width: 224, height: 224,
					color: '#111111', background: '#ffffff', ecl: 'M', join: true, container: 'svg-viewbox'
				}).svg();
				document.addEventListener('click', event => {
					const command = event.target.closest('[data-command]')?.dataset.command;
					if (command) vscode.postMessage({ command });
				});
			</script>
		`;
		return this.document(webview, body, script, nonce);
	}

	private document(webview: vscode.Webview, body: string, script = '', nonce = createNonce()): string {
		return `<!doctype html>
		<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
		<style>
			*{box-sizing:border-box}body{margin:0;padding:20px 16px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px/1.45 var(--vscode-font-family)}
			.eyebrow{display:flex;align-items:center;gap:7px;color:var(--vscode-descriptionForeground);font-size:11px;text-transform:uppercase}.dot{width:7px;height:7px;border-radius:50%;background:#22c55e}
			h2{margin:10px 0 6px;font-size:18px;letter-spacing:0}h3{margin:22px 0 6px;font-size:13px;text-transform:uppercase;color:var(--vscode-descriptionForeground)}p{margin:0 0 16px;color:var(--vscode-descriptionForeground)}
			.qr{width:min(224px,100%);aspect-ratio:1;margin:0 auto 14px;padding:8px;border-radius:6px;background:#fff}.qr svg{display:block;width:100%;height:100%}
			code{display:block;overflow-wrap:anywhere;padding:9px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-textCodeBlock-background);font-size:11px}code.inline{display:inline;padding:1px 4px}
			.remote-on{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--vscode-foreground)}
			.actions{display:grid;gap:8px;margin-top:12px}button{min-height:32px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.primary:hover{background:var(--vscode-button-hoverBackground)}
			button.link{min-height:0;padding:0;border:0;background:none;color:var(--vscode-textLink-foreground);text-decoration:underline}button.link:hover{background:none}
			.notice{margin-top:16px;padding:10px;border-left:2px solid var(--vscode-focusBorder);color:var(--vscode-descriptionForeground);background:var(--vscode-textBlockQuote-background)}
			.status{display:flex;align-items:center;gap:9px;color:var(--vscode-descriptionForeground)}.spinner{width:13px;height:13px;border:2px solid var(--vscode-widget-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
		</style></head><body>${body}${script}</body></html>`;
	}
}

function createNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]!);
}