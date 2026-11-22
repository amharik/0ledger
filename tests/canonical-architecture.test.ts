import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { computeCanonicalTxnUid, bytesToBase32 } from '@/core/canonical/txn-uid';
import {
  registerOwnAccount,
  listOwnAccounts,
  findOwnAccount,
  detectTransferOrSettlement,
} from '@/core/canonical/accounts';
import {
  storeRawArtifact,
  processFinancialObservation,
  listCanonicalTransactions,
} from '@/core/canonical/engine';

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
});

describe('Architecture V2: Canonical Entity & Observation Model', () => {
  let db: LedgerDatabase;
  let workspaceId: string;

  beforeEach(async () => {
    db = newDb();
    const ws = await createWorkspace(db, { name: 'Canonical Architecture WS' });
    workspaceId = ws.workspace.id;
  });

  describe('Deterministic Natural-Key-First txn_uid Engine', () => {
    it('generates consistent 26-character Base32 UID for UPI RRN across sources', async () => {
      const upiRrn = '512345678901';

      // Observed from HDFC debit alert
      const hdfc = await computeCanonicalTxnUid({
        upiRrn,
        date: '2026-11-14',
        amountMinor: 124900,
        direction: 'out',
        merchantRaw: 'SWIGGY',
      });

      // Observed from PhonePe receipt
      const phonepe = await computeCanonicalTxnUid({
        upiRrn,
        date: '2026-11-14',
        amountMinor: 124900,
        direction: 'out',
        merchantRaw: 'Bundl Technologies Pvt Ltd',
      });

      expect(hdfc.idBasis).toBe('upi');
      expect(phonepe.idBasis).toBe('upi');
      expect(hdfc.txnUid.length).toBe(26);
      expect(phonepe.txnUid.length).toBe(26);
      // Nationwide switch key: Identical UID regardless of differing merchant narration
      expect(hdfc.txnUid).toBe(phonepe.txnUid);
    });

    it('generates NEFT/RTGS UTR based canonical UID', async () => {
      const res = await computeCanonicalTxnUid({
        utr: 'HDFCN52026110512345',
        date: '2026-11-05',
        amountMinor: 3500000,
        direction: 'out',
      });

      expect(res.idBasis).toBe('utr');
      expect(res.basis).toBe('utr:HDFCN52026110512345');
      expect(res.txnUid.length).toBe(26);
    });

    it('generates Card Refund ARN based canonical UID', async () => {
      const arn = '74512345678901234567890'; // 23 digits
      const res = await computeCanonicalTxnUid({
        arn,
        date: '2026-11-10',
        amountMinor: 49900,
        direction: 'in',
      });

      expect(res.idBasis).toBe('arn');
      expect(res.basis).toBe(`arn:${arn}:49900`);
      expect(res.txnUid.length).toBe(26);
    });

    it('generates E-commerce Order based canonical UID', async () => {
      const res = await computeCanonicalTxnUid({
        order: {
          merchant: 'Amazon',
          orderId: '405-1234567-8901234',
        },
        date: '2026-11-12',
        amountMinor: 149900,
        direction: 'out',
      });

      expect(res.idBasis).toBe('order');
      expect(res.basis).toBe('ord:amazon:405-1234567-8901234');
      expect(res.txnUid.length).toBe(26);
    });

    it('falls back to fp1 fingerprint when no rail references exist', async () => {
      const res = await computeCanonicalTxnUid({
        date: '2026-11-14',
        amountMinor: 5000,
        direction: 'out',
        merchantRaw: 'Local Chai Stall',
        channel: 'pos',
      });

      expect(res.idBasis).toBe('fingerprint');
      expect(res.basis.startsWith('fp1|')).toBe(true);
      expect(res.txnUid.length).toBe(26);
    });
  });

  describe('Multi-Source Observation Clustering (One Transaction, Many Emails)', () => {
    it('merges 4 distinct observations into one CanonicalTxn without duplicate accounting', async () => {
      const rrn = '512345678901';
      const amountMinor = 124900;
      const date = '2026-11-14';

      // Observation 1: HDFC Bank Debit Alert
      const art1 = await storeRawArtifact(db, workspaceId, {
        source: 'email',
        messageId: '<alert-hdfc-01@hdfcbank.net>',
        mimeType: 'message/rfc822',
        sha256: '1'.repeat(64),
        sizeBytes: 2500,
      });

      const res1 = await processFinancialObservation(db, workspaceId, art1.id, {
        instrumentType: 'savings',
        issuer: 'HDFC Bank',
        accountTail: '1234',
        channel: 'upi',
        date,
        amountMinor,
        direction: 'out',
        merchantRaw: 'UPI/512345678901/SWIGGY',
        referenceId: rrn,
        rail: 'upi',
        confidence: 0.95,
      });

      expect(res1.isNew).toBe(true);
      expect(res1.canonicalTxn.observationIds.length).toBe(1);

      // Observation 2: PhonePe UPI Receipt
      const art2 = await storeRawArtifact(db, workspaceId, {
        source: 'email',
        messageId: '<receipt-phonepe-02@phonepe.com>',
        mimeType: 'message/rfc822',
        sha256: '2'.repeat(64),
        sizeBytes: 3200,
      });

      const res2 = await processFinancialObservation(db, workspaceId, art2.id, {
        instrumentType: 'savings',
        issuer: 'HDFC Bank',
        accountTail: '1234',
        channel: 'upi',
        date,
        amountMinor,
        direction: 'out',
        merchantRaw: 'Bundl Technologies Pvt Ltd',
        counterpartyName: 'Bundl Technologies (Swiggy)',
        counterpartyVpa: 'swiggy@icici',
        referenceId: rrn,
        rail: 'upi',
        confidence: 0.98,
      });

      expect(res2.isNew).toBe(false); // Merged into existing transaction!
      expect(res2.canonicalTxn.id).toBe(res1.canonicalTxn.id);
      expect(res2.canonicalTxn.observationIds.length).toBe(2);
      expect(res2.canonicalTxn.counterparty).toBe('Bundl Technologies (Swiggy)');

      // Observation 3: Swiggy Order Email
      const art3 = await storeRawArtifact(db, workspaceId, {
        source: 'email',
        messageId: '<order-swiggy-03@swiggy.in>',
        mimeType: 'message/rfc822',
        sha256: '3'.repeat(64),
        sizeBytes: 8500,
      });

      const res3 = await processFinancialObservation(db, workspaceId, art3.id, {
        channel: 'ecom',
        date,
        amountMinor,
        direction: 'out',
        merchantRaw: 'Swiggy Food Delivery',
        merchantNormalized: 'Swiggy',
        referenceId: rrn,
        orderId: 'SWIGGY-OD-987654',
        confidence: 0.95,
      });

      expect(res3.isNew).toBe(false);
      expect(res3.canonicalTxn.id).toBe(res1.canonicalTxn.id);
      expect(res3.canonicalTxn.observationIds.length).toBe(3);

      // Observation 4: Monthly Bank Statement PDF Line
      const art4 = await storeRawArtifact(db, workspaceId, {
        source: 'statement',
        fileName: 'HDFC_Nov_2026.pdf',
        mimeType: 'application/pdf',
        sha256: '4'.repeat(64),
        sizeBytes: 125000,
      });

      const res4 = await processFinancialObservation(db, workspaceId, art4.id, {
        instrumentType: 'savings',
        issuer: 'HDFC Bank',
        accountTail: '1234',
        channel: 'generic',
        date,
        amountMinor,
        direction: 'out',
        merchantRaw: 'UPI-512345678901-SWIGGY-PAYMENT',
        referenceId: rrn,
        rail: 'upi',
        confidence: 1.0,
      });

      expect(res4.isNew).toBe(false);
      expect(res4.canonicalTxn.observationIds.length).toBe(4);
      expect(res4.canonicalTxn.status).toBe('posted');

      // Verify overall workspace ledger: EXACTLY ONE transaction exists with 4 observations!
      const allTxns = await listCanonicalTransactions(db, workspaceId);
      expect(allTxns.length).toBe(1);
      expect(allTxns[0]!.observations.length).toBe(4);
      expect(allTxns[0]!.amountMinor).toBe(124900);
      expect(allTxns[0]!.reference).toBe(rrn);
    });
  });

  describe('Own-Account Registry & Self-Transfer Resolution', () => {
    it('detects inter-account transfer and credit card settlement between registered accounts', async () => {
      // 1. Register user's HDFC Savings Bank and ICICI Credit Card
      const hdfcBank = await registerOwnAccount(db, workspaceId, {
        type: 'savings',
        institution: 'HDFC Bank',
        accountTail: '1234',
        vpas: ['user@okhdfcbank'],
        isPrimary: true,
      });

      const iciciCard = await registerOwnAccount(db, workspaceId, {
        type: 'card',
        institution: 'ICICI Bank',
        accountTail: '4321',
      });

      const allAccounts = await listOwnAccounts(db, workspaceId);
      expect(allAccounts.length).toBe(2);

      // 2. Debit alert from HDFC Bank paying credit card bill
      const art = await storeRawArtifact(db, workspaceId, {
        source: 'email',
        messageId: '<card-pay-debit@hdfcbank.net>',
        mimeType: 'message/rfc822',
        sha256: '5'.repeat(64),
        sizeBytes: 2100,
      });

      const res = await processFinancialObservation(db, workspaceId, art.id, {
        instrumentType: 'savings',
        issuer: 'HDFC Bank',
        accountTail: '1234',
        channel: 'neft',
        date: '2026-11-05',
        amountMinor: 3500000,
        direction: 'out',
        merchantRaw: 'CREDIT CARD BILL PAYMENT ICICI CARD 4321',
        referenceId: 'HDFCN52026110512345',
        rail: 'neft',
      });

      expect(res.canonicalTxn.isTransfer).toBe(true);
      expect(res.canonicalTxn.category).toBe('Liabilities:CreditCard');
    });
  });
});
