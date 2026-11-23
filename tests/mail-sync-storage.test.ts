import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  listMailboxes,
  saveMailbox,
  deleteMailbox,
  getActiveMailbox,
  getMailboxPassword,
  clearMailSyncStorage,
  type MailboxAccount,
} from '@/core/desktop/mail-sync';
import { clearServerClientConfig, setServerTenantId } from '@/core/server/server-client';

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function legacyCipher(password: string, salt: string): string {
  const utf8 = encodeURIComponent(password);
  const chars = Array.from(utf8).map((c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length)),
  );
  return btoa(chars.join(''));
}

function account(id: string, username: string): MailboxAccount {
  return {
    id,
    label: `Mailbox ${id}`,
    provider: 'gmail',
    host: 'imap.gmail.com',
    port: 993,
    username,
    mailbox: 'INBOX',
    isDefault: true,
  };
}

describe('Mail Sync secure storage and tenant isolation', () => {
  const workspaceId = 'ws_test_mail_sync';

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    clearServerClientConfig();
    setServerTenantId('tenant-a');
    clearMailSyncStorage(workspaceId);
  });

  afterEach(() => {
    clearMailSyncStorage(workspaceId);
    clearServerClientConfig();
    vi.unstubAllGlobals();
  });

  it('stores no plaintext or cipher in local storage', async () => {
    const box = account('mbx_1', 'primary@test.com');
    await saveMailbox(workspaceId, box, 'super-secret-password');

    const stored = localStorage.getItem(`0ledger.mailboxes:tenant-a:${workspaceId}`);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('super-secret-password');
    expect(stored).not.toContain('passwordCipher');
    expect(await getMailboxPassword(workspaceId, box.id)).toBe('super-secret-password');
  });

  it('isolates mailbox metadata and credentials between tenants', async () => {
    const box = account('mbx_tenant_a', 'a@test.com');
    await saveMailbox(workspaceId, box, 'tenant-a-password');
    expect(await getMailboxPassword(workspaceId, box.id)).toBe('tenant-a-password');

    setServerTenantId('tenant-b');
    expect(listMailboxes(workspaceId)).toEqual([]);
    expect(await getMailboxPassword(workspaceId, box.id)).toBeUndefined();

    setServerTenantId('tenant-a');
    expect(listMailboxes(workspaceId).map((item) => item.id)).toEqual([box.id]);
    expect(await getMailboxPassword(workspaceId, box.id)).toBe('tenant-a-password');
  });

  it('migrates a legacy plaintext config without persisting the password', () => {
    localStorage.setItem(
      `0ledger.mail_sync.config:${workspaceId}`,
      JSON.stringify({
        host: 'imap.gmail.com',
        port: 993,
        username: 'accounts@company.com',
        password: 'app-password-1234',
        mailbox: 'INBOX',
      }),
    );

    const mailboxes = listMailboxes(workspaceId);
    expect(mailboxes).toHaveLength(1);
    expect(mailboxes[0]!.username).toBe('accounts@company.com');
    expect(mailboxes[0]!.passwordCipher).toBeUndefined();
    expect(localStorage.getItem(`0ledger.mail_sync.config:${workspaceId}`)).toBeNull();

    const stored = localStorage.getItem(`0ledger.mailboxes:tenant-a:${workspaceId}`);
    expect(stored).not.toContain('app-password-1234');
    expect(stored).not.toContain('passwordCipher');
  });

  it('migrates legacy XOR ciphers and strips them from storage', async () => {
    const legacy = account('mbx_legacy', 'legacy@test.com');
    legacy.passwordCipher = legacyCipher('legacy-password', workspaceId);
    localStorage.setItem(`0ledger.mailboxes:${workspaceId}`, JSON.stringify([legacy]));

    const mailboxes = listMailboxes(workspaceId);
    expect(mailboxes[0]!.passwordCipher).toBeDefined();
    expect(await getMailboxPassword(workspaceId, 'mbx_legacy')).toBe('legacy-password');

    const stored = localStorage.getItem(`0ledger.mailboxes:tenant-a:${workspaceId}`);
    expect(stored).not.toContain('passwordCipher');
    expect(stored).not.toContain('legacy-password');
  });

  it('saves, updates, defaults, and deletes mailboxes', async () => {
    const box1 = account('mbx_1', 'primary@test.com');
    const box2 = { ...account('mbx_2', 'alerts@test.com'), isDefault: false };

    await saveMailbox(workspaceId, box1, 'pass1');
    await saveMailbox(workspaceId, box2, 'pass2');

    let list = listMailboxes(workspaceId);
    expect(list).toHaveLength(2);
    expect(getActiveMailbox(workspaceId)?.id).toBe('mbx_1');
    expect(getActiveMailbox(workspaceId, 'mbx_2')?.id).toBe('mbx_2');

    await saveMailbox(workspaceId, { ...box1, label: 'Updated Gmail' }, 'pass1');
    list = listMailboxes(workspaceId);
    expect(list).toHaveLength(2);
    expect(list.find((item) => item.id === 'mbx_1')?.label).toBe('Updated Gmail');

    await deleteMailbox(workspaceId, 'mbx_1');
    list = listMailboxes(workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('mbx_2');
    expect(list[0]!.isDefault).toBe(true);
    expect(await getMailboxPassword(workspaceId, 'mbx_1')).toBeUndefined();
  });
});
