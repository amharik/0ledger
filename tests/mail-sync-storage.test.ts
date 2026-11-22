import { describe, expect, it, beforeEach } from 'vitest';
import {
  listMailboxes,
  saveMailbox,
  deleteMailbox,
  getActiveMailbox,
  getMailSyncConfig,
  saveMailSyncConfig,
  encodePassword,
  decodePassword,
  clearMailSyncStorage,
  type MailboxAccount,
} from '@/core/desktop/mail-sync';

describe('Mail Sync Local Storage & Account Management', () => {
  const workspaceId = 'ws_test_mail_sync';

  beforeEach(() => {
    clearMailSyncStorage(workspaceId);
  });

  describe('encodePassword & decodePassword', () => {
    it('round trips normal and complex app passwords safely', () => {
      const passwords = [
        'abcd efgh ijkl mnop',
        'p@ssw0rd!#$*&()',
        'SuperSecret2026',
        'SpecialChars/\\:;"\'<>,.?~`',
        'UnicodeText: ₹ ₹1000 🚀',
      ];

      for (const pwd of passwords) {
        const cipher = encodePassword(pwd, workspaceId);
        expect(cipher).not.toBe(pwd); // obfuscated
        const decrypted = decodePassword(cipher, workspaceId);
        expect(decrypted).toBe(pwd);
      }
    });

    it('handles empty strings and corrupted ciphers gracefully without throwing', () => {
      expect(encodePassword('')).toBe('');
      expect(decodePassword('')).toBe('');
      expect(decodePassword('not_valid_base64_%%%')).toBe('not_valid_base64_%%%');
    });
  });

  describe('listMailboxes & Legacy Migration (Recursion Prevention)', () => {
    it('returns empty array when no accounts exist', () => {
      const list = listMailboxes(workspaceId);
      expect(list).toEqual([]);
    });

    it('seamlessly migrates legacy IMAP config without infinite recursion or stack overflow', () => {
      // Setup legacy config
      saveMailSyncConfig(workspaceId, {
        host: 'imap.gmail.com',
        port: 993,
        username: 'accounts@company.com',
        password: 'app-password-1234',
        mailbox: 'INBOX',
      });

      // Verify getMailSyncConfig returns legacy
      const legacy = getMailSyncConfig(workspaceId);
      expect(legacy?.username).toBe('accounts@company.com');

      // Calling listMailboxes MUST migrate cleanly without maximum call stack error!
      const mailboxes = listMailboxes(workspaceId);
      expect(mailboxes.length).toBe(1);
      const migrated = mailboxes[0]!;
      expect(migrated.username).toBe('accounts@company.com');
      expect(migrated.provider).toBe('gmail');
      expect(migrated.isDefault).toBe(true);
      expect(decodePassword(migrated.passwordCipher, workspaceId)).toBe('app-password-1234');

      // Subsequent call reads directly from migrated mailboxes store
      const refreshed = listMailboxes(workspaceId);
      expect(refreshed.length).toBe(1);
      expect(refreshed[0]!.id).toBe(migrated.id);
    });
  });

  describe('saveMailbox & deleteMailbox', () => {
    it('saves new mailboxes, maintains default flags, and updates existing', () => {
      const box1: MailboxAccount = {
        id: 'mbx_1',
        label: 'Primary Gmail',
        provider: 'gmail',
        host: 'imap.gmail.com',
        port: 993,
        username: 'primary@test.com',
        passwordCipher: encodePassword('pass1', workspaceId),
        mailbox: 'INBOX',
        isDefault: true,
      };

      const box2: MailboxAccount = {
        id: 'mbx_2',
        label: 'Outlook Alerts',
        provider: 'outlook',
        host: 'outlook.office365.com',
        port: 993,
        username: 'alerts@test.com',
        passwordCipher: encodePassword('pass2', workspaceId),
        mailbox: 'INBOX',
      };

      saveMailbox(workspaceId, box1);
      saveMailbox(workspaceId, box2);

      let list = listMailboxes(workspaceId);
      expect(list.length).toBe(2);
      expect(getActiveMailbox(workspaceId)?.id).toBe('mbx_1');
      expect(getActiveMailbox(workspaceId, 'mbx_2')?.id).toBe('mbx_2');

      // Update box1 label
      saveMailbox(workspaceId, { ...box1, label: 'Updated Gmail' });
      list = listMailboxes(workspaceId);
      expect(list.length).toBe(2);
      expect(list.find((m) => m.id === 'mbx_1')?.label).toBe('Updated Gmail');

      // Delete box1 -> box2 should become default
      deleteMailbox(workspaceId, 'mbx_1');
      list = listMailboxes(workspaceId);
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe('mbx_2');
      expect(list[0]!.isDefault).toBe(true);
    });
  });
});
