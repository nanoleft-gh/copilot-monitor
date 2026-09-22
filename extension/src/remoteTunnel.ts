import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RemoteTunnelStatus } from './protocol';

/**
 * Runs a tunnel agent as a child process and turns its output into a small state machine
 * (`inactive → starting → active | error | signin-required | unavailable`). Which agent, how it
 * is started, and how its output is read is a {@link TunnelDriver}; two are provided:
 *
 * - `devTunnelDriver`: the `code-tunnel` CLI shipped inside VS Code, driven with the same
 *   stdin/stderr protocol the built-in Ports view uses (`tunnel forward-internal`). Free,
 *   GitHub sign-in, stable per-machine address, zero installation.
 * - `ngrokDriver`: the ngrok agent from PATH (`ngrok http <port>`), optionally pinned to the
 *   account's free static domain so the address never changes.
 *
 * Every request through either tunnel still needs the pairing secret.
 */

export type RemoteTunnelState = RemoteTunnelStatus;

export type TunnelLaunch =
	| { readonly kind: 'run'; readonly command: string; readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv; readonly stdin?: string }
	| { readonly kind: 'unavailable'; readonly reason: string }
	| { readonly kind: 'signin-required' };

export type TunnelLine = { readonly url: string } | { readonly error: string } | undefined;

export interface TunnelDriver {
	readonly name: string;
	/** Decides how to start the agent for `port`; `interactive` allows prompting the user (e.g. sign-in). */
	prepare(port: number, interactive: boolean): Promise<TunnelLaunch>;
	/** Interprets one output line; the manager logs lines that mean nothing. */
	parseLine(stream: 'stdout' | 'stderr', line: string, port: number): TunnelLine;
}

export interface RemoteTunnelOptions {
	readonly driver: TunnelDriver;
	readonly log: (message: string) => void;
	readonly spawn?: typeof nodeSpawn;
	/** How long the agent may take to report an address before the attempt is treated as failed. */
	readonly startTimeoutMs?: number;
	/** Delay before an unexpectedly exited agent is restarted; the last value repeats. */
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
		let launch: TunnelLaunch;
		try {
			launch = await this.options.driver.prepare(port, interactive);
		} catch (error) {
			this.options.log(`${this.options.driver.name}: prepare failed: ${error instanceof Error ? error.message : String(error)}`);
			this.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (this.port !== port) {
			return;
		}
		if (launch.kind === 'unavailable') {
			this.setState({ status: 'unavailable', reason: launch.reason });
			return;
		}
		if (launch.kind === 'signin-required') {
			this.setState({ status: 'signin-required' });
			return;
		}
		this.setState({ status: 'starting' });
		const spawn = this.options.spawn ?? nodeSpawn;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(launch.command, [...launch.args], {
				stdio: 'pipe',
				env: { ...process.env, NO_COLOR: '1', ...launch.env },
				windowsHide: true,
			});
		} catch (error) {
			this.setState({ status: 'error', error: `Could not start the tunnel agent: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		this.child = child;
		this.options.log(`${this.options.driver.name}: starting ${launch.command} for port ${port}`);

		child.on('error', error => {
			if (this.child !== child) {
				return;
			}
			this.options.log(`${this.options.driver.name}: ${error.message}`);
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
			this.options.log(`${this.options.driver.name}: agent exited with code ${code}`);
			if (this.port !== undefined) {
				// Keep a more specific error the agent printed just before dying.
				if (this._state.status !== 'error') {
					this.setState({ status: 'error', error: `The tunnel agent exited unexpectedly (code ${code ?? 'unknown'}).` });
				}
				this.scheduleRestart();
			}
		});
		this.readLines(child, child.stdout, 'stdout');
		this.readLines(child, child.stderr, 'stderr');
		child.stdin.on('error', () => undefined);
		if (launch.stdin !== undefined) {
			child.stdin.write(launch.stdin);
		}

		this.startTimer = setTimeout(() => {
			this.startTimer = undefined;
			if (this.child === child && this._state.status === 'starting') {
				this.options.log(`${this.options.driver.name}: no address reported in time`);
				this.killChild();
				this.setState({ status: 'error', error: 'The tunnel did not report an address in time. Check your internet connection and try again.' });
				this.scheduleRestart();
			}
		}, this.options.startTimeoutMs ?? defaultStartTimeoutMs);
		this.startTimer.unref?.();
	}

	private readLines(child: ChildProcessWithoutNullStreams, stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): void {
		let buffer = '';
		stream.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					this.handleLine(child, name, line);
				}
			}
		});
	}

	private handleLine(child: ChildProcessWithoutNullStreams, stream: 'stdout' | 'stderr', line: string): void {
		if (this.child !== child || this.port === undefined) {
			return;
		}
		const parsed = this.options.driver.parseLine(stream, line, this.port);
		if (!parsed) {
			this.options.log(`${this.options.driver.name}: ${line}`);
			return;
		}
		if ('error' in parsed) {
			this.options.log(`${this.options.driver.name}: ${parsed.error}`);
			if (this._state.status !== 'active') {
				this.setState({ status: 'error', error: parsed.error });
			}
			return;
		}
		const url = normalizeTunnelUrl(parsed.url);
		if (this._state.status === 'active' && this._state.url === url) {
			return;
		}
		if (this.startTimer) {
			clearTimeout(this.startTimer);
			this.startTimer = undefined;
		}
		this.restartAttempt = 0;
		this.options.log(`${this.options.driver.name}: reachable at ${url}`);
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

// #region dev tunnel driver

export interface DevTunnelDriverOptions {
	/** Path to `code-tunnel`; undefined when it cannot be found. */
	readonly resolveCli: () => Promise<string | undefined>;
	/** GitHub access token for the dev tunnel service; `interactive` may prompt the user to sign in. */
	readonly getAccessToken: (interactive: boolean) => Promise<string | undefined>;
}

export function devTunnelDriver(options: DevTunnelDriverOptions): TunnelDriver {
	return {
		name: 'dev tunnel',
		async prepare(port, interactive) {
			const cli = await options.resolveCli();
			if (!cli) {
				return { kind: 'unavailable', reason: 'The code-tunnel CLI that ships with VS Code was not found.' };
			}
			const token = await options.getAccessToken(interactive).catch(() => undefined);
			if (!token) {
				return { kind: 'signin-required' };
			}
			return {
				kind: 'run',
				command: cli,
				args: ['--verbose', 'tunnel', 'forward-internal', '--provider', 'github'],
				env: { VSCODE_CLI_ACCESS_TOKEN: token },
				// The CLI keeps forwarding the ports it last read from stdin; public because phones cannot do the GitHub browser login.
				stdin: `${JSON.stringify([{ number: port, privacy: 'public', protocol: 'http' }])}\n`,
			};
		},
		parseLine(stream, line, port) {
			if (stream !== 'stderr') {
				return undefined;
			}
			try {
				const parsed = JSON.parse(line) as { port_format?: unknown };
				return typeof parsed.port_format === 'string' ? { url: parsed.port_format.replace('{port}', String(port)) } : undefined;
			} catch {
				return undefined;
			}
		},
	};
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

export async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Try the next location.
		}
	}
	return undefined;
}

// #endregion

// #region ngrok driver

export interface NgrokSettings {
	readonly authtoken?: string;
	/** A reserved domain such as `example.ngrok-free.app`; free accounts get one static domain. */
	readonly domain?: string;
}

export interface NgrokDriverOptions {
	readonly getSettings: () => Promise<NgrokSettings>;
	/** Path to the ngrok agent; defaults to searching PATH. */
	readonly resolveAgent?: () => Promise<string | undefined>;
}

export function ngrokDriver(options: NgrokDriverOptions): TunnelDriver {
	return {
		name: 'ngrok',
		async prepare(port) {
			const agent = await (options.resolveAgent ?? findOnPath)('ngrok');
			if (!agent) {
				return { kind: 'unavailable', reason: 'The ngrok agent was not found on PATH.' };
			}
			const settings = await options.getSettings();
			// `--url https://` binds the account's auto-assigned dev domain, which is stable; a reserved
			// domain (paid plans, or one already claimed) pins an explicit name instead.
			const domain = normalizeNgrokDomain(settings.domain);
			const args = ['http', String(port), '--log', 'stdout', '--log-format', 'json', '--url', domain ? `https://${domain}` : 'https://'];
			return {
				kind: 'run',
				command: agent,
				args,
				// The token goes through the environment, never through the visible command line.
				...(settings.authtoken ? { env: { NGROK_AUTHTOKEN: settings.authtoken } } : {}),
			};
		},
		parseLine(stream, line) {
			if (stream !== 'stdout') {
				return line.trim() ? { error: line.trim() } : undefined;
			}
			let parsed: { lvl?: unknown; msg?: unknown; err?: unknown; url?: unknown };
			try {
				parsed = JSON.parse(line) as typeof parsed;
			} catch {
				return undefined;
			}
			if (parsed.msg === 'started tunnel' && typeof parsed.url === 'string') {
				return { url: parsed.url };
			}
			if (parsed.lvl === 'eror' || parsed.lvl === 'crit') {
				const detail = typeof parsed.err === 'string' ? parsed.err : typeof parsed.msg === 'string' ? parsed.msg : 'ngrok reported an error.';
				return { error: friendlyNgrokError(detail) };
			}
			return undefined;
		},
	};
}

/** Accepts `example.ngrok-free.app`, `https://example.ngrok-free.app/`, or blank. */
export function normalizeNgrokDomain(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
		return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
	} catch {
		return undefined;
	}
}

