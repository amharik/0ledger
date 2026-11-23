import { readFileSync } from 'node:fs';

export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_SERVER_HOST = '127.0.0.1';

export interface ServerTlsOptions {
  cert: Buffer;
  key: Buffer;
}

export function parseServerPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SERVER_PORT;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid PORT "${raw}"; expected an integer between 1 and 65535.`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}"; expected an integer between 1 and 65535.`);
  }
  return port;
}

export function resolveServerPort(): number {
  return parseServerPort(process.env.PORT);
}

export function resolveServerHost(): string {
  return process.env.HOST?.trim() || DEFAULT_SERVER_HOST;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    value === '127.0.0.1' ||
    value.startsWith('127.')
  );
}

export function resolveTlsOptions(env = process.env): ServerTlsOptions | undefined {
  const certPath = env.SERVER_TLS_CERT?.trim();
  const keyPath = env.SERVER_TLS_KEY?.trim();
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error('Both SERVER_TLS_CERT and SERVER_TLS_KEY are required to enable TLS.');
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

export function resolveServerProtocol(env = process.env): 'http' | 'https' {
  return env.SERVER_TLS_CERT?.trim() && env.SERVER_TLS_KEY?.trim() ? 'https' : 'http';
}

export function serverUrl(
  port = resolveServerPort(),
  host = DEFAULT_SERVER_HOST,
  protocol = resolveServerProtocol(),
): string {
  return `${protocol}://${host}:${port}`;
}
