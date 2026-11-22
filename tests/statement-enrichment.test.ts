import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { createLedger } from '@/core/db/ledger-service';
import { postVoucher } from '@/core/ledger';
import { newId, nowIso } from '@/core/ids';
import { MoneyEventSchema, StatementLineSchema, type StatementLine } from '@/core/model';
import {
  computeTransactionDedupeKey,
  extractSchemaOrgDetails,
  extractTransactionDetails,
  extractTransactionId,
  parseAlertText,
} from '@/core/ingest/email';
import {
  enrichLedgerEntriesFromStatement,
  wrapMultiLineNarrations,
} from '@/core/ingest/enrichment';
import { verifyStatementBalance } from '@/core/ingest/service';

describe('Statement & Transaction Enrichment Engine', () => {
  let db: LedgerDatabase;
  let workspaceId: string;
  let bankLedgerId: string;
  let expenseLedgerId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ws = await createWorkspace(db, { name: 'Enrichment Test Co' });
    workspaceId = ws.workspace.id;

    const { ledger: bank } = await createLedger(db, {
      workspaceId,
      name: 'HDFC Current A/c',
      tallyParent: 'Bank Accounts',
      bankAccountNo: '50200099887766',
    });
    bankLedgerId = bank.id;

    const exp = ws.ledgers.find((l) => l.name === 'Software Subscriptions')!;
    expenseLedgerId = exp.id;
    expenseLedgerId = exp.id;
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('Rail-Specific Transaction ID Extraction', () => {
    it('extracts UPI 12-digit RRN / UPI Reference', () => {
      const samples = [
        'UPI-SWIGGY-swiggy@icici-109348018106-PAYMENT',
        'Your A/c XX7317 debited by Rs. 240.00 via UPI Ref: 109348018106 on 12-May-24',
        'UPI/P2M/109348018106/ZOMATO_STORE/Payment',
        'RRN: 987654321012 for your transfer of Rs 500',
      ];
      for (const sample of samples) {
        const result = extractTransactionDetails(sample);
        expect(result).toBeDefined();
        expect(result?.rail).toBe('upi');
        expect(result?.id.length).toBe(12);
      }
    });

    it('extracts RTGS 22-character UTR with bank IFSC prefix', () => {
      const sample = 'RTGS CR: SBIN2268001234567 credited to your account INR 2,50,000.00';
      const result = extractTransactionDetails(sample);
      expect(result).toBeDefined();
      expect(result?.rail).toBe('rtgs');
      expect(result?.id).toBe('SBIN2268001234567');
    });

    it('extracts NEFT 16-22 character UTR / Batch Ref', () => {
      const sample = 'NEFT CR-HDFC0001234-ACME CORP-N123456789012345';
      const result = extractTransactionDetails(sample);
      expect(result).toBeDefined();
      expect(result?.rail).toBe('neft');
      expect(result?.id).toBe('N123456789012345');
    });

    it('extracts IMPS Reference numbers', () => {
      const sample = 'IMPS Ref 412389102938 processed successfully';
      const result = extractTransactionDetails(sample);
      expect(result).toBeDefined();
      expect(result?.rail).toBe('imps');
      expect(result?.id).toBe('412389102938');
    });

    it('extracts Card Authorization codes (6 alphanumeric chars)', () => {
      const sample = 'Transaction approved. Auth Code: 048221 at POS terminal';
      const result = extractTransactionDetails(sample);
      expect(result).toBeDefined();
      expect(result?.rail).toBe('card_auth');
      expect(result?.id).toBe('048221');
    });

    it('extracts E-commerce Order IDs (Amazon 3-7-7 and Flipkart OD...) format', () => {
      const amazonSample = 'Your Amazon order 404-1234567-8901234 has been confirmed';
      const amzResult = extractTransactionDetails(amazonSample);
      expect(amzResult).toBeDefined();
      expect(amzResult?.rail).toBe('order');
      expect(amzResult?.id).toBe('404-1234567-8901234');

      const flipkartSample = 'Your order OD123456789012345678 has been shipped';
      const fkResult = extractTransactionDetails(flipkartSample);
      expect(fkResult).toBeDefined();
      expect(fkResult?.rail).toBe('order');
      expect(fkResult?.id).toBe('OD123456789012345678');
    });

    it('falls back to Message-ID if no rail reference is present in text', () => {
      const sample = 'Your account has been debited by Rs. 50.00 for alert fee.';
      const result = extractTransactionDetails(sample, undefined, {
        messageId: '<202611221122.ABC998877@bank.com>',
      });
      expect(result).toBeDefined();
      expect(result?.rail).toBe('message_id');
      expect(result?.id).toBe('202611221122.ABC998877@bank.com');
    });
  });

  describe('Tier 1: Schema.org JSON-LD Extraction', () => {
    it('extracts Order details from HTML email script tags', () => {
      const html = `
        <html>
        <head>
          <script type="application/ld+json">
          {
            "@context": "http://schema.org",
            "@type": "Order",
            "orderNumber": "402-9988776-1122334",
            "price": "1499.00",
            "priceCurrency": "INR",
            "seller": {
              "@type": "Organization",
              "name": "Cloudtail India"
            }
          }
          </script>
        </head>
        <body>
          <p>Thank you for your order!</p>
        </body>
        </html>
      `;

      const details = extractSchemaOrgDetails(html);
      expect(details).toBeDefined();
      expect(details?.orderNumber).toBe('402-9988776-1122334');
      expect(details?.amountMinor).toBe(149900);
      expect(details?.currency).toBe('INR');
      expect(details?.merchantName).toBe('Cloudtail India');

      const alert = parseAlertText({
        text: 'Order confirmed',
        html,
        from: 'auto-confirm@amazon.in',
      });
      expect(alert).toBeDefined();
      expect(alert?.rows[0]!.reference).toBe('402-9988776-1122334');
      expect(alert?.rows[0]!.debitMinor).toBe(149900);
    });
  });

  describe('Deduplication Key Computation', () => {
    it('computes exact hash when transactionId is present', async () => {
      const key1 = await computeTransactionDedupeKey({
        transactionId: '109348018106',
        date: '2026-05-12',
        amountMinor: 24000,
        direction: 'debit',
      });
      const key2 = await computeTransactionDedupeKey({
        transactionId: '109348018106',
        date: '2026-05-13',
        amountMinor: 24000,
        direction: 'debit',
      });
      expect(key1).toBe(key2);
    });

    it('computes sliding window composite hash when transactionId is absent', async () => {
      const key1 = await computeTransactionDedupeKey({
        accountTail: '7317',
        date: '2026-05-12',
        amountMinor: 24000,
        direction: 'debit',
        payee: 'Swiggy',
      });
      const key2 = await computeTransactionDedupeKey({
        accountTail: '7317',
        date: '2026-05-12',
        amountMinor: 24000,
        direction: 'debit',
        payee: 'SWIGGY',
      });
      expect(key1).toBe(key2);
    });
  });

  describe('Multi-Line Narration Wrapping', () => {
    it('appends continuation lines lacking dates to the preceding row', () => {
      const rawRows = [
        {
          date: '12/05/2026',
          narration: 'UPI-SWIGGY-swiggy@icici-109348018106',
          debitMinor: 45000,
          creditMinor: 0,
        },
        {
          date: '',
          narration: 'PAYMENT TO FOOD DELIVERY MUMBAI',
          debitMinor: 0,
          creditMinor: 0,
        },
        {
          date: '14/05/2026',
          narration: 'NEFT CR-HDFC0001234-ACME CORP',
          debitMinor: 0,
          creditMinor: 1000000,
        },
      ];

      const wrapped = wrapMultiLineNarrations(rawRows);
      expect(wrapped.length).toBe(2);
      expect(wrapped[0]!.narration).toBe(
        'UPI-SWIGGY-swiggy@icici-109348018106 PAYMENT TO FOOD DELIVERY MUMBAI',
      );
      expect(wrapped[1]!.narration).toBe('NEFT CR-HDFC0001234-ACME CORP');
    });
  });

  describe('Monthly Statement Enrichment with Ledger Entries', () => {
    it('enriches unposted MoneyEvents with official bank narration and reference without creating duplicates', async () => {
      const now = nowIso();

      const event = MoneyEventSchema.parse({
        id: newId('mev'),
        workspaceId,
        source: 'email',
        sourceRef: '109348018106',
        contentHash: 'a'.repeat(64),
        date: '2026-05-12',
        amountMinor: 45000,
        direction: 'out',
        narration: 'Alert: Rs 450 debited',
        confidence: 0.8,
        status: 'captured',
        createdAt: now,
        updatedAt: now,
      });
      await db.moneyEvents.add(event);

      const statementLine: StatementLine = StatementLineSchema.parse({
        id: newId('stl'),
        workspaceId,
        importBatchId: newId('imp'),
        lineNo: 1,
        date: '2026-05-12',
        valueDate: '2026-05-12',
        description: 'UPI-SWIGGY-swiggy@icici-109348018106-PAYMENT TO SWIGGY FOODS',
        reference: '109348018106',
        debitMinor: 45000,
        creditMinor: 0,
        balanceMinor: 955000,
        currency: 'INR',
        matchStatus: 'unmatched',
        createdAt: now,
        updatedAt: now,
      });
      await db.statementLines.add(statementLine);

      const result = await enrichLedgerEntriesFromStatement(db, workspaceId, {
        lines: [statementLine],
      });

      expect(result.enrichedMoneyEvents).toBe(1);
      expect(result.reconciledVouchers).toBe(0);

      const updatedEvent = await db.moneyEvents.get(event.id);
      expect(updatedEvent?.statementLineId).toBe(statementLine.id);
      expect(updatedEvent?.narration).toBe(
        'UPI-SWIGGY-swiggy@icici-109348018106-PAYMENT TO SWIGGY FOODS',
      );
      expect(updatedEvent?.confidence).toBeGreaterThanOrEqual(0.95);

      const updatedLine = await db.statementLines.get(statementLine.id);
      expect(updatedLine?.matchStatus).toBe('matched');
      expect(updatedLine?.matchConfidence).toBe(1.0);
    });

    it('auto-reconciles against posted vouchers if event or voucher was already posted', async () => {
      const now = nowIso();

      const { voucher } = await postVoucher(
        db,
        {
          workspaceId,
          voucherType: 'Payment',
          date: '2026-05-12',
          reference: '109348018106',
          narration: 'Swiggy lunch',
          source: 'manual',
          status: 'regular',
          currency: 'INR',
          reverseCharge: false,
          groupIds: [],
          tags: [],
          items: [],
          lines: [
            { ledgerId: expenseLedgerId, amountMinor: 45000, currency: 'INR', billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
            { ledgerId: bankLedgerId, amountMinor: -45000, currency: 'INR', billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
          ],
        },
        { actor: 'tester' },
      );

      const event = MoneyEventSchema.parse({
        id: newId('mev'),
        workspaceId,
        source: 'email',
        sourceRef: '109348018106',
        contentHash: 'b'.repeat(64),
        date: '2026-05-12',
        amountMinor: 45000,
        direction: 'out',
        narration: 'Alert: Rs 450 debited',
        confidence: 1.0,
        status: 'posted',
        postedVoucherId: voucher.id,
        createdAt: now,
        updatedAt: now,
      });
      await db.moneyEvents.add(event);

      const statementLine: StatementLine = StatementLineSchema.parse({
        id: newId('stl'),
        workspaceId,
        importBatchId: newId('imp'),
        lineNo: 1,
        date: '2026-05-12',
        description: 'UPI-SWIGGY-swiggy@icici-109348018106-PAYMENT',
        reference: '109348018106',
        debitMinor: 45000,
        creditMinor: 0,
        currency: 'INR',
        matchStatus: 'unmatched',
        createdAt: now,
        updatedAt: now,
      });
      await db.statementLines.add(statementLine);

      const result = await enrichLedgerEntriesFromStatement(db, workspaceId, {
        lines: [statementLine],
      });

      expect(result.reconciledVouchers).toBe(1);

      const updatedLine = await db.statementLines.get(statementLine.id);
      expect(updatedLine?.matchStatus).toBe('matched');
      expect(updatedLine?.matchedVoucherId).toBe(voucher.id);

      const recs = await db.reconciliations.where('statementLineId').equals(statementLine.id).toArray();
      expect(recs.length).toBe(1);
      expect(recs[0]!.voucherId).toBe(voucher.id);
      expect(recs[0]!.status).toBe('confirmed');
    });
  });

  describe('Closed-Loop Balance Invariant Verification', () => {
    it('verifies running balance integrity: B_k = B_{k-1} + C_k - D_k', () => {
      const now = nowIso();
      const lines: StatementLine[] = [
        StatementLineSchema.parse({
          id: newId('stl'),
          workspaceId,
          importBatchId: newId('imp'),
          lineNo: 1,
          date: '2026-05-01',
          description: 'Opening row',
          debitMinor: 0,
          creditMinor: 0,
          balanceMinor: 100000,
          currency: 'INR',
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
        StatementLineSchema.parse({
          id: newId('stl'),
          workspaceId,
          importBatchId: newId('imp'),
          lineNo: 2,
          date: '2026-05-02',
          description: 'Deposit',
          debitMinor: 0,
          creditMinor: 50000,
          balanceMinor: 150000,
          currency: 'INR',
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
        StatementLineSchema.parse({
          id: newId('stl'),
          workspaceId,
          importBatchId: newId('imp'),
          lineNo: 3,
          date: '2026-05-03',
          description: 'Withdrawal',
          debitMinor: 30000,
          creditMinor: 0,
          balanceMinor: 120000,
          currency: 'INR',
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
      ];

      const assertion = verifyStatementBalance(lines);
      expect(assertion.checked).toBe(2);
      expect(assertion.mismatches.length).toBe(0);
    });

    it('detects and flags balance mismatch when a row is corrupted or missing', () => {
      const now = nowIso();
      const lines: StatementLine[] = [
        StatementLineSchema.parse({
          id: newId('stl'),
          workspaceId,
          importBatchId: newId('imp'),
          lineNo: 1,
          date: '2026-05-01',
          description: 'Opening row',
          debitMinor: 0,
          creditMinor: 0,
          balanceMinor: 100000,
          currency: 'INR',
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
        StatementLineSchema.parse({
          id: newId('stl'),
          workspaceId,
          importBatchId: newId('imp'),
          lineNo: 2,
          date: '2026-05-02',
          description: 'Corrupted balance line',
          debitMinor: 10000,
          creditMinor: 0,
          balanceMinor: 85000,
          currency: 'INR',
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
      ];

      const assertion = verifyStatementBalance(lines);
      expect(assertion.mismatches.length).toBe(1);
      expect(assertion.mismatches[0]!.lineNo).toBe(2);
      expect(assertion.mismatches[0]!.expectedMinor).toBe(90000);
      expect(assertion.mismatches[0]!.actualMinor).toBe(85000);
      expect(assertion.mismatches[0]!.differenceMinor).toBe(-5000);
    });
  });
});
