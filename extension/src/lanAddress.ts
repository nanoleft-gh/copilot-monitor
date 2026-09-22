import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function findLanAddress(interfaces: InterfaceMap = networkInterfaces()): string {
	return findLanAddresses(interfaces)[0] ?? '127.0.0.1';
}

/** Every plausible LAN IPv4 address, best first; virtual adapters (WSL, Hyper-V, Docker) are excluded. */
export function findLanAddresses(interfaces: InterfaceMap = networkInterfaces()): string[] {
	const candidates = Object.entries(interfaces)
		.flatMap(([name, entries]) => (entries ?? []).map(entry => ({ name, entry })))
		.filter(candidate => candidate.entry.family === 'IPv4' && !candidate.entry.internal)
		.map(candidate => ({
			address: candidate.entry.address,
			score: scoreInterface(candidate.name, candidate.entry.address),
		}))
		.sort((left, right) => right.score - left.score);
	const reachable = candidates.filter(candidate => candidate.score >= 0);
	return [...new Set((reachable.length > 0 ? reachable : candidates.slice(0, 1)).map(candidate => candidate.address))];
}

function scoreInterface(name: string, address: string): number {
	let score = isPrivateIpv4(address) ? 20 : 0;
	if (/^(wi-?fi|wlan|wireless)/i.test(name)) {
		score += 100;
	} else if (/ethernet/i.test(name)) {
		score += 70;
	}
	if (/(vethernet|wsl|hyper-v|vmware|virtualbox|docker|loopback|bluetooth|local area connection\*)/i.test(name)) {
		score -= 200;
	}
	return score;
}

function isPrivateIpv4(address: string): boolean {
	if (address.startsWith('10.') || address.startsWith('192.168.')) {
		return true;
	}
	const match = /^172\.(\d+)\./.exec(address);
	return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}