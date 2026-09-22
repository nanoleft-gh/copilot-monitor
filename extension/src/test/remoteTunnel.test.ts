import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { RemoteTunnel, type RemoteTunnelState, type TunnelDriver, devTunnelDriver, findOnPath, ngrokDriver, normalizeNgrokDomain, tunnelCliCandidates } from '../remoteTunnel';

/** A stand-in for `code-tunnel forward-internal`: echoes the port list it receives as a port_format line on stderr. */
const fakeDevTunnelArgs = ['-e', `
	process.stdin.on('data', chunk => {
		const ports = JSON.parse(String(chunk));
		if (ports[0]?.privacy !== 'public') { process.exit(3); }
		process.stderr.write(JSON.stringify({ port_format: 'https://abcd1234-{port}.inc1.devtunnels.ms/' }) + '\\n');
		if (process.env.FAKE_TUNNEL_EXIT_AFTER) { setTimeout(() => process.exit(7), Number(process.env.FAKE_TUNNEL_EXIT_AFTER)); }
	});
	setInterval(() => {}, 1000);
`];

/** A stand-in for the ngrok agent: prints its JSON log, honouring --url and NGROK_AUTHTOKEN. */
const fakeNgrokScript = `
	const args = process.argv.slice(2);
	const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://90d2-1-2-3-4.ngrok-free.app';
	if (!process.env.NGROK_AUTHTOKEN) {
		console.log(JSON.stringify({ lvl: 'eror', msg: 'failed to start tunnel', err: 'authentication failed: Usage of ngrok requires a verified account and authtoken.\\n\\nERR_NGROK_4018' }));
		process.exit(1);
	}
	console.log(JSON.stringify({ lvl: 'info', msg: 'starting web service', obj: 'web' }));
	console.log(JSON.stringify({ addr: 'http://localhost:' + args[1], lvl: 'info', msg: 'started tunnel', name: 'command_line', obj: 'tunnels', url }));
	setInterval(() => {}, 1000);
`;

function waitForState(tunnel: RemoteTunnel, status: RemoteTunnelState['status'], timeoutMs = 5_000): Promise<RemoteTunnelState> {
	return new Promise((resolve, reject) => {
		if (tunnel.state.status === status) {
			return resolve(tunnel.state);
		}
		const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`timed out waiting for ${status}, last ${JSON.stringify(tunnel.state)}`)); }, timeoutMs);
		const subscription = tunnel.onDidChangeState(state => {
			if (state.status === status) {
				clearTimeout(timer);
				subscription.dispose();
				resolve(state);
			}
		});
	});
}

const statusOf = (tunnel: RemoteTunnel): RemoteTunnelState['status'] => tunnel.state.status;

/** Wraps a driver so its `run` launch executes a fake agent under node while keeping the driver's parsing. */
function underNode(driver: TunnelDriver, rewrite: (launch: Extract<Awaited<ReturnType<TunnelDriver['prepare']>>, { kind: 'run' }>) => { command: string; args: readonly string[] }): TunnelDriver {
	return {
		...driver,
		async prepare(port, interactive) {
			const launch = await driver.prepare(port, interactive);
			return launch.kind === 'run' ? { ...launch, ...rewrite(launch) } : launch;
		},
	};
}

function devTunnel(overrides: { token?: (interactive: boolean) => Promise<string | undefined>; restartDelaysMs?: number[] } = {}): RemoteTunnel {
	const driver = devTunnelDriver({ resolveCli: async () => 'code-tunnel', getAccessToken: overrides.token ?? (async () => 'token') });
	return new RemoteTunnel({
		log: () => undefined,
		restartDelaysMs: overrides.restartDelaysMs,
		driver: underNode(driver, () => ({ command: process.execPath, args: fakeDevTunnelArgs })),
	});
}