function friendlyNgrokError(detail: string): string {
	if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(detail)) {
		return 'ngrok needs a credential. Paste your ngrok API key (or agent authtoken) below.';
	}
	if (/ERR_NGROK_334|already online|is already bound/i.test(detail)) {
		return 'That ngrok address is already in use by another agent (another computer or a leftover ngrok process). Stop it and retry.';
	}
	if (/ERR_NGROK_1/i.test(detail) && /domain/i.test(detail)) {
		return `${detail} Check the domain spelling on dashboard.ngrok.com/domains.`;
	}
	return detail;
}

/** How to put the ngrok agent on PATH for this platform; shown when it is missing. */
export function ngrokInstallCommands(platform: NodeJS.Platform = process.platform): { label: string; command: string }[] {
	switch (platform) {
		case 'win32':
			return [
				{ label: 'winget', command: 'winget install ngrok.ngrok' },
				{ label: 'Chocolatey', command: 'choco install ngrok' },
			];
		case 'darwin':
			return [{ label: 'Homebrew', command: 'brew install ngrok' }];
		default:
			return [
				{ label: 'snap', command: 'sudo snap install ngrok' },
				{ label: 'apt', command: 'curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" | sudo tee /etc/apt/sources.list.d/ngrok.list && sudo apt update && sudo apt install ngrok' },
			];
	}
}

export async function findOnPath(executable: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	const directories = (environment.PATH ?? environment.Path ?? '').split(path.delimiter).filter(Boolean);
	const extensions = platform === 'win32' ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(extension => extension.toLowerCase()) : [''];
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = path.join(directory, executable + extension);
			try {
				await fs.access(candidate);
				return candidate;
			} catch {
				// Not here.
			}
		}
	}
	return undefined;
}

// #endregion
