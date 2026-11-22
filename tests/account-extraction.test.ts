import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { createLedger } from '@/core/db/ledger-service';
import {
  identifyAllAccounts,
  identifyUniqueAccount,
  maskPan,
  normalizeText,
  passesLuhnCheck,
  resolveLedgerForAccount,
} from '@/core/ingest/accounts';

describe('Account Identification & Privacy Compliance', () => {
  let db: LedgerDatabase;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ws = await createWorkspace(db, { name: 'Account Test Co' });
    workspaceId = ws.workspace.id;
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('PCI-DSS & DPDP Compliance (Luhn Validation & PAN Masking)', () => {
    it('validates card numbers with Luhn Mod-10 algorithm', () => {
      // Standard test card numbers (valid vs invalid)
      expect(passesLuhnCheck('49927398716')).toBe(true);
      expect(passesLuhnCheck('49927398717')).toBe(false);
      expect(passesLuhnCheck('1234567812345670')).toBe(true);
      expect(passesLuhnCheck('1234567812345679')).toBe(false);
      // Rejects strings too short or too long
      expect(passesLuhnCheck('12345')).toBe(false);
      expect(passesLuhnCheck('123456789012345678901')).toBe(false);
    });

    it('masks raw PANs to retain only the last 4 digits', () => {
      expect(maskPan('4111111111111234')).toBe('••••1234');
      expect(maskPan('5412-7512-3412-3456')).toBe('••••3456');
      expect(maskPan('1234')).toBe('1234');
    });

    it('redacts raw PANs if inadvertently present in email text', () => {
      const emailText = 'Your card 4992-7398-716 has been charged INR 1,500.00 at Starbucks.';
      const accounts = identifyAllAccounts({ text: emailText });
      expect(accounts.length).toBeGreaterThan(0);
      const card = accounts.find((a) => a.category === 'credit_card');
      expect(card).toBeDefined();
      expect(card?.accountNumberMasked).toBe('••••8716');
      expect(card?.accountTail).toBe('8716');
    });
  });

  describe('Unicode NFKC Normalization', () => {
    it('strips non-breaking spaces, zero-width spaces and joiners', () => {
      const raw = 'A/c\u00A0XX7317\u200D\u200B debited';
      const clean = normalizeText(raw);
      expect(clean).toBe('A/c XX7317 debited');
    });
  });

  describe('Regex Patterns for Account Extraction', () => {
    it('extracts bank account tails with various masking prefixes', () => {
      const samples = [
        { text: 'debited from A/c XX7317 towards UPI', expectedTail: '7317', expectedMask: 'XX7317' },
        { text: 'Account No. *******5666 credited with INR 5,000', expectedTail: '5666', expectedMask: '*******5666' },
        { text: 'debited from Acct XXXXXX6377', expectedTail: '6377', expectedMask: 'XXXXXX6377' },
        { text: 'Account Number: XX8151 available balance INR 25,000', expectedTail: '8151', expectedMask: 'XX8151' },
      ];

      for (const sample of samples) {
        const account = identifyUniqueAccount({ text: sample.text });
        expect(account).toBeDefined();
        expect(account?.category).toBe('bank_account');
        expect(account?.accountTail).toBe(sample.expectedTail);
      }
    });

    it('extracts credit card tails and alerts', () => {
      const samples = [
        { text: 'Transaction on your Card ending in 4472 for INR 2,499.00', expectedTail: '4472' },
        { text: 'credit card ending with 1234 was charged INR 999.00', expectedTail: '1234' },
        { text: 'Card No. XXXX2123 used at Amazon India', expectedTail: '2123' },
      ];

      for (const sample of samples) {
        const account = identifyUniqueAccount({ text: sample.text });
        expect(account).toBeDefined();
        expect(account?.category).toBe('credit_card');
        expect(account?.accountTail).toBe(sample.expectedTail);
      }
    });

    it('extracts UPI VPAs as wallets/instruments', () => {
      const email = 'Paid to rahul@okhdfcbank using Google Pay for INR 450.00';
      const account = identifyUniqueAccount({ text: email });
      expect(account).toBeDefined();
      expect(account?.category).toBe('wallet');
      expect(account?.vpa).toBe('rahul@okhdfcbank');
    });

    it('extracts Loan / EMI accounts', () => {
      const email = 'EMI of INR 18,500 due for Loan A/c LA-8921-9901';
      const account = identifyUniqueAccount({ text: email });
      expect(account).toBeDefined();
      expect(account?.category).toBe('loan');
      expect(account?.accountTail).toBe('9901');
    });

    it('extracts NPS PRAN and PPF investment accounts', () => {
      const npsEmail = 'Contribution received for PRAN: 110022334455 Tier I';
      const npsAccount = identifyUniqueAccount({ text: npsEmail });
      expect(npsAccount).toBeDefined();
      expect(npsAccount?.category).toBe('investment');
      expect(npsAccount?.accountTail).toBe('4455');
      expect(npsAccount?.institution).toBe('National Pension System');

      const ppfEmail = 'Deposit of INR 10,000 credited to PPF Account 1029384756';
      const ppfAccount = identifyUniqueAccount({ text: ppfEmail });
      expect(ppfAccount).toBeDefined();
      expect(ppfAccount?.category).toBe('investment');
      expect(ppfAccount?.accountTail).toBe('4756');
    });

    it('identifies shopping platforms (Amazon, Flipkart)', () => {
      const amazonEmail = 'Order confirmation from auto-confirm@amazon.in for order # 404-1234567-8901234';
      const account = identifyUniqueAccount({ text: amazonEmail, from: 'auto-confirm@amazon.in' });
      expect(account).toBeDefined();
      expect(account?.category).toBe('shopping');
      expect(account?.institution).toBe('Amazon');
    });
  });

  describe('Ledger Auto-Mapping (resolveLedgerForAccount)', () => {
    it('matches account tail directly to bankAccountNo in ledger', async () => {
      const { ledger: hdfc } = await createLedger(db, {
        workspaceId,
        name: 'HDFC Bank Salary A/c',
        tallyParent: 'Bank Accounts',
        bankAccountNo: '50100012347317',
      });

      const account = identifyUniqueAccount({ text: 'debited from A/c XX7317 towards UPI' });
      expect(account).toBeDefined();

      const ledgerId = await resolveLedgerForAccount(db, workspaceId, account!);
      expect(ledgerId).toBe(hdfc.id);
    });

    it('matches credit card account to credit card ledger by institution/tail', async () => {
      const { ledger: iciciCard } = await createLedger(db, {
        workspaceId,
        name: 'ICICI Sapphiro Credit Card 4472',
        tallyParent: 'Current Liabilities',
      });

      const account = identifyUniqueAccount({
        text: 'INR 1,200 spent on Card ending in 4472',
        from: 'alerts@icicibank.com',
      });
      expect(account).toBeDefined();

      const ledgerId = await resolveLedgerForAccount(db, workspaceId, account!);
      expect(ledgerId).toBe(iciciCard.id);
    });

    it('matches investment accounts (NPS, PPF) to corresponding investment ledgers', async () => {
      const ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
      const npsLedger = ledgers.find((l) => l.name === 'NPS Investment')!;

      const account = identifyUniqueAccount({ text: 'Contribution to PRAN 110022334455' });
      expect(account).toBeDefined();

      const ledgerId = await resolveLedgerForAccount(db, workspaceId, account!);
      expect(ledgerId).toBe(npsLedger.id);
    });
  });
});
