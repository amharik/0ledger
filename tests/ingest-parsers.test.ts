import { describe, expect, it } from 'vitest';
import {
  detectStatementAdapter,
  parseCsvStatement,
  parseEmailStatements,
  parseMarkdownStatement,
  parseStatementAmount,
  parseStatementDate,
  parseTextStatement,
  parseXlsxStatement,
} from '@/core/ingest';

const HDFC_CSV = `HDFC Bank Statement
Account No: 50100123456789
Statement Period: 01/11/2026 to 30/11/2026

Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/2026,UPI-PAID-VENDOR,REF123,"1,500.00",,"98,500.00"
02/11/2026,NEFT RECEIVED FROM CUSTOMER,REF456,,"5,000.00","1,03,500.00"
`;

describe('statement parsing', () => {
  it('parses dates in common Indian formats', () => {
    expect(parseStatementDate('01/11/2026')).toBe('2026-11-01');
    expect(parseStatementDate('1-Nov-2026')).toBe('2026-11-01');
    expect(parseStatementDate('Nov 1, 2026')).toBe('2026-11-01');
    expect(parseStatementDate('2026-11-01')).toBe('2026-11-01');
    expect(parseStatementDate('31/02/2026')).toBeUndefined();
  });

  it('parses statement amounts with Indian grouping and Dr/Cr suffixes', () => {
    expect(parseStatementAmount('1,03,500.00')).toBe(10_350_000);
    expect(parseStatementAmount('1,03,500.00 Cr')).toBe(10_350_000);
    expect(parseStatementAmount('')).toBeUndefined();
  });

  it('detects the bank and parses a CSV with preamble rows', () => {
    const adapter = detectStatementAdapter(HDFC_CSV, 'statement.csv');
    expect(adapter.id).toBe('hdfc');

    const statement = parseCsvStatement(HDFC_CSV);
    expect(statement.adapterId).toBe('hdfc');
    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-11-01',
      description: 'UPI-PAID-VENDOR',
      reference: 'REF123',
      debitMinor: 150_000,
      creditMinor: 0,
      balanceMinor: 9_850_000,
    });
    expect(statement.rows[1]).toMatchObject({
      date: '2026-11-02',
      debitMinor: 0,
      creditMinor: 500_000,
    });
  });

  it('parses Docling Markdown tables with Out/In columns and skips B/F', () => {
    const markdown = `# HDFC Bank Statement

| Date | Description | Out | In | Balance | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-10-01 | B/F |  |  | 12,345.67 | Success |
| 2026-10-02 | UPI PAYMENT | 100.00 |  | 12,245.67 | Success |
| 2026-10-03 | SALARY CREDIT |  | 5,000.00 | 17,245.67 | Success |
`;
    const statement = parseMarkdownStatement(markdown);
    expect(statement.adapterId).toBe('hdfc');
    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 1_224_567,
    });
    expect(statement.rows[1]).toMatchObject({
      date: '2026-10-03',
      description: 'SALARY CREDIT',
      debitMinor: 0,
      creditMinor: 500_000,
    });
  });

  it('parses Docling plain-text output with inline date rows', () => {
    const markdown =
      'HDFC Bank Statement Date Description Out In Balance Status ' +
      '2026-10-01 B/F 12,345.67 Success ' +
      '2026-10-02 UPI PAYMENT 100.00 12,245.67 Success ' +
      '2026-10-03 SALARY CREDIT 5,000.00 17,245.67 Success';
    const statement = parseMarkdownStatement(markdown);
    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 1_224_567,
    });
    expect(statement.rows[1]).toMatchObject({
      date: '2026-10-03',
      debitMinor: 0,
      creditMinor: 500_000,
    });
  });

  it('reconstructs multiline rows, page numbers, and plain-integer amounts', () => {
    const text = `HDFC Bank Statement
Opening Balance 12,345.67
Date Narration Withdrawal Amt Deposit Amt Closing Balance
01/04/2026 UPI/PAYMENT/123
  TO VENDOR
  100
  12,245.67
02/04/2026 SALARY
  CREDIT
  5000
  17,245.67
\f
03/04/2026 CARD
  PURCHASE
  250
  16,995.67
Closing Balance 16,995.67`;
    const statement = parseTextStatement(text);
    expect(statement.openingBalanceMinor).toBe(1_234_567);
    expect(statement.closingBalanceMinor).toBe(1_699_567);
    expect(statement.rows).toHaveLength(3);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-04-01',
      description: 'UPI/PAYMENT/123 TO VENDOR',
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 1_224_567,
      page: 1,
    });
    expect(statement.rows[1]).toMatchObject({
      date: '2026-04-02',
      description: 'SALARY CREDIT',
      debitMinor: 0,
      creditMinor: 500_000,
      page: 1,
    });
    expect(statement.rows[2]).toMatchObject({
      date: '2026-04-03',
      description: 'CARD PURCHASE',
      debitMinor: 25_000,
      creditMinor: 0,
      balanceMinor: 1_699_567,
      page: 2,
    });
  });

  it('parses an XLSX statement', async () => {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Statement');
    sheet.addRow(['HDFC Bank Statement']);
    sheet.addRow(['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance']);
    sheet.addRow(['03/11/2026', 'CARD PAYMENT', 250.5, '', 10_000]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer);
    const statement = await parseXlsxStatement(bytes, { fileName: 'hdfc.xlsx' });
    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({ debitMinor: 25_050, description: 'CARD PAYMENT' });
  });

  it('skips balance-forward PDF rows that have no debit or credit', () => {
    const statement = parseTextStatement(`Date Description Out In Status
2026-10-01 B/F 12,345.67 Cr
2026-10-01 OPENING BALANCE 12,345.67
2026-10-02 UPI PAYMENT 100.00 12,245.67`);
    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      creditMinor: 0,
    });
  });

  it('skips balance-forward rows even when FASTag markers are present', () => {
    const statement = parseTextStatement(`FASTag statement
Date Description Out In Status
2026-10-01 B/F 12,345.67
2026-10-02 TOLL PLAZA 100.00 12,245.67`);
    expect(statement.kind).toBe('fastag');
    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'TOLL PLAZA',
      debitMinor: 10_000,
      creditMinor: 0,
    });
  });

  it('parses a FASTag text statement', () => {
    const statement = parseTextStatement(`FASTag statement
03/11/2026 TOLL PLAZA XYZ 150.00 2,500.00 Dr
04/11/2026 RECHARGE 1,000.00 Cr 3,500.00`);
    expect(statement.adapterId).toBe('fastag');
    expect(statement.kind).toBe('fastag');
    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({ debitMinor: 15_000, creditMinor: 0 });
    expect(statement.rows[1]).toMatchObject({ debitMinor: 0, creditMinor: 100_000 });
  });
});