describe('RemoteTunnel (dev tunnel driver)', () => {
	it('reports when the CLI is missing or the user is signed out, without spawning anything', async () => {
		const missing = new RemoteTunnel({ log: () => undefined, driver: devTunnelDriver({ resolveCli: async () => undefined, getAccessToken: async () => 'token' }) });
		await missing.start(43121);
		assert.equal(statusOf(missing), 'unavailable');
		missing.dispose();

		let interactiveRequested: boolean | undefined;
		const signedOut = devTunnel({ token: async interactive => { interactiveRequested = interactive; return undefined; } });
		await signedOut.start(43121);
		assert.equal(statusOf(signedOut), 'signin-required');
		assert.equal(interactiveRequested, false);
		await signedOut.start(43121, true);
		assert.equal(interactiveRequested, true);
		signedOut.dispose();
	});

	it('forwards the port publicly, reports the substituted address, and stops cleanly', async () => {
		const tunnel = devTunnel();
		try {
			await tunnel.start(43121);
			assert.equal(statusOf(tunnel), 'starting');
			assert.deepEqual(await waitForState(tunnel, 'active'), { status: 'active', url: 'https://abcd1234-43121.inc1.devtunnels.ms/' });
			await tunnel.start(43121);
			assert.equal(statusOf(tunnel), 'active');
			await tunnel.start(5000);
			assert.deepEqual(await waitForState(tunnel, 'active'), { status: 'active', url: 'https://abcd1234-5000.inc1.devtunnels.ms/' });
			await tunnel.stop();
			assert.equal(statusOf(tunnel), 'inactive');
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.equal(statusOf(tunnel), 'inactive', 'a killed agent does not count as an unexpected exit');
		} finally {
			tunnel.dispose();
		}
	});

	it('restarts the agent after an unexpected exit', async () => {
		process.env.FAKE_TUNNEL_EXIT_AFTER = '150';
		const tunnel = devTunnel({ restartDelaysMs: [50] });
		try {
			await tunnel.start(43121);
			await waitForState(tunnel, 'active');
			const errored = await waitForState(tunnel, 'error');
			assert.match((errored as { error: string }).error, /exited unexpectedly \(code 7\)/);
			await waitForState(tunnel, 'active');
		} finally {
			delete process.env.FAKE_TUNNEL_EXIT_AFTER;
			tunnel.dispose();
		}
	});

	it('locates the CLI where VS Code installs it', () => {
		const win = tunnelCliCandidates('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app', 'stable', 'abcdef1234567890', 'win32');
		assert.equal(win[0], 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code-tunnel.exe');
		const mac = tunnelCliCandidates('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app', 'insider', 'abc', 'darwin');
		assert.equal(mac[0], '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-tunnel-insiders');
		const linux = tunnelCliCandidates('/usr/share/code/resources/app', 'stable', 'abc', 'linux');
		assert.equal(linux[0], '/usr/share/code/bin/code-tunnel');
	});
});

describe('RemoteTunnel (ngrok driver)', () => {
	async function withFakeNgrok(run: (agent: string) => Promise<void>): Promise<void> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-ngrok-'));
		const script = path.join(directory, 'fake-ngrok.js');
		await fs.writeFile(script, fakeNgrokScript);
		try {
			await run(script);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}

	function ngrokTunnel(agent: string, settings: { authtoken?: string; domain?: string }): RemoteTunnel {
		const driver = ngrokDriver({ getSettings: async () => settings, resolveAgent: async () => agent });
		return new RemoteTunnel({
			log: () => undefined,
			driver: underNode(driver, launch => ({ command: process.execPath, args: [launch.command, ...launch.args] })),
		});
	}

	it('pins the account\'s static domain and passes the authtoken through the environment', async () => {
		await withFakeNgrok(async agent => {
			const driver = ngrokDriver({ getSettings: async () => ({ authtoken: 'tok', domain: 'https://pc.ngrok-free.app/' }), resolveAgent: async () => agent });
			const launch = await driver.prepare(43121, false);
			assert.equal(launch.kind, 'run');
			if (launch.kind === 'run') {
				assert.deepEqual(launch.args, ['http', '43121', '--log', 'stdout', '--log-format', 'json', '--url', 'https://pc.ngrok-free.app']);
				assert.equal(launch.env?.NGROK_AUTHTOKEN, 'tok');
				assert.ok(!launch.args.includes('tok'), 'the token is not on the command line');
			}
			const tunnel = ngrokTunnel(agent, { authtoken: 'tok', domain: 'pc.ngrok-free.app' });
			try {
				await tunnel.start(43121);
				assert.deepEqual(await waitForState(tunnel, 'active'), { status: 'active', url: 'https://pc.ngrok-free.app/' });
			} finally {
				tunnel.dispose();
			}
		});
	});

	it('explains a missing authtoken instead of a raw agent error, and reports a missing agent', async () => {
		await withFakeNgrok(async agent => {
			const tunnel = ngrokTunnel(agent, {});
			try {
				await tunnel.start(43121);
				const errored = await waitForState(tunnel, 'error');
				assert.match((errored as { error: string }).error, /needs your authtoken/);
			} finally {
				tunnel.dispose();
			}
		});
		const noAgent = new RemoteTunnel({ log: () => undefined, driver: ngrokDriver({ getSettings: async () => ({}), resolveAgent: async () => undefined }) });
		await noAgent.start(43121);
		assert.equal(statusOf(noAgent), 'unavailable');
		noAgent.dispose();
	});

	it('normalises domains and searches PATH', async () => {
		assert.equal(normalizeNgrokDomain(' https://Example.ngrok-free.app/ '), 'example.ngrok-free.app');
		assert.equal(normalizeNgrokDomain('example.ngrok-free.app'), 'example.ngrok-free.app');
		assert.equal(normalizeNgrokDomain(''), undefined);
		assert.equal(normalizeNgrokDomain('not a domain'), undefined);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-monitor-path-'));
		try {
			await fs.writeFile(path.join(directory, 'ngrok.exe'), '');
			assert.equal(await findOnPath('ngrok', { PATH: directory, PATHEXT: '.COM;.EXE' }, 'win32'), path.join(directory, 'ngrok.exe'));
			assert.equal(await findOnPath('ngrok', { PATH: directory }, 'linux'), undefined);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
