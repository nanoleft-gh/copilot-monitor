import { AggregateMonitor } from './aggregateMonitor';
import { GatewayAddress, GatewayServer } from './gatewayServer';

const defaultRetryIntervalMs = 2_000;

export interface GatewayCoordinatorOptions {
	readonly registryDirectory: string;
	readonly registryId: string;
	readonly port: number;
	readonly advertisedHost: string;
	readonly html: string;
	readonly mermaidScript: string;
	readonly iconSvg?: string;
	readonly retryIntervalMs?: number;
}

export class GatewayCoordinator {
	private ownedServer: GatewayServer | undefined;
	private ownedMonitor: AggregateMonitor | undefined;
	private retryTimer: NodeJS.Timeout | undefined;
	private ensuring: Promise<void> | undefined;
	private stopped = false;

	constructor(private readonly options: GatewayCoordinatorOptions) {}

	get isLeader(): boolean {
		return this.ownedServer !== undefined;
	}

	get address(): GatewayAddress {
		return {
			host: '0.0.0.0',
			port: this.options.port,
			url: `http://${this.options.advertisedHost}:${this.options.port}/`,
		};
	}

	async start(): Promise<GatewayAddress> {
		await this.ensureGateway(true);
		this.retryTimer = setInterval(
			() => void this.ensureGateway(false),
			this.options.retryIntervalMs ?? defaultRetryIntervalMs,
		);
		this.retryTimer.unref();
		return this.address;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = undefined;
		}
		await this.stopOwnedGateway();
	}

	private async ensureGateway(required: boolean): Promise<void> {
		if (this.stopped || this.ownedServer) {
			return;
		}
		if (this.ensuring) {
			return this.ensuring;
		}
		this.ensuring = this.doEnsureGateway(required);
		try {
			await this.ensuring;
		} finally {
			this.ensuring = undefined;
		}
	}

	private async doEnsureGateway(required: boolean): Promise<void> {
		if (await isExpectedGateway(this.options.port, this.options.registryId)) {
			return;
		}

		const monitor = new AggregateMonitor(this.options.registryDirectory);
		await monitor.start();
		const server = new GatewayServer(monitor, {
			host: '0.0.0.0',
			advertisedHost: this.options.advertisedHost,
			port: this.options.port,
			registryId: this.options.registryId,
			html: this.options.html,
			mermaidScript: this.options.mermaidScript,
			iconSvg: this.options.iconSvg,
		});
		try {
			await server.start();
			if (this.stopped) {
				await server.stop();
				monitor.dispose();
				return;
			}
			this.ownedMonitor = monitor;
			this.ownedServer = server;
		} catch (error) {
			await server.stop().catch(() => undefined);
			monitor.dispose();
			if (isAddressInUse(error)) {
				if (await waitForExpectedGateway(this.options.port, this.options.registryId)) {
					return;
				}
				if (!required) {
					return;
				}
				throw new Error(`Port ${this.options.port} is already used by another application.`);
			}
			if (required) {
				throw error;
			}
		}
	}

	private async stopOwnedGateway(): Promise<void> {
		const server = this.ownedServer;
		const monitor = this.ownedMonitor;
		this.ownedServer = undefined;
		this.ownedMonitor = undefined;
		if (server) {
			await server.stop().catch(() => undefined);
		}
		monitor?.dispose();
	}
}

async function waitForExpectedGateway(port: number, registryId: string): Promise<boolean> {
	for (let attempt = 0; attempt < 10; attempt++) {
		if (await isExpectedGateway(port, registryId)) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return false;
}

async function isExpectedGateway(port: number, registryId: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
		if (!response.ok) {
			return false;
		}
		const value = await response.json() as { service?: string; registryId?: string };
		return value.service === 'githubcopilot-monitor-gateway' && value.registryId === registryId;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function isAddressInUse(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}