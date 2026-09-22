const defaultGatewayPort = 43121;

export function discoveryPorts(endpoint: string): number[] {
  let savedPort: number | undefined;
  try {
    const parsed = new URL(endpoint);
    const value = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (Number.isInteger(value) && value > 0 && value <= 65_535) savedPort = value;
  } catch {
    // Pairing validates stored endpoints; retain the default for legacy data.
  }
  return [...new Set([savedPort, defaultGatewayPort].filter((port): port is number => port !== undefined))];
}