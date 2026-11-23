import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { ImapFlow } from 'imapflow';
import { createApp } from '../server.ts';
import { createTenantToken, type AuthConfig } from '../server.tenancy.ts';

const SECRET = 'test-secret-that-is-long-enough-for-production-use';
const AUTH: AuthConfig = { secret: SECRET, required: true, localTenant: 'local' };
const TOKEN = createTenantToken(
  { tenantId: 'tenant-a', workspaceIds: ['ws_1'], subject: 'user@example.com' },
  SECRET,
);

class FakeImap {
  mailbox = { exists: 2, uidValidity: 7 };
  closed = false;

  async connect(): Promise<void> {}

  async list(): Promise<Array<{ path: string }>> {
    return [{ path: 'INBOX' }, { path: 'Archive' }];
  }

  async getMailboxLock(): Promise<{ release: () => void }> {
    return { release: () => {} };
  }

  async search(): Promise<number[]> {
    return [5, 4, 3, 2, 1];
  }

  async *fetch(
    uids: number[],
    options: { source?: boolean },
  ): AsyncGenerator<Record<string, unknown>> {
    for (const uid of uids) {
      if (options.source) {
        yield {
          uid,
          envelope: {
            subject: `Bank alert ${uid}`,
            from: [{ address: 'alerts@bank.example' }],
            date: new Date('2026-01-01T00:00:00Z'),
          },
          source: Buffer.from(`raw message ${uid}`),
        };
      } else {
        yield {
          uid,
          envelope: {
            subject: `Bank alert ${uid}`,
            from: [{ address: 'alerts@bank.example' }],
            date: new Date('2026-01-01T00:00:00Z'),
          },
        };
      }
    }
  }

  async logout(): Promise<void> {}

  close(): void {
    this.closed = true;
  }
}

async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function jsonHeaders(token = TOKEN, workspace = 'ws_1'): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Workspace-Id': workspace,
    'X-Tenant-Id': 'tenant-a',
  };
}

function imapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: {
      host: 'imap.example.com',
      port: 993,
      username: 'user@example.com',
      password: 'app-password',
      mailbox: 'INBOX',
      ...overrides,
    },
  };
}

async function makeApp(overrides: Parameters<typeof createApp>[0] = {}): Promise<Express> {
  return createApp({
    serveFrontend: false,
    auth: AUTH,
    tls: false,
    allowPrivateImap: false,
    assertHost: async (host) => host,
    createImapClient: () => new FakeImap() as unknown as ImapFlow,
    ...overrides,
  });
}

describe('server API authentication and tenant isolation', () => {
  it('serves health without authentication and sets security headers', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        tenantIsolation: true,
        tls: false,
      });
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  it('rejects missing, malformed, and invalid bearer tokens', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imapBody()),
      });
      expect(missing.status).toBe(401);

      const malformed = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic abc' },
        body: JSON.stringify(imapBody()),
      });
      expect(malformed.status).toBe(401);

      const invalid = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: { ...jsonHeaders('not-a-valid-token') },
        body: JSON.stringify(imapBody()),
      });
      expect(invalid.status).toBe(401);
    });
  });

  it('requires a workspace and enforces tenant/workspace boundaries', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const noWorkspace = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(imapBody()),
      });
      expect(noWorkspace.status).toBe(400);

      const wrongWorkspace = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: jsonHeaders(TOKEN, 'ws_other'),
        body: JSON.stringify(imapBody()),
      });
      expect(wrongWorkspace.status).toBe(403);

      const wrongTenant = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: { ...jsonHeaders(), 'X-Tenant-Id': 'tenant-b' },
        body: JSON.stringify(imapBody()),
      });
      expect(wrongTenant.status).toBe(403);
    });
  });

  it('validates IMAP config and rejects blocked hosts', async () => {
    const app = await makeApp({
      assertHost: async () => {
        throw new Error('IMAP host resolves to a private or reserved address.');
      },
    });
    await withServer(app, async (baseUrl) => {
      const invalid = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(imapBody({ host: 'http://imap.example.com' })),
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toMatch(/not a URL/);

      const blocked = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(imapBody()),
      });
      expect(blocked.status).toBe(400);
      expect((await blocked.json()).error).toMatch(/private or reserved/);
    });
  });

  it('tests IMAP connections through an injected client', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/imap/test`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(imapBody()),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        mailbox: 'INBOX',
        exists: 2,
        folders: ['INBOX', 'Archive'],
      });
    });
  });

  it('paginates IMAP fetch results with a cursor', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/imap/fetch`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          ...imapBody(),
          query: { preset: 'bank', limit: 2, days: 30 },
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(payload.scanned).toBe(5);
      expect(payload.matched).toBe(5);
      expect(payload.hasMore).toBe(true);
      expect(payload.nextCursor).toBe(4);
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0]).toMatchObject({
        uid: 5,
        mailbox: 'INBOX',
        uid_validity: 7,
      });
    });
  });

  it('rejects fetch limits above the page size and unknown API routes', async () => {
    const app = await makeApp();
    await withServer(app, async (baseUrl) => {
      const tooLarge = await fetch(`${baseUrl}/api/imap/fetch`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          ...imapBody(),
          query: { preset: 'bank', limit: 51, days: 30 },
        }),
      });
      expect(tooLarge.status).toBe(400);
      expect((await tooLarge.json()).error).toMatch(/cannot exceed 50/);

      const missing = await fetch(`${baseUrl}/api/missing`, {
        headers: jsonHeaders(),
      });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toMatch(/not found/);
    });
  });

  it('rate limits requests after the configured maximum', async () => {
    const app = await makeApp({ rateLimitMax: 2 });
    await withServer(app, async (baseUrl) => {
      const request = () =>
        fetch(`${baseUrl}/api/imap/test`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(imapBody()),
        });

      expect((await request()).status).toBe(200);
      expect((await request()).status).toBe(200);
      const limited = await request();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
    });
  });
});
