import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RemoteTunnelStatus } from './protocol';

/**
 * Forwards the gateway port through a Microsoft dev tunnel using the `code-tunnel` CLI that
 * ships inside VS Code — the same binary and stdin/stderr protocol the built-in "Ports" view
 * uses, so no proposed API is needed. The tunnel is public because the phone cannot complete
 * the GitHub browser login a private tunnel demands; every request still needs the pairing
 * secret. The CLI runs one singleton per machine and returns a stable per-machine address.
 */

export type RemoteTunnelState = RemoteTunnelStatus;

export interface RemoteTunnelCommand {
	readonly command: string;
	readonly args: readonly string[];
}

export interface RemoteTunnelOptions {
	/** Resolves the CLI to run; undefined when it cannot be found. */
	readonly resolveCommand: () => Promise<RemoteTunnelCommand | undefined>;
	/** GitHub access token for the dev tunnel service; `interactive` may prompt the user to sign in. */
	readonly getAccessToken: (interactive: boolean) => Promise<string | undefined>;
	readonly log: (message: string) => void;
	readonly spawn?: typeof nodeSpawn;
	/** How long the CLI may take to report an address before the attempt is treated as failed. */
	readonly startTimeoutMs?: number;
	/** Delay before an unexpectedly exited CLI is restarted; the last value repeats. */
	readonly restartDelaysMs?: readonly number[];
}

const defaultStartTimeoutMs = 60_000;
const defaultRestartDelaysMs = [5_000, 15_000, 30_000, 60_000];

export class RemoteTunnel {
	private _state: RemoteTunnelState = { status: 'inactive' };
	private readonly listeners = new Set<(state: RemoteTunnelState) => void>();
	private child: ChildProcessWithoutNullStreams | undefined;
	private port: number | undefined;
	private startTimer: NodeJS.Timeout | undefined;
	private restartTimer: NodeJS.Timeout | undefined;
	private restartAttempt = 0;
	private starting: Promise<void> | undefined;
	private disposed = false;

	constructor(private readonly options: RemoteTunnelOptions) {}

	get state(): RemoteTunnelState {
		return this._state;
	}

	get wantedPort(): number | undefined {
		return this.port;
	}

	onDidChangeState(listener: (state: RemoteTunnelState) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Ensures a tunnel for `port` exists. Idempotent; a running tunnel for the same port is kept. */
	async start(port: number, interactive = false): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.child && this.port === port) {
			return;
		}
		if (this.starting) {
			await this.starting;
			if (this.child && this.port === port) {
				return;
			}
		}
		this.starting = this.doStart(port, interactive);
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	async stop(): Promise<void> {
		this.port = undefined;
		this.clearTimers();
		this.restartAttempt = 0;
		await this.starting?.catch(() => undefined);
		this.killChild();
		this.setState({ status: 'inactive' });
	}

	dispose(): void {
		this.disposed = true;
		void this.stop();
		this.listeners.clear();
	}

