import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { AggregateMonitor } from './aggregateMonitor';
import { GatewayLease, GatewayLeaseStore } from './gatewayLease';
import { GatewayAddress, GatewayServer, RemoteAccessController } from './gatewayServer';

/** Delays between attempts to re-reach a gateway whose presence stream dropped, before running an election. */
const presenceReconnectDelaysMs = [250, 1_000, 2_000];

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
	readonly readPairingSecret: () => Promise<string>;
	readonly getEndpoints?: (port: number) => readonly string[];
	readonly remoteAccess?: RemoteAccessController;
	/** @deprecated No periodic re-check exists anymore; kept for call-site compatibility. */
	readonly retryIntervalMs?: number;
}

/**
 * Elects exactly one window per host to run the shared gateway and lets every other window
 * find it. Followers hold the gateway's presence stream open; when it closes they re-run
 * the election immediately. The owner publishes its lease once — liveness is proven by the
 * gateway answering `/api/health` with the lease nonce, not by heartbeats.
 */
export class GatewayCoordinator {
	private ownedServer: GatewayServer | undefined;
	private ownedMonitor: AggregateMonitor | undefined;
	private ensuring: Promise<void> | undefined;
	private readonly leaseStore: GatewayLeaseStore;
	private ownedLease: GatewayLease | undefined;
	private currentAddress: GatewayAddress | undefined;
	private presence: http.ClientRequest | undefined;
	private presencePending: { destroyed: boolean } | undefined;
	private presencePort: number | undefined;
	private presenceRetryTimer: NodeJS.Timeout | undefined;
	private presenceRetryAttempt = 0;
	private readonly addressListeners = new Set<(address: GatewayAddress | undefined) => void>();
	private lastNotifiedPort: number | undefined;
	private lastNotifiedLeader = false;
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
		this.closePresence();
		await this.ensuring?.catch(() => undefined);
		await this.stopOwnedGateway();
		this.addressListeners.clear();
	}

	/** Fires after the gateway address this window should use changes (including to `undefined` while re-electing). */
	onDidChangeAddress(listener: (address: GatewayAddress | undefined) => void): { dispose(): void } {
		this.addressListeners.add(listener);
		return { dispose: () => this.addressListeners.delete(listener) };
	}

	/** Owner only: push the current endpoint list to streaming clients. */
	notifyEndpointsChanged(): void {
		this.ownedServer?.notifyEndpointsChanged();
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
			this.syncPresence();
			this.notifyAddressIfChanged();
		}
	}

	private notifyAddressIfChanged(): void {
		const port = this.currentAddress?.port;
		const leader = this.isLeader;
		if (port === this.lastNotifiedPort && leader === this.lastNotifiedLeader) {
			return;
		}
		this.lastNotifiedPort = port;
		this.lastNotifiedLeader = leader;
		for (const listener of this.addressListeners) {
			listener(this.currentAddress);
		}
	}

	private async doEnsureGateway(required: boolean): Promise<void> {
		if (this.ownedServer && this.ownedLease) {
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
			const recoveredLease = await this.recoverPreferredGatewayLease();
			if (recoveredLease) {
				await this.leaseStore.publish(recoveredLease);
				this.currentAddress = this.addressForPort(recoveredLease.port);
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
			ownerId: this.options.ownerId,
			html: this.options.html,
			mermaidScript: this.options.mermaidScript,
			iconSvg: this.options.iconSvg,
			readPairingSecret: this.options.readPairingSecret,
			getEndpoints: this.options.getEndpoints,
			remoteAccess: this.options.remoteAccess,
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

	private async recoverPreferredGatewayLease(): Promise<GatewayLease | undefined> {
		const health = await readExpectedGateway(this.options.port, this.options.hostId);
		if (!health) {
			return undefined;
		}
		return {
			version: 1,
			hostId: this.options.hostId,
			nonce: health.leaseNonce,
			ownerId: health.ownerId ?? `recovered-${health.leaseNonce}`,
			port: this.options.port,
			heartbeatAt: Date.now(),
		};
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

	// #region follower presence

	/** Followers keep one idle connection to the gateway; owners and stopped coordinators keep none. */
	private syncPresence(): void {
		if (this.stopped || this.ownedServer || !this.currentAddress) {
			this.closePresence();
			return;
		}
		if ((this.presence || this.presencePending) && this.presencePort === this.currentAddress.port) {
			return;
		}
		this.closePresence();
		this.openPresence(this.currentAddress.port);
	}

	private openPresence(port: number): void {
		const pending = { destroyed: false, request: undefined as http.ClientRequest | undefined };
		this.presence = undefined;
		this.presencePort = port;
		this.presencePending = pending;
		void this.options.readPairingSecret().then(secret => {
			if (pending.destroyed || this.presencePending !== pending) {
				return;
			}
			const request = http.get({
				host: '127.0.0.1',
				port,
				path: '/api/presence',
				headers: { authorization: `Bearer ${secret}` },
			}, response => {
				if (response.statusCode !== 200) {
					response.resume();
					this.onPresenceLost(request);
					return;
				}
				this.presenceRetryAttempt = 0;
				response.resume();
				response.on('close', () => this.onPresenceLost(request));
				response.on('error', () => this.onPresenceLost(request));
			});
			request.on('error', () => this.onPresenceLost(request));
			this.presence = request;
			this.presencePending = undefined;
		}, () => {
			if (this.presencePending === pending) {
				this.presencePending = undefined;
				this.presencePort = undefined;
				this.schedulePresenceRetry();
			}
		});
	}

	private onPresenceLost(request: http.ClientRequest): void {
		if (this.presence !== request) {
			return;
		}
		this.closePresence();
		this.schedulePresenceRetry();
	}

	/** The gateway is gone or restarting: forget its address and elect again after a short delay. */
	private schedulePresenceRetry(): void {
		if (this.stopped || this.presenceRetryTimer) {
			return;
		}
		const delay = presenceReconnectDelaysMs[Math.min(this.presenceRetryAttempt, presenceReconnectDelaysMs.length - 1)];
		this.presenceRetryAttempt++;
		this.presenceRetryTimer = setTimeout(async () => {
			this.presenceRetryTimer = undefined;
			if (this.stopped || this.ownedServer) {
				return;
			}
			this.currentAddress = undefined;
			try {
				await this.ensureGateway(false);
			} catch {
				// Retried below.
			}
			if (!this.stopped && !this.ownedServer && !this.currentAddress) {
				this.notifyAddressIfChanged();
				this.schedulePresenceRetry();
			}
		}, delay);
		this.presenceRetryTimer.unref();
	}

	private closePresence(): void {
		if (this.presenceRetryTimer) {
			clearTimeout(this.presenceRetryTimer);
			this.presenceRetryTimer = undefined;
		}
		if (this.presencePending) {
			this.presencePending.destroyed = true;
			this.presencePending = undefined;
		}
		const request = this.presence;
		this.presence = undefined;
		this.presencePort = undefined;
		request?.destroy();
	}

	// #endregion
}

async function isExpectedGateway(port: number, registryId: string, leaseNonce: string): Promise<boolean> {
	const health = await readGatewayHealth(port);
	return health?.registryId === registryId && health.leaseNonce === leaseNonce;
}

interface GatewayHealth {
	readonly registryId: string;
	readonly hostId?: string;
	readonly leaseNonce: string;
	readonly ownerId?: string;
}

async function readExpectedGateway(port: number, hostId: string): Promise<GatewayHealth | undefined> {
	const health = await readGatewayHealth(port);
	return health && (health.hostId ?? health.registryId) === hostId ? health : undefined;
}

async function readGatewayHealth(port: number): Promise<GatewayHealth | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
		if (!response.ok) {
			return undefined;
		}
		const value = await response.json() as Partial<GatewayHealth> & { service?: string };
		return value.service === 'githubcopilot-monitor-gateway'
			&& typeof value.registryId === 'string'
			&& typeof value.leaseNonce === 'string'
			? {
				registryId: value.registryId,
				leaseNonce: value.leaseNonce,
				...(typeof value.hostId === 'string' ? { hostId: value.hostId } : {}),
				...(typeof value.ownerId === 'string' ? { ownerId: value.ownerId } : {}),
			}
			: undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function isAddressInUse(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}