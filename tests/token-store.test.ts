import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) store.set(key, value);
      },
      remove: async (key: string) => {
        store.delete(key);
      },
    },
  },
});

const { clearDriveTokens, getDriveTokens, saveDriveTokens } = await import(
  '@/core/drive/token-store'
);

describe('drive token storage', () => {
  beforeEach(() => {
    store.clear();
    void clearDriveTokens();
  });

  it('never persists access tokens', async () => {
    await saveDriveTokens({
      accessToken: 'secret-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      email: 'test@example.com',
    });
    const persisted = JSON.stringify(store.get('drive.tokens'));
    expect(persisted).not.toContain('secret-access-token');
    expect(persisted).toContain('refresh-token');
    expect((await getDriveTokens())?.accessToken).toBe('secret-access-token');
  });
});