	private async doStart(port: number, interactive: boolean): Promise<void> {
		this.port = port;
		this.clearTimers();
		this.killChild();
		const command = await this.options.resolveCommand();
		if (!command) {
			this.setState({ status: 'unavailable', reason: 'The code-tunnel CLI that ships with VS Code was not found.' });
			return;
		}
		const token = await this.options.getAccessToken(interactive).catch(error => {
			this.options.log(`remote tunnel: sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		if (this.port !== port) {
			return;
		}
		if (!token) {
			this.setState({ status: 'signin-required' });
			return;
		}
		this.setState({ status: 'starting' });
		const spawn = this.options.spawn ?? nodeSpawn;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command.command, [...command.args], {
				stdio: 'pipe',
				env: { ...process.env, NO_COLOR: '1', VSCODE_CLI_ACCESS_TOKEN: token },
				windowsHide: true,
			});
		} catch (error) {
			this.setState({ status: 'error', error: `Could not start the tunnel CLI: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		this.child = child;
		this.options.log(`remote tunnel: starting ${command.command} for port ${port}`);

		child.on('error', error => {
			if (this.child !== child) {
				return;
			}
			this.options.log(`remote tunnel: ${error.message}`);
			this.child = undefined;
			this.clearTimers();
			this.setState({ status: 'error', error: error.message });
			this.scheduleRestart();
		});
		child.on('exit', code => {
			if (this.child !== child) {
				return;
			}
			this.child = undefined;
			this.clearTimers();
			this.options.log(`remote tunnel: CLI exited with code ${code}`);
			if (this.port !== undefined) {
				this.setState({ status: 'error', error: `The tunnel CLI exited unexpectedly (code ${code ?? 'unknown'}).` });
				this.scheduleRestart();
			}
		});
		child.stdout.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split(/\r?\n/)) {
				if (line.trim()) {
					this.options.log(`remote tunnel: ${line}`);
				}
			}
		});
		let stderrBuffer = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderrBuffer += chunk.toString('utf8');
			let newline: number;
			while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
				const line = stderrBuffer.slice(0, newline).trim();
				stderrBuffer = stderrBuffer.slice(newline + 1);
				if (line) {
					this.handleStderrLine(child, line);
				}
			}
		});
		child.stdin.on('error', () => undefined);
		child.stdin.write(`${JSON.stringify([{ number: port, privacy: 'public', protocol: 'http' }])}\n`);

		this.startTimer = setTimeout(() => {
			this.startTimer = undefined;
			if (this.child === child && this._state.status === 'starting') {
				this.options.log('remote tunnel: no address reported in time');
				this.killChild();
				this.setState({ status: 'error', error: 'The tunnel did not report an address in time. Check your internet connection and try again.' });
				this.scheduleRestart();
			}
		}, this.options.startTimeoutMs ?? defaultStartTimeoutMs);
		this.startTimer.unref?.();
	}

	private handleStderrLine(child: ChildProcessWithoutNullStreams, line: string): void {
		if (this.child !== child) {
			return;
		}
		let parsed: { port_format?: unknown };
		try {
			parsed = JSON.parse(line) as { port_format?: unknown };
		} catch {
			this.options.log(`remote tunnel: ${line}`);
			return;
		}
		if (typeof parsed.port_format !== 'string' || this.port === undefined) {
			return;
		}
		const url = normalizeTunnelUrl(parsed.port_format.replace('{port}', String(this.port)));
		if (this._state.status === 'active' && this._state.url === url) {
			return;
		}
		if (this.startTimer) {
			clearTimeout(this.startTimer);
			this.startTimer = undefined;
		}
		this.restartAttempt = 0;
		this.options.log(`remote tunnel: reachable at ${url}`);
		this.setState({ status: 'active', url });
	}

	private scheduleRestart(): void {
		if (this.disposed || this.port === undefined || this.restartTimer) {
			return;
		}
		const delays = this.options.restartDelaysMs ?? defaultRestartDelaysMs;
		const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
		this.restartAttempt++;
		const port = this.port;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.port === port && !this.child) {
				void this.start(port, false);
			}
		}, delay);
		this.restartTimer.unref?.();
	}

	private killChild(): void {
		const child = this.child;
		this.child = undefined;
		if (child) {
			try {
				child.stdin.end();
			} catch {
				// Already closed.
			}
			child.kill();
		}
	}

	private clearTimers(): void {
		if (this.startTimer) {
			clearTimeout(this.startTimer);
			this.startTimer = undefined;
		}
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
	}

	private setState(state: RemoteTunnelState): void {
		this._state = state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}
}

function normalizeTunnelUrl(value: string): string {
	const url = new URL(value);
	url.pathname = '/';
	url.search = '';
	url.hash = '';
	return url.toString();
}

/** Mirrors how VS Code's built-in tunnel-forwarding extension finds its CLI next to the app. */
export function tunnelCliCandidates(
	appRoot: string,
	appQuality: string | undefined,
	appCommit: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const cliName = (appQuality === 'stable' ? 'code-tunnel' : 'code-tunnel-insiders') + (platform === 'win32' ? '.exe' : '');
	const versionFolder = appCommit?.substring(0, 10);
	const binPaths = platform === 'darwin'
		? ['bin']
		: platform === 'win32' && versionFolder && appRoot.includes(versionFolder)
			? ['../../../bin', '../../bin']
			: ['../../bin'];
	const joiner = platform === 'win32' ? path.win32 : path.posix;
	const candidates = binPaths.map(binPath => joiner.join(appRoot, binPath, cliName));
	// Insiders builds occasionally ship the stable name and vice versa; try both spellings.
	const alternate = (appQuality === 'stable' ? 'code-tunnel-insiders' : 'code-tunnel') + (platform === 'win32' ? '.exe' : '');
	return [...candidates, ...binPaths.map(binPath => joiner.join(appRoot, binPath, alternate))];
}

/** `vscode.env.appQuality`/`appCommit` are proposed API; the same facts live in the app's product.json. */
export async function readProductInfo(appRoot: string): Promise<{ quality?: string; commit?: string }> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(appRoot, 'product.json'), 'utf8')) as { quality?: unknown; commit?: unknown };
		return {
			...(typeof value.quality === 'string' ? { quality: value.quality } : {}),
			...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
		};
	} catch {
		return {};
	}
}

export async function resolveTunnelCli(candidates: readonly string[]): Promise<RemoteTunnelCommand | undefined> {
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return { command: candidate, args: ['--verbose', 'tunnel', 'forward-internal', '--provider', 'github'] };
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}
