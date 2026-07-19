import * as vscode from 'vscode';
import type { GatewayAddress } from './gatewayServer';

export const mobileViewId = 'githubCopilotMonitor.mobile';

export interface MobileViewRuntime {
	start(notify?: boolean): Promise<GatewayAddress>;
	getCurrentAddress(): Promise<GatewayAddress>;
	open(): Promise<void>;
	copyUrl(): Promise<void>;
}

export class MobileViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private renderedUrl: string | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runtime: MobileViewRuntime,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor')],
		};
		view.webview.onDidReceiveMessage((message: { command?: unknown }) => void this.handleMessage(message));
		view.onDidChangeVisibility(() => this.updateRefreshTimer());
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
			}
			this.updateRefreshTimer();
		});
		view.webview.html = this.loadingHtml(view.webview);
		this.updateRefreshTimer();
		void this.refresh();
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
		if (message.command === 'refresh') {
			await this.refresh();
		}
	}

	private async refresh(): Promise<void> {
		const view = this.view;
		if (!view) {
			return;
		}
		try {
			await this.runtime.start(false);
			const address = await this.runtime.getCurrentAddress();
			if (this.view === view && this.renderedUrl !== address.url) {
				this.renderedUrl = address.url;
				view.webview.html = this.readyHtml(view.webview, address);
			}
		} catch (error) {
			if (this.view === view) {
				view.webview.html = this.errorHtml(view.webview, error instanceof Error ? error.message : String(error));
			}
		}
	}

	private updateRefreshTimer(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		if (this.view?.visible) {
			this.refreshTimer = setInterval(() => void this.refresh(), 2_000);
			this.refreshTimer.unref();
		}
	}

	private loadingHtml(webview: vscode.Webview): string {
		return this.document(webview, '<div class="status"><span class="spinner"></span>Starting shared gateway...</div>');
	}

	private errorHtml(webview: vscode.Webview, message: string): string {
		return this.document(webview, `
			<div class="eyebrow">Mobile access</div>
			<h2>Gateway unavailable</h2>
			<p>${escapeHtml(message)}</p>
			<button class="primary" data-command="refresh">Try again</button>
		`);
	}

	private readyHtml(webview: vscode.Webview, address: GatewayAddress): string {
		const qrScript = webview.asWebviewUri(vscode.Uri.joinPath(
			this.extensionUri, 'media', 'vendor', 'qrcode-svg-1.1.0.min.js',
		));
		const nonce = createNonce();
		const body = `
			<div class="eyebrow"><span class="dot"></span>Shared gateway online</div>
			<h2>Open on your phone</h2>
			<p>Scan with your phone camera while both devices are on the same Wi-Fi network.</p>
			<div id="qr" class="qr" aria-label="QR code for ${escapeHtml(address.url)}"></div>
			<code>${escapeHtml(address.url)}</code>
			<div class="actions">
				<button class="primary" data-command="open">Open dashboard</button>
				<button data-command="copy">Copy URL</button>
			</div>
			<div class="notice"><strong>Mobile app pairing</strong><br>Encrypted one-time pairing will replace this dashboard QR in the next transport phase.</div>
		`;
		const script = `
			<script nonce="${nonce}" src="${qrScript}"></script>
			<script nonce="${nonce}">
				const vscode = acquireVsCodeApi();
				document.getElementById('qr').innerHTML = new QRCode({
					content: ${JSON.stringify(address.url)}, padding: 2, width: 224, height: 224,
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
			h2{margin:10px 0 6px;font-size:18px;letter-spacing:0}p{margin:0 0 16px;color:var(--vscode-descriptionForeground)}
			.qr{width:min(224px,100%);aspect-ratio:1;margin:0 auto 14px;padding:8px;border-radius:6px;background:#fff}.qr svg{display:block;width:100%;height:100%}
			code{display:block;overflow-wrap:anywhere;padding:9px;border:1px solid var(--vscode-widget-border);border-radius:4px;background:var(--vscode-textCodeBlock-background);font-size:11px}
			.actions{display:grid;gap:8px;margin-top:12px}button{min-height:32px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.primary:hover{background:var(--vscode-button-hoverBackground)}
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