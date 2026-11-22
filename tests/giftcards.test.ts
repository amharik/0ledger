import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { createLedger } from '@/core/db/ledger-service';
import {
  isGiftCardEmail,
  extractMaskedCardId,
  extractGiftCardQuantity,
  extractGiftCardValidity,
  extractGiftCardBrand,
  parseGiftCardEmail,
} from '@/core/ingest/giftcards';
import { parseAlertText } from '@/core/ingest/email';
import { stageImport } from '@/core/ingest/service';
import { captureStatementLines, approveMoneyEvent } from '@/core/autopilot/money-events';
import { saveEmailAttachment } from '@/core/desktop/mail-sync';

describe('Gift Cards & Shopping Vouchers Ingestion Engine', () => {
  let db: LedgerDatabase;
  let workspaceId: string;
  let bankLedgerId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ws = await createWorkspace(db, { name: 'Gift Card Test Co' });
    workspaceId = ws.workspace.id;

    const { ledger: bank } = await createLedger(db, {
      workspaceId,
      name: 'HDFC Current A/c',
      tallyParent: 'Bank Accounts',
      bankAccountNo: '50200099887766',
    });
    bankLedgerId = bank.id;
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('Detection & Extraction of Gift Card Parameters', () => {
    it('detects gift card confirmation emails accurately', () => {
      expect(
        isGiftCardEmail(
          'Your Shopping Voucher Booking with iShop is Successful - ISHOP98765432',
          'Thank you for your order',
          'alerts@gyftr.com',
        ),
      ).toBe(true);

      expect(
        isGiftCardEmail(
          'Woohoo: Your Gift Card Order #WH-884920 is confirmed',
          'Brand: Flipkart Gift Card',
          'orders@woohoo.in',
        ),
      ).toBe(true);

      expect(
        isGiftCardEmail(
          'Transaction alert from HDFC Bank',
          'Rs 500 debited for grocery purchase',
          'alerts@hdfcbank.net',
        ),
      ).toBe(false);
    });

    it('extracts ONLY masked quantity and ID (never extracts raw codes or pins)', () => {
      // 16-digit card number with partial mask
      const text1 = 'Card Number: 6014 85xx xxxx 4829. Pin: 1234.';
      const maskedId1 = extractMaskedCardId(text1);
      expect(maskedId1).toBe('••••4829');
      expect(maskedId1).not.toContain('1234.'); // Never pin

      // Raw unmasked voucher code
      const text2 = 'Voucher Code: AMZN-XPQR-9988-5678. Voucher Pin: 9876.';
      const maskedId2 = extractMaskedCardId(text2);
      expect(maskedId2).toBe('••••5678');
      expect(maskedId2).not.toContain('9876');

      // Quantity extraction
      expect(extractGiftCardQuantity('Quantity: 2')).toBe(2);
      expect(extractGiftCardQuantity('Qty: 5')).toBe(5);
      expect(extractGiftCardQuantity('Purchased 3 vouchers')).toBe(3);
      expect(extractGiftCardQuantity('No quantity mentioned')).toBe(1);
    });

    it('extracts validity date as a crucial parameter in the ledger', () => {
      // Valid till pattern
      const text1 = 'Valid Till: 31-May-2027';
      expect(extractGiftCardValidity(text1)).toBe('2027-05-31');

      // Expiry date pattern
      const text2 = 'Expiry Date: 2027-12-31';
      expect(extractGiftCardValidity(text2)).toBe('2027-12-31');

      // Relative validity (1 Year from issuance date)
      const text3 = 'Validity: 1 Year from issue date';
      expect(extractGiftCardValidity(text3, '2026-05-12')).toBe('2027-05-12');
    });

    it('extracts brand accurately', () => {
      expect(
        extractGiftCardBrand(
          'Congratulations on your voucher. Brand: Amazon Shopping Voucher.',
          'Your Shopping Voucher Booking with iShop is Successful',
        ),
      ).toBe('Amazon Shopping Voucher');

      expect(
        extractGiftCardBrand('Flipkart Gift Card of Rs 5000', 'Your Woohoo Order is confirmed'),
      ).toBe('Flipkart Gift Card');
    });
  });

  describe('iShop & Gyftr Shopping Voucher Email Ingestion', () => {
    it('parses iShop email and injects validity into valueDate and narration', () => {
      const emailText = `
        Dear Rohan Gupta,
        Congratulations! Your Shopping Voucher Booking with iShop is Successful.

        Order Details:
        Order No: ISHOP98765432
        Date: 12-May-2026
        Brand: Amazon Shopping Voucher
        Voucher Value: Rs. 10,000.00
        Quantity: 2
        Total Amount Paid: Rs. 10,000.00

        Voucher Details:
        Card Number: 6014 85xx xxxx 4829
        Valid Till: 31-May-2027
      `;

      const stmt = parseGiftCardEmail({
        text: emailText,
        subject: 'Your Shopping Voucher Booking with iShop is Successful - ISHOP98765432',
        from: 'vouchers@gyftr.com',
      });

      expect(stmt).toBeDefined();
      expect(stmt!.kind).toBe('giftcard');
      expect(stmt!.rows.length).toBe(1);

      const row = stmt!.rows[0]!;
      expect(row.date).toBe('2026-05-12');
      expect(row.valueDate).toBe('2027-05-31'); // Validity stored as valueDate parameter
      expect(row.debitMinor).toBe(1000000); // 10,000.00
      expect(row.reference).toBe('ISHOP98765432');
      expect(row.description).toContain('Gift Voucher: Amazon Shopping Voucher (Qty: 2)');
      expect(row.description).toContain('Card: ••••4829');
      expect(row.description).toContain('Valid Till: 2027-05-31');
      expect(row.description).toContain('Ref: ISHOP98765432');

      expect(row.raw.statementKind).toBe('giftcard');
      expect(row.raw.platform).toBe('iShop');
      expect(row.raw.quantity).toBe(2);
      expect(row.raw.maskedId).toBe('••••4829');
      expect(row.raw.validity).toBe('2027-05-31');
    });
  });

  describe('End-to-End Vault Archival & Ledger Linking for Gift Cards', () => {
    it('archives .eml attachment to vault, stages gift card row, and associates attachment to posted voucher', async () => {
      const emailContent = `
        Dear Customer,
        Your Shopping Voucher Booking with iShop is Successful.
        Order No: ISHOP11223344
        Date: 15-May-2026
        Brand: Amazon Shopping Voucher
        Voucher Value: Rs. 5,000.00
        Quantity: 1
        Card Number: 6014 85xx xxxx 9911
        Valid Till: 31-May-2027
      `;

      // 1. Archive .eml email to vault
      const emailAttachment = await saveEmailAttachment(
        db,
        workspaceId,
        {
          uid: 602,
          subject: 'Your Shopping Voucher Booking with iShop is Successful',
          from: 'vouchers@gyftr.com',
          date: '2026-05-15',
          raw_base64: btoa(emailContent),
        },
        '/tmp/0ledger_archive',
        'Gift Card Test Co',
        'FY2026-27',
        '2026-05',
      );

      expect(emailAttachment).toBeDefined();
      expect(emailAttachment?.attachmentId).toBeDefined();

      // 2. Parse alert text
      const stmt = parseAlertText({
        text: emailContent,
        subject: 'Your Shopping Voucher Booking with iShop is Successful',
        from: 'vouchers@gyftr.com',
      });

      expect(stmt).toBeDefined();
      expect(stmt!.kind).toBe('giftcard');

      // 3. Stage import
      const staged = await stageImport(db, {
        workspaceId,
        source: 'email',
        statement: stmt!,
        fileName: 'ishop-voucher-602.eml',
      });

      expect(staged.lines.length).toBe(1);
      expect(staged.lines[0]!.valueDate).toBe('2027-05-31');

      // 4. Capture into MoneyEvents with attachmentId
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines, {
        attachmentId: emailAttachment!.attachmentId,
      });

      expect(captured.created.length).toBe(1);
      const event = captured.created[0]!;
      expect(event.attachmentId).toBe(emailAttachment!.attachmentId);
      expect(event.narration).toContain('Valid Till: 2027-05-31');

      // 5. Verify Autopilot suggests 'Gift Cards & Vouchers' ledger
      const suggestions = await db.classificationSuggestions
        .where('moneyEventId')
        .equals(event.id)
        .toArray();
      expect(suggestions.length).toBe(1);

      const targetLedger = await db.ledgers.get(suggestions[0]!.ledgerId!);
      expect(targetLedger?.name).toBe('Gift Cards & Vouchers');

      // 6. Approve MoneyEvent into a double-entry Voucher
      const approved = await approveMoneyEvent(db, workspaceId, event.id, {
        ledgerId: targetLedger!.id,
        bankLedgerId,
      });

      expect(approved.status).toBe('posted');
      expect(approved.postedVoucherId).toBeDefined();

      // 7. Verify attachment is now linked to the posted Voucher
      const updatedAtt = await db.attachments.get(emailAttachment!.attachmentId);
      expect(updatedAtt?.voucherId).toBe(approved.postedVoucherId);
    });
  });
});
