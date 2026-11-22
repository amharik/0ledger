import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { createLedger } from '@/core/db/ledger-service';
import {
  extractTransactionDetails,
  parseAlertText,
  parseEmailStatements,
} from '@/core/ingest/email';
import { extractGiftCardDetails } from '@/core/ingest/giftcards';
import { identifyUniqueAccount, resolveLedgerForAccount } from '@/core/ingest/accounts';
import { ingestFile, stageImportFromFile } from '@/core/ingest/service';
import { captureStatementLines, approveMoneyEvent } from '@/core/autopilot/money-events';

describe('Gift Cards & Shopping Vouchers Ingestion Engine', () => {
  let db: LedgerDatabase;
  let workspaceId: string;
  let bankLedgerId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ws = await createWorkspace(db, { name: 'Gift Card Test Corp' });
    workspaceId = ws.workspace.id;

    const { ledger: bank } = await createLedger(db, {
      workspaceId,
      name: 'HDFC Current A/c',
      tallyParent: 'Bank Accounts',
      bankAccountNo: '50200012345678',
    });
    bankLedgerId = bank.id;
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('extractGiftCardDetails (Masked Quantity & Masked ID)', () => {
    it('extracts platform, masked quantity, and masked ID from iShop voucher booking email', () => {
      const emailText = `
        Dear Rohan,
        Your Shopping Voucher Booking with iShop is Successful.
        Booking ID: ISHP84920194
        Order Date: 21-Nov-2026
        
        Voucher Details:
        Brand: Amazon Shopping Voucher
        Voucher Code: 849201948201
        Card No: 6014 8511 2345 6789
        PIN: 918273
        Quantity: 2
        Denomination: Rs. 500.00
        Total Amount: Rs. 1,000.00
        
        Thank you for choosing iShop!
      `;

      const result = extractGiftCardDetails(
        emailText,
        'Your Shopping Voucher Booking with iShop is Successful - Order #ISHP84920194',
      );

      expect(result).toBeDefined();
      expect(result?.platform).toBe('iShop');
      expect(result?.brand).toBe('Amazon Shopping Voucher');
      expect(result?.quantity).toBe(2);
      expect(result?.maskedQuantity).toBe('Qty: 2');
      // Must only contain masked ID retaining last 4 digits
      expect(result?.maskedId).toBe('••••8201');
      expect(result?.orderReference).toBe('ISHP84920194');
      expect(result?.denominationMinor).toBe(50000);
      expect(result?.totalAmountMinor).toBe(100000);

      // Verify strict privacy compliance: raw code and PIN are never exposed in result
      const json = JSON.stringify(result);
      expect(json).not.toContain('849201948201');
      expect(json).not.toContain('918273');
      expect(json).not.toContain('6014 8511');
    });

    it('extracts masked ID and quantity from Gyftr / SmartBuy brand voucher emails', () => {
      const gyftrText = `
        Congratulations! Your Gyftr Brand Voucher booking has been processed.
        Order Ref: GYF-98127384
        Brand: Flipkart Gift Card
        Card Number: 6014852233441234
        Voucher Code: FLIP99887766
        PIN: 4321
        Qty: 1
        Amount Paid: INR 2,500.00
      `;

      const result = extractGiftCardDetails(gyftrText, 'Your Gift Voucher Booking with Gyftr is Successful');
      expect(result).toBeDefined();
      expect(result?.platform).toBe('Gyftr');
      expect(result?.quantity).toBe(1);
      expect(result?.maskedQuantity).toBe('Qty: 1');
      expect(['••••1234', '••••7766']).toContain(result?.maskedId);
      expect(result?.orderReference).toBe('GYF-98127384');
      expect(result?.totalAmountMinor).toBe(250000);
    });

    it('extracts masked claim code and quantity from Amazon Pay eGift Card emails', () => {
      const amazonText = `
        Here's your Amazon Pay eGift Card!
        Order # 402-1234567-8901234
        Gift Card Claim Code: ABCD-1234-EFGH-5678
        Quantity: 3
        Gift Card Value: Rs. 500.00 each
        Total Amount: Rs. 1,500.00
      `;

      const result = extractGiftCardDetails(amazonText, 'You have received an Amazon Pay eGift Card');
      expect(result).toBeDefined();
      expect(result?.platform).toBe('Amazon');
      expect(result?.quantity).toBe(3);
      expect(result?.maskedQuantity).toBe('Qty: 3');
      expect(result?.maskedId).toBe('••••5678');
      expect(result?.orderReference).toBe('402-1234567-8901234');
      expect(result?.totalAmountMinor).toBe(150000);
    });

    it('extracts from Woohoo / Qwikcilver voucher emails', () => {
      const woohooText = `
        Woohoo: Your e-Gift Card order has been confirmed.
        Booking ID: WH-77665544
        Brand: Croma e-Voucher
        Card No: 6014-9988-7766-4321
        No. of Vouchers: 1
        Order Total: Rs. 5,000.00
      `;

      const result = extractGiftCardDetails(woohooText, 'Your Woohoo e-Gift Card Booking is Confirmed');
      expect(result).toBeDefined();
      expect(result?.platform).toBe('Woohoo');
      expect(result?.quantity).toBe(1);
      expect(result?.maskedQuantity).toBe('Qty: 1');
      expect(result?.maskedId).toBe('••••4321');
      expect(result?.orderReference).toBe('WH-77665544');
      expect(result?.totalAmountMinor).toBe(500000);
    });
  });

  describe('parseAlertText for Gift Card Booking Notifications', () => {
    it('structures gift card email into a ParsedStatement with kind "giftcard"', () => {
      const emailText = `
        Dear Customer,
        Your Shopping Voucher Booking with iShop is Successful.
        Booking ID: ISHP84920194
        Brand: Amazon Shopping Voucher
        Voucher Code: 849201948201
        PIN: 112233
        Quantity: 2
        Total Amount: Rs. 1,000.00
      `;

      const alert = parseAlertText({
        subject: 'Your Shopping Voucher Booking with iShop is Successful - Order #ISHP84920194',
        text: emailText,
        from: 'vouchers@ishop.in',
      });

      expect(alert).toBeDefined();
      expect(alert?.kind).toBe('giftcard');
      expect(alert?.rows.length).toBe(1);

      const row = alert!.rows[0]!;
      expect(row.debitMinor).toBe(100000); // 1,000.00 debit
      expect(row.creditMinor).toBe(0);
      expect(row.reference).toBe('ISHP84920194');
      expect(row.description).toContain('Gift Voucher: Amazon Shopping Voucher (Qty: 2) | Card: ••••8201');

      // Verify metadata
      const meta = row.raw as any;
      expect(meta.rail).toBe('giftcard');
      expect(meta.giftCard).toBeDefined();
      expect(meta.giftCard.platform).toBe('iShop');
      expect(meta.giftCard.quantity).toBe(2);
      expect(meta.giftCard.maskedQuantity).toBe('Qty: 2');
      expect(meta.giftCard.maskedId).toBe('••••8201');
      expect(meta.giftCard.orderReference).toBe('ISHP84920194');
    });
  });

  describe('Unique Account Identification for Gift Cards', () => {
    it('identifies gift card platform as an account and resolves to "Gift Cards & Vouchers" ledger', async () => {
      const emailText = `
        Your Shopping Voucher Booking with iShop is Successful.
        Booking ID: ISHP84920194
        Voucher Code: 849201948201
        Quantity: 1
        Total Amount: Rs. 500.00
      `;

      const account = identifyUniqueAccount({
        text: emailText,
        subject: 'Your Shopping Voucher Booking with iShop is Successful',
      });

      expect(account).toBeDefined();
      expect(account?.category).toBe('gift_card');
      expect(account?.institution).toBe('iShop');
      expect(account?.accountNumberMasked).toBe('••••8201');

      const ledgerId = await resolveLedgerForAccount(db, workspaceId, account!);
      expect(ledgerId).toBeDefined();

      const ledger = await db.ledgers.get(ledgerId!);
      expect(ledger?.name).toBe('Gift Cards & Vouchers');
    });
  });

  describe('End-to-End .eml Attachment Archival & Ledger Linking', () => {
    it('stores .eml email as an attachment, links to MoneyEvent, and associates with Voucher on posting', async () => {
      const emlContent = [
        'From: iShop Vouchers <vouchers@ishop.in>',
        'To: finance@testcorp.in',
        'Subject: Your Shopping Voucher Booking with iShop is Successful',
        'Date: Sat, 21 Nov 2026 12:00:00 +0530',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Dear Customer,',
        'Your Shopping Voucher Booking with iShop is Successful.',
        'Booking ID: ISHP99881122',
        'Brand: Amazon Shopping Voucher',
        'Voucher Code: 998811224455',
        'PIN: 554433',
        'Quantity: 2',
        'Total Amount: Rs. 2,000.00',
      ].join('\r\n');

      // 1. Import .eml file via stageImportFromFile
      const [staged] = await stageImportFromFile(db, workspaceId, {
        fileName: 'ishop-voucher-ISHP99881122.eml',
        text: emlContent,
      });

      expect(staged).toBeDefined();
      expect(staged!.statement.kind).toBe('giftcard');
      expect(staged!.lines.length).toBe(1);

      // Verify that the .eml was archived in db.attachments
      const attachments = await db.attachments.where('workspaceId').equals(workspaceId).toArray();
      expect(attachments.length).toBe(1);
      const emailAttachment = attachments[0]!;
      expect(emailAttachment.fileName).toBe('ishop-voucher-ISHP99881122.eml');
      expect(emailAttachment.mimeType).toBe('message/rfc822');
      expect(emailAttachment.voucherId).toBeUndefined();

      // 2. Capture statement line into MoneyEvent
      const captured = await captureStatementLines(db, workspaceId, staged!.batch, staged!.lines);
      expect(captured.created.length).toBe(1);

      const event = captured.created[0]!;
      // Verify attachmentId is linked to MoneyEvent
      expect(event.attachmentId).toBe(emailAttachment.id);
      expect(event.sourceRef).toBe('ISHP99881122');
      expect(event.amountMinor).toBe(200000); // 2,000.00

      // 3. Autopilot classification suggestion
      const suggestions = await db.classificationSuggestions
        .where('moneyEventId')
        .equals(event.id)
        .toArray();
      expect(suggestions.length).toBe(1);

      const targetLedger = await db.ledgers.get(suggestions[0]!.ledgerId!);
      expect(targetLedger?.name).toBe('Gift Cards & Vouchers');

      // 4. Approve MoneyEvent into a posted Voucher in ledger
      const postedEvent = await approveMoneyEvent(db, workspaceId, event.id, {
        ledgerId: targetLedger!.id,
        bankLedgerId,
      });

      expect(postedEvent.status).toBe('posted');
      expect(postedEvent.postedVoucherId).toBeDefined();

      // 5. Verify the .eml attachment in db.attachments is now permanently linked to the posted Voucher!
      const updatedAttachment = await db.attachments.get(emailAttachment.id);
      expect(updatedAttachment?.voucherId).toBe(postedEvent.postedVoucherId);

      // Verify double-entry ledger voucher lines
      const voucher = await db.vouchers.get(postedEvent.postedVoucherId!);
      expect(voucher).toBeDefined();
      expect(voucher?.voucherType).toBe('Payment');
      expect(voucher?.reference).toBe('ISHP99881122');
      expect(voucher?.narration).toContain('Gift Voucher: Amazon Shopping Voucher (Qty: 2)');
    });
  });
});
