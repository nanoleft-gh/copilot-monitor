import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLanAddress, findLanAddresses } from '../lanAddress';

describe('findLanAddresses', () => {
	it('lists every physical adapter best-first and drops virtual ones when a real one exists', () => {
		assert.deepEqual(findLanAddresses({
			'vEthernet (WSL (Hyper-V firewall))': [interfaceInfo('172.29.160.1')],
			'Ethernet': [interfaceInfo('192.168.1.20')],
			'Wi-Fi': [interfaceInfo('10.225.47.59')],
			'Loopback Pseudo-Interface 1': [{ ...interfaceInfo('127.0.0.1'), internal: true }],
		}), ['10.225.47.59', '192.168.1.20']);
		assert.deepEqual(findLanAddresses({ 'vEthernet (WSL)': [interfaceInfo('172.29.160.1')] }), ['172.29.160.1']);
		assert.deepEqual(findLanAddresses({}), []);
	});
});

describe('findLanAddress', () => {
	it('prefers physical Wi-Fi over WSL and Hyper-V private adapters', () => {
		assert.equal(findLanAddress({
			'vEthernet (WSL (Hyper-V firewall))': [interfaceInfo('172.29.160.1')],
			'Wi-Fi': [interfaceInfo('10.225.47.59')],
			'Bluetooth Network Connection': [interfaceInfo('192.168.44.1')],
		}), '10.225.47.59');
	});

	it('uses an available virtual private address as a final fallback', () => {
		assert.equal(findLanAddress({
			'vEthernet (WSL)': [interfaceInfo('172.29.160.1')],
		}), '172.29.160.1');
	});
});

function interfaceInfo(address: string) {
	return {
		address,
		netmask: '255.255.255.0',
		family: 'IPv4' as const,
		mac: '00:00:00:00:00:00',
		internal: false,
		cidr: `${address}/24`,
	};
}