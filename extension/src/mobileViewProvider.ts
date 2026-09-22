import * as vscode from 'vscode';
import type { GatewayAddress } from './gatewayServer';
import type { RemoteAccessStatus, RemoteAccessUpdateRequest } from './protocol';

export const mobileViewId = 'githubCopilotMonitor.mobile';

export interface PairingAddress extends GatewayAddress {
	/** LAN URL carrying the pairing secret in its fragment; what the QR encodes. */
	readonly pairingUrl: string;
	/** Best remote address right now: the live tunnel, else the manual URL. */
	readonly remoteUrl?: string;
	readonly remotePairingUrl?: string;
	readonly remote: RemoteAccessStatus;
}

export interface MobileViewRuntime {
	/** Whether the monitor (and therefore a gateway address) currently exists for this window. */
	readonly running: boolean;
	start(notify?: boolean): Promise<GatewayAddress>;
	getPairingAddress(): Promise<PairingAddress>;
	/** Fires whenever the shared gateway address may have changed (election, failover, stop). */
	onDidChangeAddress(listener: () => void): vscode.Disposable;
	open(): Promise<void>;
	copyUrl(target?: 'local' | 'remote'): Promise<void>;
	updateRemoteAccess(request: RemoteAccessUpdateRequest): Promise<RemoteAccessStatus>;
	signInForRemoteAccess(): Promise<RemoteAccessStatus>;
	resetPairing(): Promise<void>;
}

type ViewMessage = { command?: unknown; value?: unknown };

/** While the owner window brings the tunnel up, re-read its state at this cadence (bounded by `maximumFollowUps`). */
const followUpDelayMs = 1_500;
const maximumFollowUps = 40;

