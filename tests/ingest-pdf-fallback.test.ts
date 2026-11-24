import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pdfDoclingFromRust: vi.fn(),
}));

vi.mock('@/core/ingest/pdf-rust', () => mocks);

import {
  ScannedPdfError,
  StatementReconciliationError,
  parseMarkdownStatement,
  parsePdfStatement,
  parseStatementDate,
} from '@/core/ingest';

const BYTES = new Uint8Array([1, 2, 3]);

function docling(markdown: string, overrides: Record<string, unknown> = {}) {
  return {
    markdown,
    page_count: 1,
    text_pages: 1,
    ocr_pages: 0,
    mode: 'native',
    ...overrides,
  };
}

const GOOD_MARKDOWN = `| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 900.00 |
| 03-10-2026 | SALARY CREDIT |  | 500.00 | 1,400.00 |
`;

// Captured from Docling 2.x converting a synthetic statement PDF. The source
// PDF and this output contain no real account or customer data.
const DOCLING_TABLE_MARKDOWN = readFileSync(
  new URL('./fixtures/docling-statement.md', import.meta.url),
  'utf8',
);

describe('Docling PDF extraction', () => {
  beforeEach(() => {
    mocks.pdfDoclingFromRust.mockReset();
  });

  it('parses Docling Markdown and records native extraction metadata', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(GOOD_MARKDOWN, { page_count: 2, text_pages: 2 }),
    );

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 90_000,
    });
    expect(statement.metadata).toMatchObject({
      extractor: 'docling-native',
      pageCount: 2,
      textPages: 2,
      ocrPages: 0,
    });
    expect(mocks.pdfDoclingFromRust).toHaveBeenCalledWith(BYTES, undefined, {});
  });

  it('parses a real Docling table, extracts metadata, and reconciles every row', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(docling(DOCLING_TABLE_MARKDOWN));

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(16);
    expect(statement.openingBalanceMinor).toBe(10_000_000);
    expect(statement.closingBalanceMinor).toBe(19_470_000);
    expect(statement.metadata).toMatchObject({
      accountNumberMasked: '••••7890',
      accountTail: '7890',
      accountCategory: 'bank_account',
      institution: 'HDFC Bank',
      accountHolder: 'SYNTHETIC TRADERS PVT LTD',
      ifsc: 'HDFC0001234',
      branch: 'MG Road',
      statementFrom: '2026-10-01',
      statementTo: '2026-10-31',
      extractor: 'docling-native',
    });
    expect(statement.metadata?.repairedRows).toBeUndefined();
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT TO VENDOR',
      debitMinor: 150_000,
      creditMinor: 0,
      balanceMinor: 9_850_000,
    });
    expect(statement.rows[15]).toMatchObject({
      date: '2026-10-30',
      creditMinor: 1_750_000,
      balanceMinor: 19_470_000,
    });
  });

  it('records OCR mode when Docling had to fall back to OCR', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(GOOD_MARKDOWN, { mode: 'ocr', page_count: 1, text_pages: 0, ocr_pages: 1 }),
    );

    const statement = await parsePdfStatement(BYTES);

    expect(statement.metadata).toMatchObject({
      extractor: 'docling-ocr',
      textPages: 0,
      ocrPages: 1,
    });
  });

  it('forwards the password and progress callback to Docling', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(docling(GOOD_MARKDOWN));
    const onProgress = vi.fn();

    await parsePdfStatement(BYTES, { password: 'secret', onProgress });

    expect(mocks.pdfDoclingFromRust).toHaveBeenCalledWith(BYTES, 'secret', { onProgress });
  });

  it('raises a scanned-PDF error when Docling is unavailable', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue({
      markdown: '',
      page_count: 0,
      text_pages: 0,
      ocr_pages: 0,
      mode: 'unavailable',
      code: 'invoke',
      error: 'docling missing',
    });

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(ScannedPdfError);
    await expect(parsePdfStatement(BYTES)).rejects.toThrow(/Docling \(invoke\): docling missing/);
  });

  it('raises a scanned-PDF error when Docling finds no statement rows', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| not a row | nothing | | | |
`),
    );

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(
      /Docling returned no statement rows/,
    );
  });

  it('repairs a debit/credit column that was extracted on the wrong side', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT |  | 100.00 | 900.00 |
`),
    );

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 90_000,
    });
    expect(statement.metadata?.repairedRows).toBe(1);
  });

  it('repairs a missing running balance from the surrounding rows', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  |  |
| 03-10-2026 | SALARY CREDIT |  | 500.00 | 1,400.00 |
`),
    );

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]?.balanceMinor).toBe(90_000);
    expect(statement.metadata?.repairedRows).toBe(1);
  });

  it('rejects rows that do not reconcile against the running balance', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 850.00 |
`),
    );

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(StatementReconciliationError);
    await expect(parsePdfStatement(BYTES)).rejects.toThrow(/does not reconcile/i);
  });

  it('rejects a closing balance that disagrees with the transaction arithmetic', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 900.00 |
| 31-10-2026 | Closing Balance |  |  | 1,000.00 |
`),
    );

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(StatementReconciliationError);
    await expect(parsePdfStatement(BYTES)).rejects.toThrow(/closing balance/i);
  });

  it('does not let a qualified cumulative balance override the closing balance', async () => {
    mocks.pdfDoclingFromRust.mockResolvedValue(
      docling(`| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 900.00 |

| Label | Amount |
| --- | --- |
| Opening Balance (Cumulative) | 30,231.00 |
| Closing Balance (Cumulative) | 32,822.00 |
`),
    );

    const statement = await parsePdfStatement(BYTES);

    expect(statement.closingBalanceMinor).toBe(90_000);
    expect(statement.rows).toHaveLength(1);
  });

  it('extracts plural account holders and month-name statement periods', async () => {
    const markdown = `ICICI BANK
ACCOUNT HOLDERS : M/S.SYNTHETIC TRADERS
Savings A/c XXXXXXXX9876
## Statement of Transactions in Savings Account XXXXXXXX9876 in INR for the period October 01, 2026 - October 31, 2026

${GOOD_MARKDOWN}`;
    mocks.pdfDoclingFromRust.mockResolvedValue(docling(markdown));

    const statement = await parsePdfStatement(BYTES);

    expect(statement.metadata).toMatchObject({
      accountNumberMasked: 'XXXXXXXX9876',
      accountTail: '9876',
      accountHolder: 'M/S.SYNTHETIC TRADERS',
      institution: 'ICICI Bank',
      statementFrom: '2026-10-01',
      statementTo: '2026-10-31',
    });
  });

  it('extracts statement account metadata without exposing the full account number', async () => {
    const markdown = `HDFC BANK
Account No: 12345678901234
Account Holder: Jane Doe
IFSC: HDFC0001234
Branch: MG Road
Statement Period: 01/10/2026 to 31/10/2026

${GOOD_MARKDOWN}`;
    mocks.pdfDoclingFromRust.mockResolvedValue(docling(markdown));

    const statement = await parsePdfStatement(BYTES);

    expect(statement.metadata).toMatchObject({
      accountNumberMasked: '••••1234',
      accountTail: '1234',
      accountCategory: 'bank_account',
      institution: 'HDFC Bank',
      accountHolder: 'Jane Doe',
      ifsc: 'HDFC0001234',
      branch: 'MG Road',
      statementFrom: '2026-10-01',
      statementTo: '2026-10-31',
    });
    expect(JSON.stringify(statement)).not.toContain('12345678901234');
  });
});

describe('Markdown table stitching', () => {
  it('joins a statement table that continues across a page break', () => {
    const markdown = `| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 900.00 |

| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 03-10-2026 | SALARY CREDIT |  | 500.00 | 1,400.00 |
`;

    const statement = parseMarkdownStatement(markdown);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.map((row) => row.date)).toEqual(['2026-10-02', '2026-10-03']);
    expect(statement.rows[1]).toMatchObject({ creditMinor: 50_000, balanceMinor: 140_000 });
  });

  it('ignores a page-total row instead of merging it into the last transaction', () => {
    const markdown = `| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 01-10-2026 | B/F |  |  | 1,000.00 |
| 02-10-2026 | UPI PAYMENT | 100.00 |  | 900.00 |
|  |  | Total: | 100.00 | 0.00 | 900.00 |

| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 03-10-2026 | SALARY CREDIT |  | 500.00 | 1,400.00 |
`;

    const statement = parseMarkdownStatement(markdown);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.map((row) => row.date)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('joins a row whose cells were split across a page break', () => {
    const markdown = `| Date | Description | Debit | Credit | Balance |
| --- | --- | --- | --- | --- |
| 02-10-2026 | UPI PAYMENT |  |  |  |

|  | to vendor | 100.00 |  | 900.00 |
`;

    const statement = parseMarkdownStatement(markdown);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT to vendor',
      debitMinor: 10_000,
      balanceMinor: 90_000,
    });
  });
});

describe('statement dates', () => {
  it('parses compact DDMONYYYY dates used by Indian bank statements', () => {
    expect(parseStatementDate('01OCT2026')).toBe('2026-10-01');
    expect(parseStatementDate('30OCT2026')).toBe('2026-10-30');
  });

  it('does not treat a reference that merely starts with a date as a transaction date', () => {
    expect(parseStatementDate('6OCT202602L')).toBeUndefined();
  });
});
