import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RemoteTunnel, type RemoteTunnelState, tunnelCliCandidates } from '../remoteTunnel';

/** A stand-in for `code-tunnel forward-internal`: echoes the port list it receives as a port_format line on stderr. */
const fakeCli = {
	command: process.execPath,
	args: ['-e', `
		process.stdin.on('data', chunk => {
			const ports = JSON.parse(String(chunk));
			if (ports[0]?.privacy !== 'public') { process.exit(3); }
			process.stderr.write(JSON.stringify({ port_format: 'https://abcd1234-{port}.inc1.devtunnels.ms/' }) + '\\n');
			if (process.env.FAKE_TUNNEL_EXIT_AFTER) { setTimeout(() => process.exit(7), Number(process.env.FAKE_TUNNEL_EXIT_AFTER)); }
		});
		setInterval(() => {}, 1000);
	`],
};

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

describe('RemoteTunnel', () => {
	it('reports when the CLI is missing or the user is signed out, without spawning anything', async () => {
		const missing = new RemoteTunnel({ resolveCommand: async () => undefined, getAccessToken: async () => 'token', log: () => undefined });
		await missing.start(43121);
		assert.equal(missing.state.status, 'unavailable');
		missing.dispose();

		let interactiveRequested: boolean | undefined;
		const signedOut = new RemoteTunnel({
			resolveCommand: async () => fakeCli,
			getAccessToken: async interactive => { interactiveRequested = interactive; return undefined; },
			log: () => undefined,
		});
		await signedOut.start(43121);
		assert.equal(signedOut.state.status, 'signin-required');
		assert.equal(interactiveRequested, false);
		await signedOut.start(43121, true);
		assert.equal(interactiveRequested, true);
		signedOut.dispose();
	});

	it('forwards the port publicly, reports the substituted address, and stops cleanly', async () => {
		const logs: string[] = [];
		const tunnel = new RemoteTunnel({ resolveCommand: async () => fakeCli, getAccessToken: async () => 'token', log: message => logs.push(message) });
		try {
			await tunnel.start(43121);
			assert.equal(statusOf(tunnel), 'starting');
			const active = await waitForState(tunnel, 'active');
			assert.deepEqual(active, { status: 'active', url: 'https://abcd1234-43121.inc1.devtunnels.ms/' });
			// Starting again for the same port is a no-op; a different port restarts the CLI.
			await tunnel.start(43121);
			assert.equal(statusOf(tunnel), 'active');
			await tunnel.start(5000);
			assert.deepEqual(await waitForState(tunnel, 'active'), { status: 'active', url: 'https://abcd1234-5000.inc1.devtunnels.ms/' });
			await tunnel.stop();
			assert.equal(statusOf(tunnel), 'inactive');
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.equal(statusOf(tunnel), 'inactive', 'a killed CLI does not count as an unexpected exit');
		} finally {
			tunnel.dispose();
		}
	});

	it('restarts the CLI after an unexpected exit', async () => {
		process.env.FAKE_TUNNEL_EXIT_AFTER = '150';
		const tunnel = new RemoteTunnel({
			resolveCommand: async () => fakeCli,
			getAccessToken: async () => 'token',
			log: () => undefined,
			restartDelaysMs: [50],
		});
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
