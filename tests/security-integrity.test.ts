import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import {
  listMailboxes,
  saveMailbox,
  getMailboxPassword,
  clearMailSyncStorage,
  type MailboxAccount,
} from '@/core/desktop/mail-sync';
import { clearServerClientConfig, setServerTenantId } from '@/core/server/server-client';
import {
  parseAuthenticationResults,
  computeTransactionDedupeKey,
} from '@/core/ingest/email';
import {
  enrichLedgerEntriesFromStatement,
} from '@/core/ingest/enrichment';
import { verifyStatementBalance } from '@/core/ingest/service';
import type { MoneyEvent, StatementLine } from '@/core/model';
import { newId } from '@/core/ids';

const databases: LedgerDatabase[] = [];

function newDb() {
  const db = createTestDb();
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
  vi.unstubAllGlobals();
});

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

describe('Security & Data Integrity Hardening (P0/P1 Review Findings)', () => {
  const workspaceId = 'ws_sec_test';

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    clearServerClientConfig();
    setServerTenantId('tenant-a');
    clearMailSyncStorage(workspaceId);
  });

  describe('P0.1: Credential Storage & Zero Plaintext in LocalStorage', () => {
    it('purges legacy plaintext storage upon migration and never mirrors plaintext', async () => {
      localStorage.setItem(
        `0ledger.mail_sync.config:${workspaceId}`,
        JSON.stringify({
          host: 'imap.hdfcbank.net',
          port: 993,
          username: 'treasury@hdfc.com',
          password: 'PlainTextSecretPassword!',
          mailbox: 'INBOX',
        }),
      );

      const mailboxes = listMailboxes(workspaceId);
      expect(mailboxes).toHaveLength(1);
      expect(mailboxes[0]!.username).toBe('treasury@hdfc.com');
      expect(mailboxes[0]!.passwordCipher).toBeUndefined();
      expect(localStorage.getItem(`0ledger.mail_sync.config:${workspaceId}`)).toBeNull();

      await saveMailbox(workspaceId, {
        id: 'mbx_new',
        label: 'New Account',
        provider: 'custom',
        host: 'imap.example.com',
        port: 993,
        username: 'audit@example.com',
        mailbox: 'INBOX',
        isDefault: true,
      }, 'another-pass');

      const stored = localStorage.getItem(`0ledger.mailboxes:tenant-a:${workspaceId}`);
      expect(stored).not.toContain('another-pass');
      expect(stored).not.toContain('passwordCipher');
      expect(await getMailboxPassword(workspaceId, 'mbx_new')).toBe('another-pass');
    });
  });

  describe('P1.3: DMARC / SPF / DKIM Sender Authenticity Verification', () => {
    it('verifies authentic headers with passing DMARC, SPF, and DKIM', () => {
      const headers = [
        {
          key: 'authentication-results',
          value:
            'mx.google.com; dkim=pass header.i=@alerts.hdfcbank.net header.s=s1; spf=pass (google.com: domain of alerts@alerts.hdfcbank.net designates 192.0.2.1); dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=alerts.hdfcbank.net',
        },
      ];

      const auth = parseAuthenticationResults(headers);
      expect(auth.isAuthentic).toBe(true);
      expect(auth.dmarc).toBe('pass');
      expect(auth.spf).toBe('pass');
      expect(auth.dkim).toBe('pass');
    });

    it('rejects unauthentic emails when DMARC fails or rejects', () => {
      const headers = [
        {
          key: 'authentication-results',
          value:
            'mx.google.com; dkim=fail; spf=neutral; dmarc=fail (p=REJECT) header.from=fakebank.com',
        },
      ];

      const auth = parseAuthenticationResults(headers);
      expect(auth.isAuthentic).toBe(false);
      expect(auth.dmarc).toBe('fail');
    });

    it('rejects emails when both SPF and DKIM fail', () => {
      const headers = [
        {
          key: 'authentication-results',
          value:
            'mx.google.com; dkim=fail header.i=@spoofed.com; spf=fail (google.com: domain of spoofed.com does not designate ...)',
        },
      ];

      const auth = parseAuthenticationResults(headers);
      expect(auth.isAuthentic).toBe(false);
      expect(auth.spf).toBe('fail');
      expect(auth.dkim).toBe('fail');
    });

    it('gracefully handles missing authentication headers in test/local environments', () => {
      const auth = parseAuthenticationResults([]);
      expect(auth.isAuthentic).toBe(true);
    });
  });

  describe('P1.5: Account-Scoped Deduplication Keys', () => {
    it('scopes non-global references to prevent collisions across accounts', async () => {
      const key1 = await computeTransactionDedupeKey({
        transactionId: 'AUTH992',
        rail: 'card_auth',
        accountTail: '1234',
        instrument: 'card',
        date: '2026-11-22',
        amountMinor: 50000,
        direction: 'out',
      });

      const key2 = await computeTransactionDedupeKey({
        transactionId: 'AUTH992',
        rail: 'card_auth',
        accountTail: '5678', // Different card!
        instrument: 'card',
        date: '2026-11-22',
        amountMinor: 50000,
        direction: 'out',
      });

      // Different accounts with the same card auth code must NOT collide
      expect(key1).not.toBe(key2);
    });

    it('keeps nationwide switch rails (UPI, NEFT, RTGS) globally unique', async () => {
      const upiRrn = '432612345678';
      const key1 = await computeTransactionDedupeKey({
        transactionId: upiRrn,
        rail: 'upi',
        accountTail: '1234',
        date: '2026-11-22',
        amountMinor: 150000,
        direction: 'out',
      });

      const key2 = await computeTransactionDedupeKey({
        transactionId: upiRrn,
        rail: 'upi',
        accountTail: '9999', // e.g. imported from a different source
        date: '2026-11-22',
        amountMinor: 150000,
        direction: 'out',
      });

      // UPI RRN is globally unique nationwide; deduplication recognizes same economic event
      expect(key1).toBe(key2);
    });
  });

  describe('P1.4: Ambiguity-Aware Statement Enrichment Matching', () => {
    it('detects ambiguous candidate ties and does not greedily misreconcile', async () => {
      const db = newDb();
      const ws = await createWorkspace(db, { name: 'Security Audit WS' });
      const wsId = ws.workspace.id;

      // Create two unposted MoneyEvents with the exact same amount and date (e.g. two ₹500 coffee purchases)
      const event1: MoneyEvent = {
        id: newId('mev'),
        workspaceId: wsId,
        source: 'email',
        contentHash: 'a'.repeat(64),
        date: '2026-11-20',
        amountMinor: 50000,
        direction: 'out',
        narration: 'Cafe Coffee Day Mumbai',
        status: 'suggested',
        confidence: 0.8,
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T10:00:00Z',
      };

      const event2: MoneyEvent = {
        id: newId('mev'),
        workspaceId: wsId,
        source: 'email',
        contentHash: 'b'.repeat(64),
        date: '2026-11-20',
        amountMinor: 50000,
        direction: 'out',
        narration: 'Starbucks Coffee Mumbai',
        status: 'suggested',
        confidence: 0.8,
        createdAt: '2026-11-20T11:00:00Z',
        updatedAt: '2026-11-20T11:00:00Z',
      };

      await db.moneyEvents.bulkAdd([event1, event2]);

      // Statement line of ₹500 with generic narration
      const lineId = newId('stl');
      const line: StatementLine = {
        id: lineId,
        importBatchId: newId('imp'),
        workspaceId: wsId,
        lineNo: 1,
        date: '2026-11-20',
        description: 'POS DEBIT COFFEE',
        debitMinor: 50000,
        creditMinor: 0,
        currency: 'INR',
        matchStatus: 'unmatched',
        matchConfidence: 0,
        createdAt: '2026-11-21T00:00:00Z',
        updatedAt: '2026-11-21T00:00:00Z',
      };
      await db.statementLines.add(line);

      const result = await enrichLedgerEntriesFromStatement(
        db,
        wsId,
        { lines: [line] },
        { toleranceDays: 1 },
      );

      // Both event1 and event2 match on amount+date with equal score.
      // Must NOT greedily bind or confirm; must flag as ambiguous candidate!
      expect(result.enrichedMoneyEvents).toBe(0);
      expect(result.details[0]!.actionTaken).toBe('ambiguous_candidate');

      const updatedLine = await db.statementLines.get(lineId);
      expect(updatedLine?.matchStatus).toBe('suggested');
      expect(updatedLine?.matchConfidence).toBe(0.5);
    });
  });

  describe('Chronological Statement Balance Verification', () => {
    it('accurately verifies running balances regardless of reverse or forward print order', () => {
      // Forward chronological order
      const forwardLines: StatementLine[] = [
        {
          id: 'l1',
          importBatchId: 'b1',
          workspaceId: 'w1',
          lineNo: 1,
          date: '2026-11-01',
          description: 'Opening Deposit',
          debitMinor: 0,
          creditMinor: 100000,
          balanceMinor: 100000,
          currency: 'INR',
          matchStatus: 'unmatched',
          matchConfidence: 0,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'l2',
          importBatchId: 'b1',
          workspaceId: 'w1',
          lineNo: 2,
          date: '2026-11-05',
          description: 'Payment to Vendor',
          debitMinor: 25000,
          creditMinor: 0,
          balanceMinor: 75000,
          currency: 'INR',
          matchStatus: 'unmatched',
          matchConfidence: 0,
          createdAt: '',
          updatedAt: '',
        },
      ];

      const resForward = verifyStatementBalance(forwardLines);
      expect(resForward.mismatches.length).toBe(0);
      expect(resForward.checked).toBe(1);

      // Reverse chronological order (as common in Indian bank e-statements where line 1 is newest)
      const reverseLines: StatementLine[] = [
        {
          id: 'l2',
          importBatchId: 'b1',
          workspaceId: 'w1',
          lineNo: 1,
          date: '2026-11-05',
          description: 'Payment to Vendor',
          debitMinor: 25000,
          creditMinor: 0,
          balanceMinor: 75000,
          currency: 'INR',
          matchStatus: 'unmatched',
          matchConfidence: 0,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'l1',
          importBatchId: 'b1',
          workspaceId: 'w1',
          lineNo: 2,
          date: '2026-11-01',
          description: 'Opening Deposit',
          debitMinor: 0,
          creditMinor: 100000,
          balanceMinor: 100000,
          currency: 'INR',
          matchStatus: 'unmatched',
          matchConfidence: 0,
          createdAt: '',
          updatedAt: '',
        },
      ];

      const resReverse = verifyStatementBalance(reverseLines);
      expect(resReverse.mismatches.length).toBe(0);
      expect(resReverse.checked).toBe(1);
    });
  });
});
