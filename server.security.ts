import dns from 'node:dns/promises';
import net from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TenantContext } from './server.tenancy.ts';

export type LookupResult = { address: string; family: number };
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupResult[]>;

export interface SsrfOptions {
  allowPrivate?: boolean;
  lookup?: LookupFn;
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return octets;
}

function isPrivateIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function hexPairToIpv4(high: string, low: string): string {
  const h = Number.parseInt(high, 16);
  const l = Number.parseInt(low, 16);
  return [h >> 8, h & 0xff, l >> 8, l & 0xff].join('.');
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    return hex ? isPrivateIpv4(hexPairToIpv4(hex[1]!, hex[2]!)) : true;
  }
  const compat = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (compat) return isPrivateIpv4(hexPairToIpv4(compat[1]!, compat[2]!));
  const compatDotted = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (compatDotted) return isPrivateIpv4(compatDotted[1]!);
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('fec0')) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8:')) return true;
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, '');
  if (normalized === '::1') return true;
  return isPrivateIpv4(normalized) && normalized.startsWith('127.');
}

function assertHostShape(host: string): string {
  const value = host.trim();
  if (!value || value.length > 253) throw new Error('IMAP host is invalid.');
  if (/[\s/@]/.test(value) || value.includes('://')) {
    throw new Error('IMAP host must be a hostname or IP address, not a URL.');
  }
  return value;
}

export async function assertAllowedImapHost(host: string, options: SsrfOptions = {}): Promise<string> {
  const value = assertHostShape(host);
  const allowPrivate = options.allowPrivate === true;
  const lookup = options.lookup ?? dns.lookup;
  const ipFamily = net.isIP(value);

  if (ipFamily) {
    if (!allowPrivate && isPrivateAddress(value)) {
      throw new Error('IMAP host resolves to a private or reserved address.');
    }
    return value;
  }

  const records = (await lookup(value, { all: true, verbatim: true })) as LookupResult[];
  if (!records.length) throw new Error(`Could not resolve IMAP host "${value}".`);
  if (!allowPrivate) {
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new Error('IMAP host resolves to a private or reserved address.');
      }
    }
  }
  return value;
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  key?: (req: Request, res: Response) => string;
  now?: () => number;
}

export function rateLimit(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = Math.max(1000, options.windowMs ?? 60_000);
  const max = Math.max(1, options.max ?? 60);
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const keyFor =
    options.key ??
    ((req: Request, res: Response) => {
      const tenant = (res.locals.tenant as TenantContext | undefined)?.tenantId ?? 'anonymous';
      const workspace = (res.locals.workspaceId as string | undefined) ?? req.get('x-workspace-id') ?? '';
      return `${tenant}:${workspace}:${req.ip}`;
    });

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFor(req, res);
    const current = now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      if (buckets.size > 10_000) {
        for (const [bucketKey, entry] of buckets) {
          if (entry.resetAt <= current) buckets.delete(bucketKey);
        }
      }
      buckets.set(key, { count: 1, resetAt: current + windowMs });
      next();
      return;
    }
    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
      return;
    }
    bucket.count += 1;
    next();
  };
}

export function securityHeaders(options: { tls: boolean; production: boolean }): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (options.tls) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (options.production) {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "worker-src 'self' blob:",
          "connect-src 'self' https:",
        ].join('; '),
      );
    }
    next();
  };
}
