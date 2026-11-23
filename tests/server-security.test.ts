import { describe, expect, it, vi } from 'vitest';
import {
  assertAllowedImapHost,
  isLoopbackAddress,
  isPrivateAddress,
  rateLimit,
  securityHeaders,
} from '../server.security.ts';

describe('SSRF protection', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::127.0.0.1',
    'fec0::1',
  ])('treats %s as private or reserved', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '142.250.183.14', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'treats %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('detects loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('rejects private literal IPs unless explicitly allowed', async () => {
    await expect(assertAllowedImapHost('127.0.0.1')).rejects.toThrow(/private or reserved/);
    await expect(assertAllowedImapHost('169.254.169.254')).rejects.toThrow(/private or reserved/);
    await expect(assertAllowedImapHost('127.0.0.1', { allowPrivate: true })).resolves.toBe(
      '127.0.0.1',
    );
  });

  it('rejects URLs and malformed hostnames', async () => {
    await expect(assertAllowedImapHost('http://imap.example.com')).rejects.toThrow(/not a URL/);
    await expect(assertAllowedImapHost('imap.example.com/path')).rejects.toThrow(/not a URL/);
    await expect(assertAllowedImapHost('imap example.com')).rejects.toThrow(/not a URL/);
    await expect(assertAllowedImapHost('')).rejects.toThrow(/invalid/);
  });

  it('rejects hostnames resolving to private addresses', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '10.0.0.4', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);
    await expect(assertAllowedImapHost('imap.example.com', { lookup })).rejects.toThrow(
      /private or reserved/,
    );
    expect(lookup).toHaveBeenCalledWith('imap.example.com', { all: true, verbatim: true });
  });

  it('allows public hostnames and private ones when opted in', async () => {
    const publicLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertAllowedImapHost('imap.example.com', { lookup: publicLookup }),
    ).resolves.toBe('imap.example.com');

    const privateLookup = vi.fn().mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
    await expect(
      assertAllowedImapHost('mail.internal', { lookup: privateLookup, allowPrivate: true }),
    ).resolves.toBe('mail.internal');
  });

  it('rejects empty DNS responses', async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    await expect(assertAllowedImapHost('missing.example.com', { lookup })).rejects.toThrow(
      /Could not resolve/,
    );
  });
});

describe('rate limiting and security headers', () => {
  it('limits requests per key and sets Retry-After', () => {
    let now = 1000;
    const middleware = rateLimit({ max: 2, windowMs: 60_000, now: () => now });
    const req = { ip: '127.0.0.1', get: () => undefined } as never;
    const headers: Record<string, string> = {};
    const makeRes = () => {
      const res = {
        locals: { tenant: { tenantId: 'tenant-a', workspaceIds: ['*'] } },
        statusCode: 200,
        body: undefined as unknown,
        setHeader: (key: string, value: string) => {
          headers[key] = value;
        },
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json(payload: unknown) {
          res.body = payload;
          return res;
        },
      };
      return res as never;
    };

    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();
    middleware(req, makeRes(), next1);
    middleware(req, makeRes(), next2);
    const res3 = makeRes();
    middleware(req, res3, next3);

    expect(next1).toHaveBeenCalledOnce();
    expect(next2).toHaveBeenCalledOnce();
    expect(next3).not.toHaveBeenCalled();
    expect((res3 as { statusCode: number }).statusCode).toBe(429);
    expect(headers['Retry-After']).toBe('60');

    now += 61_000;
    const next4 = vi.fn();
    middleware(req, makeRes(), next4);
    expect(next4).toHaveBeenCalledOnce();
  });

  it('sets baseline and TLS security headers', () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
    } as never;
    securityHeaders({ tls: true, production: true })({} as never, res, vi.fn());
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
  });
});