describe('email ingestion', () => {
  it('parses a bank alert body into a statement line', async () => {
    const eml = `From: HDFC Bank <alerts@hdfcbank.net>
To: owner@example.com
Subject: Transaction alert
Date: Tue, 03 Nov 2026 10:00:00 +0530
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Rs.1,250.00 debited from A/c XX1234 on 03/11/2026. UTR 1234567890.
`;
    const { statements } = await parseEmailStatements(eml);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.rows[0]).toMatchObject({
      date: '2026-11-03',
      debitMinor: 125_000,
      creditMinor: 0,
      reference: '1234567890',
    });
  });

  it('parses a CSV attachment from an eml file', async () => {
    const csv = HDFC_CSV;
    const base64 = btoa(csv);
    const eml = `From: HDFC Bank <statements@hdfcbank.net>
To: owner@example.com
Subject: Your statement
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="BOUNDARY"

--BOUNDARY
Content-Type: text/plain; charset=utf-8

Statement attached.
--BOUNDARY
Content-Type: text/csv; name="hdfc.csv"
Content-Disposition: attachment; filename="hdfc.csv"
Content-Transfer-Encoding: base64

${base64}
--BOUNDARY--
`;
    const { statements } = await parseEmailStatements(eml);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.rows).toHaveLength(2);
  });
});