export class MobileViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private refreshRunning: Promise<void> | undefined;
	private renderedUrl: string | undefined;
	private followUpTimer: NodeJS.Timeout | undefined;
	private followUpsLeft = 0;
	/** Which address the QR/link opens first; the app tries every address either way. */
	private qrTarget: 'local' | 'remote' = 'local';

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
		view.webview.onDidReceiveMessage((message: ViewMessage) => void this.handleMessage(message).catch(error => {
			void vscode.window.showErrorMessage(`Copilot Monitor: ${error instanceof Error ? error.message : String(error)}`);
		}));
		const addressSubscription = this.runtime.onDidChangeAddress(() => void this.refresh());
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this.refresh();
			}
		});
		view.onDidDispose(() => {
			addressSubscription.dispose();
			this.stopFollowUps();
			if (this.view === view) {
				this.view = undefined;
			}
		});
		view.webview.html = this.loadingHtml(view.webview);
		// Opening the view is an explicit request for the pairing address, so start on demand once.
		void this.startAndRefresh();
	}

	private async handleMessage(message: ViewMessage): Promise<void> {
		if (message.command === 'open') {
			await this.runtime.open();
			return;
		}
		if (message.command === 'copy') {
			await this.runtime.copyUrl(this.qrTarget);
			return;
		}
		if (message.command === 'qr:local' || message.command === 'qr:remote') {
			this.qrTarget = message.command === 'qr:remote' ? 'remote' : 'local';
			await this.refresh();
			return;
		}
		if (message.command === 'remote:enable') {
			await this.runtime.updateRemoteAccess({ enabled: true });
			await this.refreshAndFollowUp();
			return;
		}
		if (message.command === 'remote:disable') {
			await this.runtime.updateRemoteAccess({ enabled: false });
			await this.refresh();
			return;
		}
		if (message.command === 'remote:retry') {
			await this.runtime.updateRemoteAccess({ enabled: true, retry: true });
			await this.refreshAndFollowUp();
			return;
		}
		if (message.command === 'remote:signin') {
			await this.runtime.signInForRemoteAccess();
			await this.refreshAndFollowUp();
			return;
		}
		if (message.command === 'remote:copy') {
			const address = await this.runtime.getPairingAddress();
			if (address.remoteUrl) {
				await vscode.env.clipboard.writeText(address.remoteUrl);
				void vscode.window.showInformationMessage('Remote address copied.');
			}
			return;
		}
		if (message.command === 'remote:saveManual') {
			const value = typeof message.value === 'string' ? message.value.trim() : '';
			await this.runtime.updateRemoteAccess({ manualUrl: value || null });
			await this.refresh();
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

	/** The tunnel may be started by another window, which cannot notify this one; keep looking until it settles. */
	private async refreshAndFollowUp(): Promise<void> {
		this.stopFollowUps();
		this.followUpsLeft = maximumFollowUps;
		await this.refresh();
		this.scheduleFollowUp();
	}

	private scheduleFollowUp(): void {
		if (this.followUpsLeft <= 0 || !this.view?.visible) {
			return;
		}
		this.followUpsLeft--;
		this.followUpTimer = setTimeout(async () => {
			this.followUpTimer = undefined;
			await this.refresh();
			if (this.lastTunnelStatus === 'starting') {
				this.scheduleFollowUp();
			}
		}, followUpDelayMs);
	}

	private stopFollowUps(): void {
		if (this.followUpTimer) {
			clearTimeout(this.followUpTimer);
			this.followUpTimer = undefined;
		}
		this.followUpsLeft = 0;
	}

	private lastTunnelStatus: RemoteAccessStatus['tunnel']['status'] | undefined;

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
			this.lastTunnelStatus = address.remote.tunnel.status;
			if (!address.remotePairingUrl) {
				this.qrTarget = 'local';
			}
			const rendered = JSON.stringify([address.pairingUrl, address.remotePairingUrl, address.remote, this.qrTarget]);
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
		const remoteAvailable = !!address.remotePairingUrl && !!address.remoteUrl;
		const showRemote = remoteAvailable && this.qrTarget === 'remote';
		const qrContent = showRemote ? address.remotePairingUrl! : address.pairingUrl;
		const shownUrl = showRemote ? address.remoteUrl! : address.url;
		const targetPicker = remoteAvailable
			? `<div class="segmented" role="radiogroup" aria-label="Address the code opens">
				<button role="radio" aria-checked="${showRemote ? 'false' : 'true'}" class="${showRemote ? '' : 'on'}" data-command="qr:local">Home Wi-Fi</button>
				<button role="radio" aria-checked="${showRemote ? 'true' : 'false'}" class="${showRemote ? 'on' : ''}" data-command="qr:remote">Anywhere</button>
			</div>`
			: '';
		const hint = showRemote
			? 'Scan from anywhere. The app pairs through the tunnel and also learns the home address, so it switches to Wi-Fi when you are back.'
			: remoteAvailable
				? 'Scan while both devices share a Wi-Fi network. The code also carries the remote address, so the app can reach the computer once you leave.'
				: 'Scan with the Copilot Monitor app, or with your camera to open the browser dashboard, while both devices share a Wi-Fi network.';
		const body = `
			<div class="eyebrow"><span class="dot"></span>Shared gateway online</div>
			<h2>Open on your phone</h2>
			<p>${hint}</p>
			${targetPicker}
			<div id="qr" class="qr" aria-label="Pairing code for ${escapeHtml(shownUrl)}"></div>
			<code>${escapeHtml(shownUrl)}</code>
			<div class="actions">
				<button class="primary" data-command="open">Open dashboard</button>
				<button data-command="copy">Copy pairing link</button>
			</div>
			<div class="notice"><strong>Pairing secret</strong><br>The code and link carry this computer's secret; every request must present it. Once a phone is paired it stays paired across Wi-Fi drops and IP changes. <button class="link" data-command="reset">Reset secret</button></div>
			<h3>Remote access</h3>
			${this.remoteSection(address)}
		`;
		const script = `
			<script nonce="${nonce}" src="${qrScript}"></script>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				document.getElementById('qr').innerHTML = new QRCode({
					content: ${JSON.stringify(qrContent)}, padding: 2, width: 224, height: 224,
					color: '#111111', background: '#ffffff', ecl: 'M', join: true, container: 'svg-viewbox'
				}).svg();
				document.addEventListener('click', event => {
					const command = event.target.closest('[data-command]')?.dataset.command;
					if (command) vscode.postMessage({ command });
				});
				const manualForm = document.getElementById('manual-form');
				manualForm?.addEventListener('submit', event => {
					event.preventDefault();
					vscode.postMessage({ command: 'remote:saveManual', value: document.getElementById('manual-url').value });
				});
				document.getElementById('manual-clear')?.addEventListener('click', () => {
					vscode.postMessage({ command: 'remote:saveManual', value: '' });
				});
				document.getElementById('manual-toggle')?.addEventListener('click', () => {
					const details = document.getElementById('manual');
					details.hidden = !details.hidden;
					if (!details.hidden) document.getElementById('manual-url').focus();
				});
			</script>
		`;
		return this.document(webview, body, script, nonce);
	}

	private remoteSection(address: PairingAddress): string {
		const tunnel = address.remote.tunnel;
		const manual = address.remote.manualUrl;
		const manualBlock = `
			<div id="manual" ${manual ? '' : 'hidden'}>
				<p class="tight">Have your own route (Tailscale, Cloudflare Tunnel, a reverse proxy)? Paste the address that reaches <code class="inline">${escapeHtml(address.url)}</code> from the internet.</p>
				<form id="manual-form" class="manual-form">
					<input id="manual-url" type="url" placeholder="https://my-pc.tailnet.ts.net:${address.port}/" value="${escapeHtml(manual ?? '')}" spellcheck="false">
					<button type="submit">Save</button>
					${manual ? '<button type="button" id="manual-clear">Clear</button>' : ''}
				</form>
				${manual ? `<p class="tight ok"><span class="dot"></span>Phones also try <code class="inline">${escapeHtml(manual)}</code>.</p>` : ''}
			</div>`;
		const manualToggle = manual ? '' : '<button class="link" id="manual-toggle">Use my own address instead</button>';

		if (!address.remote.enabled) {
			const gatewayProblem = tunnel.status === 'error'
				? `<p class="warn">${escapeHtml(tunnel.error)}</p>`
				: '';
			return `
				${gatewayProblem}
				<p>Turn this on to reach the computer when the phone is not on your Wi-Fi. The gateway port is forwarded through a free Microsoft dev tunnel (the same service behind VS Code's Ports view) using your GitHub account; paired phones pick the address up on their own. Requests still need the pairing secret.</p>
				<div class="actions"><button class="primary" data-command="remote:enable">Turn on remote access</button></div>
				<p class="tight">${manualToggle}</p>
				${manualBlock}`;
		}

		let status: string;
		switch (tunnel.status) {
			case 'active':
				status = `
					<p class="ok"><span class="dot"></span>Reachable from anywhere</p>
					<code>${escapeHtml(tunnel.url)}</code>
					<p class="tight">Paired phones learn this address automatically and use it whenever your Wi-Fi is out of reach. Nothing to type on the phone.</p>
					<div class="actions"><button data-command="remote:copy">Copy remote address</button></div>`;
				break;
			case 'starting':
				status = `<p class="status"><span class="spinner"></span>Starting the dev tunnel…</p>`;
				break;
			case 'signin-required':
				status = `
					<p class="warn">Sign in to GitHub so VS Code can create the tunnel. Dev tunnels are free; the sign-in happens in your browser once.</p>
					<div class="actions"><button class="primary" data-command="remote:signin">Sign in with GitHub</button></div>`;
				break;
			case 'unavailable':
				status = `
					<p class="warn">${escapeHtml(tunnel.reason)} You can still use your own address below.</p>`;
				break;
			case 'error':
				status = `
					<p class="warn">${escapeHtml(tunnel.error)} Retrying in the background.</p>
					<div class="actions"><button data-command="remote:retry">Retry now</button></div>`;
				break;
			default:
				status = `
					<p class="status"><span class="spinner"></span>Preparing…</p>
					<div class="actions"><button data-command="remote:retry">Start now</button></div>`;
		}
		return `
			${status}
			<p class="tight"><button class="link" data-command="remote:disable">Turn off remote access</button>${manualToggle ? ` · ${manualToggle}` : ''}</p>
			${manualBlock}`;
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
			.segmented{display:grid;grid-template-columns:1fr 1fr;margin:0 auto 12px;width:min(224px,100%);border:1px solid var(--vscode-widget-border);border-radius:4px;overflow:hidden}.segmented button{min-height:28px;border:0;border-radius:0;background:transparent;color:var(--vscode-descriptionForeground)}.segmented button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.segmented button:hover:not(.on){background:var(--vscode-toolbar-hoverBackground)}
			code{display:block;overflow-wrap:anywhere;padding:9px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-textCodeBlock-background);font-size:11px}code.inline{display:inline;padding:1px 4px}
			.ok{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--vscode-foreground);margin-bottom:8px}.warn{color:var(--vscode-editorWarning-foreground,var(--vscode-foreground))}.tight{margin-bottom:8px}
			.manual-form{display:grid;grid-template-columns:1fr auto auto;gap:6px;margin:6px 0 10px}.manual-form input{min-width:0;min-height:30px;padding:0 8px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:2px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit;font-size:12px}.manual-form input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.manual-form button{padding:0 10px}
			.actions{display:grid;gap:8px;margin-top:12px}button{min-height:32px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.primary:hover{background:var(--vscode-button-hoverBackground)}
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