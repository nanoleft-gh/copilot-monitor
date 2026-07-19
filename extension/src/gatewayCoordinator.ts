import { randomUUID } from 'node:crypto';
import { AggregateMonitor } from './aggregateMonitor';
import { GatewayLease, GatewayLeaseStore } from './gatewayLease';
import { GatewayAddress, GatewayServer } from './gatewayServer';

const defaultRetryIntervalMs = 2_000;

export interface GatewayCoordinatorOptions {
	readonly registryDirectory: string;
	readonly registryId: string;
	readonly leaseDirectory: string;
	readonly hostId: string;
	readonly ownerId: string;
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
	private readonly leaseStore: GatewayLeaseStore;
	private ownedLease: GatewayLease | undefined;
	private currentAddress: GatewayAddress | undefined;
	private stopped = false;

	constructor(private readonly options: GatewayCoordinatorOptions) {
		this.leaseStore = new GatewayLeaseStore(options.leaseDirectory);
	}

	get isLeader(): boolean {
		return this.ownedServer !== undefined;
	}

	get address(): GatewayAddress {
		return this.currentAddress ?? {
			host: '0.0.0.0',
			port: this.options.port,
			url: `http://${this.options.advertisedHost}:${this.options.port}/`,
		};
	}

	async start(): Promise<GatewayAddress> {
		await this.ensureGateway(true);
		if (!this.currentAddress) {
			throw new Error('The shared Copilot Monitor gateway did not become available.');
		}
		this.retryTimer = setInterval(
			() => void this.ensureGateway(false),
			this.options.retryIntervalMs ?? defaultRetryIntervalMs,
		);
		this.retryTimer.unref();
		return this.address;
	}

	async resolveAddress(): Promise<GatewayAddress> {
		// Do not clear a follower address while an existing convergence pass is
		// still unwinding. Otherwise ensureGateway() reuses that same promise after
		// currentAddress was cleared and returns without performing a fresh lookup.
		await this.ensuring?.catch(() => undefined);
		if (!this.ownedServer) {
			this.currentAddress = undefined;
		}
		await this.ensureGateway(true);
		if (!this.currentAddress) {
			throw new Error('The shared Copilot Monitor gateway is unavailable.');
		}
		return this.currentAddress;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = undefined;
		}
		await this.ensuring?.catch(() => undefined);
		await this.stopOwnedGateway();
	}

	private async ensureGateway(required: boolean): Promise<void> {
		if (this.stopped) {
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
		if (this.ownedServer && this.ownedLease) {
			const heartbeatLock = await this.leaseStore.acquire(this.options.ownerId);
			if (heartbeatLock) {
				try {
					const currentLease = await this.readHealthyLease();
					if (currentLease && currentLease.nonce !== this.ownedLease.nonce) {
						this.currentAddress = this.addressForPort(currentLease.port);
						await this.stopOwnedGateway();
						return;
					}
					this.ownedLease = { ...this.ownedLease, heartbeatAt: Date.now() };
					await this.leaseStore.publish(this.ownedLease);
				} finally {
					await heartbeatLock.release();
				}
			}
			return;
		}

		const existingLease = await this.readHealthyLease();
		if (existingLease) {
			this.currentAddress = this.addressForPort(existingLease.port);
			return;
		}

		const electionLock = await this.leaseStore.acquire(this.options.ownerId);
		if (!electionLock) {
			if (required) {
				const lease = await this.waitForHealthyLease();
				if (!lease) {
					throw new Error('Another Copilot Monitor window is still electing the shared gateway.');
				}
				this.currentAddress = this.addressForPort(lease.port);
			}
			return;
		}

		try {
			const leaseAfterLock = await this.readHealthyLease();
			if (leaseAfterLock) {
				this.currentAddress = this.addressForPort(leaseAfterLock.port);
				return;
			}
			await this.startOwnedGateway(required);
		} finally {
			await electionLock.release();
		}
	}

	private async startOwnedGateway(required: boolean): Promise<void> {
		const monitor = new AggregateMonitor(this.options.registryDirectory);
		await monitor.start();
		const nonce = randomUUID();
		let server = this.createServer(monitor, this.options.port, nonce);
		try {
			let address: GatewayAddress;
			try {
				address = await server.start();
			} catch (error) {
				await server.stop().catch(() => undefined);
				if (!isAddressInUse(error)) {
					throw error;
				}
				server = this.createServer(monitor, 0, nonce);
				address = await server.start();
			}
			if (this.stopped) {
				await server.stop();
				monitor.dispose();
				return;
			}
			const lease: GatewayLease = {
				version: 1,
				hostId: this.options.hostId,
				nonce,
				ownerId: this.options.ownerId,
				port: address.port,
				heartbeatAt: Date.now(),
			};
			await this.leaseStore.publish(lease);
			this.ownedMonitor = monitor;
			this.ownedServer = server;
			this.ownedLease = lease;
			this.currentAddress = address;
		} catch (error) {
			await server.stop().catch(() => undefined);
			monitor.dispose();
			if (required) {
				throw error;
			}
		}
	}

	private createServer(monitor: AggregateMonitor, port: number, nonce: string): GatewayServer {
		return new GatewayServer(monitor, {
			host: '0.0.0.0',
			advertisedHost: this.options.advertisedHost,
			port,
			registryId: this.options.registryId,
			hostId: this.options.hostId,
			leaseNonce: nonce,
			html: this.options.html,
			mermaidScript: this.options.mermaidScript,
			iconSvg: this.options.iconSvg,
		});
	}

	private async readHealthyLease(): Promise<GatewayLease | undefined> {
		const lease = await this.leaseStore.read();
		if (!lease || lease.hostId !== this.options.hostId) {
			return undefined;
		}
		return await isExpectedGateway(lease.port, this.options.registryId, lease.nonce) ? lease : undefined;
	}

	private async waitForHealthyLease(): Promise<GatewayLease | undefined> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const lease = await this.readHealthyLease();
			if (lease) {
				return lease;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		return undefined;
	}

	private addressForPort(port: number): GatewayAddress {
		return { host: '0.0.0.0', port, url: `http://${this.options.advertisedHost}:${port}/` };
	}

	private async stopOwnedGateway(): Promise<void> {
		const server = this.ownedServer;
		const monitor = this.ownedMonitor;
		this.ownedServer = undefined;
		this.ownedMonitor = undefined;
		const lease = this.ownedLease;
		this.ownedLease = undefined;
		if (server) {
			await server.stop().catch(() => undefined);
		}
		monitor?.dispose();
		if (lease) {
			await this.leaseStore.remove(lease.nonce);
		}
	}
}

async function isExpectedGateway(port: number, registryId: string, leaseNonce: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
		if (!response.ok) {
			return false;
		}
		const value = await response.json() as { service?: string; registryId?: string; leaseNonce?: string };
		return value.service === 'githubcopilot-monitor-gateway'
			&& value.registryId === registryId
			&& value.leaseNonce === leaseNonce;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function isAddressInUse(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}