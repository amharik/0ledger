import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { ensureSeedClassificationRules } from '@/core/autopilot/rules';
import {
  parseInterestCertificate,
  parseNpsStatement,
  parseP2pStatement,
  parsePpfStatement,
} from '@/core/ingest/specialized';
import { parseTextStatement } from '@/core/ingest/parsers';
import { detectStatementAdapter } from '@/core/ingest/adapters';
import { stageImport } from '@/core/ingest/service';
import { captureStatementLines } from '@/core/autopilot/money-events';

describe('Specialized Statements for Credits (NPS, PPF, Interest, P2P)', () => {
  let db: LedgerDatabase;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    const ws = await createWorkspace(db, { name: 'Investments Test Co' });
    workspaceId = ws.workspace.id;
    await ensureSeedClassificationRules(db, workspaceId);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('NPS Statement Parsing (Protean / KFintech)', () => {
    it('parses PRAN, Tier, and subscriber contributions', () => {
      const sample = `
        PROTEAN eGov Technologies Limited (CRA-NSDL)
        Transaction Statement for National Pension System
        PRAN : 110022334455
        Subscriber Name : VIKRAM ADITYA
        Tier: TIER I
        -------------------------------------------------------------
        Date        Transaction Details             NAV     Units      Amount (Rs.)
        -------------------------------------------------------------
        15/04/2026  Subscriber Contribution       34.1250  146.5201     5,000.00
        15/05/2026  Employer Contribution         34.5000  289.8550    10,000.00
      `;

      const stmt = parseNpsStatement(sample);
      expect(stmt.kind).toBe('nps');
      expect(stmt.rows.length).toBe(2);

      expect(stmt.rows[0]!.date).toBe('2026-04-15');
      expect(stmt.rows[0]!.debitMinor).toBe(500000); // 5,000.00
      expect(stmt.rows[0]!.raw.pran).toBe('110022334455');
      expect(stmt.rows[0]!.raw.tier).toBe('TIER I');
      expect(stmt.rows[0]!.raw.isEmployer).toBe(false);
      expect(stmt.rows[0]!.description).toBe('NPS TIER I Subscriber Contribution');

      expect(stmt.rows[1]!.date).toBe('2026-05-15');
      expect(stmt.rows[1]!.debitMinor).toBe(1000000); // 10,000.00
      expect(stmt.rows[1]!.raw.isEmployer).toBe(true);
      expect(stmt.rows[1]!.description).toBe('NPS TIER I Employer Contribution');
    });

    it('detects NPS adapter automatically', () => {
      const text = 'CRA-NSDL Transaction Statement for PRAN 110022334455 National Pension System';
      const adapter = detectStatementAdapter(text, 'nps-statement.pdf');
      expect(adapter.kind).toBe('nps');
    });
  });

  describe('PPF Statement Parsing (Public Provident Fund)', () => {
    it('distinguishes between subscriptions (deposits) and tax-free interest u/s 10(11)', () => {
      const sample = `
        STATE BANK OF INDIA - PUBLIC PROVIDENT FUND PASSBOOK
        PPF A/c No: 10293847565
        ------------------------------------------------------------------
        Date        Particulars                     Deposit (Cr)  Balance (Cr)
        ------------------------------------------------------------------
        05/04/2026  BY TRANSFER - PPF SUBSCRIPTION     50,000.00     50,000.00
        10/08/2026  PPF DEPOSIT VIA CHEQUE            100,000.00    150,000.00
        31/03/2027  INTEREST CREDITED FOR FY 26-27     10,650.00    160,650.00
      `;

      const stmt = parsePpfStatement(sample);
      expect(stmt.kind).toBe('ppf');
      expect(stmt.rows.length).toBe(3);

      // Deposit 1
      expect(stmt.rows[0]!.date).toBe('2026-04-05');
      expect(stmt.rows[0]!.debitMinor).toBe(5000000);
      expect(stmt.rows[0]!.raw.isInterest).toBe(false);

      // Deposit 2
      expect(stmt.rows[1]!.date).toBe('2026-08-10');
      expect(stmt.rows[1]!.debitMinor).toBe(10000000);

      // Annual Interest Credit
      expect(stmt.rows[2]!.date).toBe('2027-03-31');
      expect(stmt.rows[2]!.debitMinor).toBe(1065000);
      expect(stmt.rows[2]!.raw.isInterest).toBe(true);
      expect(stmt.rows[2]!.raw.taxSection).toBe('10(11)');
      expect(stmt.rows[2]!.description).toContain('Interest Credited u/s 10(11)');
    });
  });

  describe('Bank Interest Certificate & TDS Statement Parsing', () => {
    it('parses Savings Interest (80TTA), FD Interest, and TDS deducted (194A)', () => {
      const sample = `
        HDFC BANK LIMITED
        INTEREST CERTIFICATE / STATEMENT FOR FY 2026-2027
        Customer ID: 91827364
        PAN: ABCDE1234F
        -----------------------------------------------------------------
        Date        Description                                   Amount (INR)
        -----------------------------------------------------------------
        30/06/2026  Savings Bank Interest Credited                  2,450.00
        30/09/2026  Fixed Deposit Interest Payout                  45,000.00
        30/09/2026  TDS Deducted u/s 194A on FD Interest            4,500.00
      `;

      const stmt = parseInterestCertificate(sample);
      expect(stmt.kind).toBe('interest');
      expect(stmt.rows.length).toBe(3);

      // SB Interest
      expect(stmt.rows[0]!.date).toBe('2026-06-30');
      expect(stmt.rows[0]!.creditMinor).toBe(245000); // Income credit
      expect(stmt.rows[0]!.raw.type).toBe('savings_interest');
      expect(stmt.rows[0]!.raw.taxSection).toBe('80TTA');

      // FD Interest
      expect(stmt.rows[1]!.date).toBe('2026-09-30');
      expect(stmt.rows[1]!.creditMinor).toBe(4500000); // Income credit
      expect(stmt.rows[1]!.raw.type).toBe('fd_interest');

      // TDS 194A
      expect(stmt.rows[2]!.date).toBe('2026-09-30');
      expect(stmt.rows[2]!.debitMinor).toBe(450000); // Tax Asset receivable
      expect(stmt.rows[2]!.raw.type).toBe('tds_deduction');
      expect(stmt.rows[2]!.raw.taxSection).toBe('194A');
    });
  });

  describe('P2P Lending Statement Parsing (12% Club, Faircent, LenDenClub, CRED Mint)', () => {
    it('distinguishes between P2P interest earnings and principal repayments', () => {
      const sample = `
        12% CLUB (NBFC-P2P LENNDBOX)
        MONTHLY STATEMENT OF ACCOUNT
        Investor: Rohan Gupta
        -------------------------------------------------------------------
        Date        Description                     Amount (Rs.)   Balance
        -------------------------------------------------------------------
        01/05/2026  P2P Lending Fresh Investment     100,000.00    100,000.00
        15/05/2026  P2P Interest Income Payout         1,019.18    101,019.18
        31/05/2026  P2P Principal Repayment           25,000.00     76,019.18
      `;

      const stmt = parseP2pStatement(sample);
      expect(stmt.kind).toBe('p2p');
      expect(stmt.rows.length).toBe(3);

      // Fresh Investment
      expect(stmt.rows[0]!.date).toBe('2026-05-01');
      expect(stmt.rows[0]!.debitMinor).toBe(10000000); // 100,000.00 investment
      expect(stmt.rows[0]!.raw.type).toBe('p2p_investment');

      // Interest Income
      expect(stmt.rows[1]!.date).toBe('2026-05-15');
      expect(stmt.rows[1]!.creditMinor).toBe(101918); // 1,019.18
      expect(stmt.rows[1]!.raw.type).toBe('p2p_interest');

      // Principal Repayment
      expect(stmt.rows[2]!.date).toBe('2026-05-31');
      expect(stmt.rows[2]!.creditMinor).toBe(2500000); // 25,000.00 principal
      expect(stmt.rows[2]!.raw.type).toBe('p2p_principal');
    });
  });

  describe('End-to-End Ingestion & Autopilot Classification for Specialized Statements', () => {
    it('stages specialized statement and classifies events into seeded ledgers', async () => {
      const npsSample = `
        PROTEAN eGov Technologies (CRA-NSDL)
        National Pension System Statement
        PRAN : 110022334455
        Date        Description                     Amount (Rs.)
        15/04/2026  NPS Subscriber Contribution       5,000.00
      `;

      const stmt = parseTextStatement(npsSample, { fileName: 'nps-statement.txt' });
      expect(stmt.kind).toBe('nps');
      expect(stmt.rows.length).toBe(1);

      // Stage import
      const staged = await stageImport(db, {
        workspaceId,
        source: 'manual',
        statement: stmt,
        fileName: 'nps-statement.txt',
      });
      expect(staged.lines.length).toBe(1);

      // Capture into MoneyEvents
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
      expect(captured.created.length).toBe(1);

      // Check classification suggestion
      const suggestions = await db.classificationSuggestions
        .where('moneyEventId')
        .equals(captured.created[0]!.id)
        .toArray();
      expect(suggestions.length).toBe(1);

      // Target ledger should be 'NPS Investment'
      const targetLedger = await db.ledgers.get(suggestions[0]!.ledgerId!);
      expect(targetLedger?.name).toBe('NPS Investment');
    });
  });
});
