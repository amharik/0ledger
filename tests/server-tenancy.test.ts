import { describe, expect, it } from 'vitest';
import {
  createTenantToken,
  resolveAuthConfig,
  verifyTenantToken,
} from '../server.tenancy.ts';

const SECRET = 'test-secret-that-is-long-enough-for-production-use';

describe('server tenancy tokens', () => {
  it('requires a strong secret in production', () => {
    expect(() => resolveAuthConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /SERVER_AUTH_SECRET is required/,
    );
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'production', SERVER_AUTH_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32 characters/);
    expect(
      resolveAuthConfig({
        NODE_ENV: 'production',
        SERVER_AUTH_SECRET: SECRET,
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ secret: SECRET, required: true, localTenant: 'local' });
  });

  it('allows local unauthenticated use only outside production', () => {
    expect(resolveAuthConfig({} as NodeJS.ProcessEnv)).toEqual({
      secret: undefined,
      required: false,
      localTenant: 'local',
    });
    expect(
      resolveAuthConfig({ SERVER_LOCAL_TENANT: 'home' } as NodeJS.ProcessEnv).localTenant,
    ).toBe('home');
  });

  it('creates and verifies a tenant token', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = createTenantToken(
      { tenantId: 'tenant-a', workspaceIds: ['ws_1', 'ws_2'], subject: 'user@example.com', ttlSeconds: 600 },
      SECRET,
      now,
    );
    const context = verifyTenantToken(token, SECRET, now + 1000);
    expect(context).toEqual({
      tenantId: 'tenant-a',
      workspaceIds: ['ws_1', 'ws_2'],
      subject: 'user@example.com',
    });
  });

  it('rejects expired, tampered, and malformed tokens', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = createTenantToken(
      { tenantId: 'tenant-a', workspaceIds: ['*'], ttlSeconds: 60 },
      SECRET,
      now,
    );
    expect(() => verifyTenantToken(token, SECRET, now + 120_000)).toThrow(/Invalid or expired/);
    expect(() => verifyTenantToken(`${token}x`, SECRET, now)).toThrow(/Invalid or expired/);
    expect(() => verifyTenantToken(token, `${SECRET}-other`, now)).toThrow(/Invalid or expired/);
    expect(() => verifyTenantToken('not-a-token', SECRET, now)).toThrow(/Invalid or expired/);
  });

  it('rejects invalid tenant and workspace identifiers', () => {
    expect(() =>
      createTenantToken({ tenantId: 'bad tenant', workspaceIds: ['ws_1'] }, SECRET),
    ).toThrow(/Tenant id/);
    expect(() =>
      createTenantToken({ tenantId: 'tenant-a', workspaceIds: [] }, SECRET),
    ).toThrow(/workspace ids/);
    expect(() =>
      createTenantToken({ tenantId: 'tenant-a', workspaceIds: ['bad workspace'] }, SECRET),
    ).toThrow(/Invalid workspace id/);
  });

  it('clamps token lifetime to a safe range', () => {
    const now = Date.UTC(2026, 0, 1);
    const short = createTenantToken(
      { tenantId: 'tenant-a', workspaceIds: ['ws_1'], ttlSeconds: 1 },
      SECRET,
      now,
    );
    expect(verifyTenantToken(short, SECRET, now + 59_000)).toBeTruthy();
    expect(() => verifyTenantToken(short, SECRET, now + 61_000)).toThrow(/Invalid or expired/);
  });
});
