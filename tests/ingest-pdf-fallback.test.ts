import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pdfMarkdownFromRust: vi.fn(),
  pdfLayoutFromRust: vi.fn(),
  pdfOcrFromDocling: vi.fn(),
}));

vi.mock('@/core/ingest/pdf-rust', () => mocks);

import {
  ScannedPdfError,
  parsePdfStatement,
  parsePositionedStatement,
  parseStatementDate,
} from '@/core/ingest';
import type { PdfTextItem } from '@/core/ingest/pdf-rust';

const BYTES = new Uint8Array([1, 2, 3]);

const GOOD_MARKDOWN = `| Date | Description | Out | In | Balance |
| --- | --- | --- | --- | --- |
| 2026-10-01 | B/F |  |  | 1,000.00 |
| 2026-10-02 | UPI PAYMENT | 100.00 |  | 900.00 |
| 2026-10-03 | SALARY CREDIT |  | 500.00 | 1,400.00 |
`;

const BAD_MARKDOWN = `| Date | Description | Out | In | Balance |
| --- | --- | --- | --- | --- |
| 2026-10-01 | B/F |  |  | 1,000.00 |
| 2026-10-02 | UPI PAYMENT | 100.00 |  | 850.00 |
`;

const NO_BALANCE_MARKDOWN = `| Date | Description | Amount |
| --- | --- | --- |
| 2026-10-02 | UPI PAYMENT | 100.00 |
| 2026-10-03 | SALARY CREDIT | 500.00 |
`;

function item(text: string, x: number, y: number, page = 1, width = text.length * 4.5): PdfTextItem {
  return { text, x, y, page, width, height: 8 };
}

function layoutItems(): PdfTextItem[] {
  return [
    item('DATE', 30, 100),
    item('MODE', 80, 100),
    item('PARTICULARS', 120, 100),
    item('DEPOSITS', 300, 100),
    item('WITHDRAWALS', 380, 100),
    item('BALANCE', 470, 100),
    item('01-10-2026', 30, 80),
    item('B/F', 120, 80),
    item('1,000.00', 480, 80),
    item('02-10-2026', 30, 60),
    item('UPI PAYMENT', 120, 60),
    item('100.00', 400, 60),
    item('900.00', 480, 60),
    item('to vendor', 120, 50),
    item('03-10-2026', 30, 30),
    item('SALARY CREDIT', 120, 30),
    item('500.00', 320, 30),
    item('1,400.00', 480, 30),
    item('31-10-2026', 30, 10),
    item('CLOSING BALANCE', 120, 10),
    item('1,400.00', 480, 10),
  ];
}

describe('PDF extraction order', () => {
  beforeEach(() => {
    mocks.pdfMarkdownFromRust.mockReset();
    mocks.pdfLayoutFromRust.mockReset();
    mocks.pdfOcrFromDocling.mockReset();
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: [], page_count: 0 });
  });

  it('uses Docling first when it produces statement rows', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ markdown: GOOD_MARKDOWN });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: BAD_MARKDOWN });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(mocks.pdfOcrFromDocling).toHaveBeenCalledWith(BYTES, undefined);
    expect(mocks.pdfMarkdownFromRust).not.toHaveBeenCalled();
    expect(mocks.pdfLayoutFromRust).not.toHaveBeenCalled();
  });

  it('falls back to anydoc when Docling is unavailable', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: GOOD_MARKDOWN });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(mocks.pdfMarkdownFromRust).toHaveBeenCalledWith(BYTES, undefined);
    expect(mocks.pdfLayoutFromRust).not.toHaveBeenCalled();
  });

  it('uses positioned text when Docling is unavailable and anydoc flattens the table', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: BAD_MARKDOWN });
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: layoutItems(), page_count: 1 });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT to vendor',
      debitMinor: 10_000,
      creditMinor: 0,
      balanceMinor: 90_000,
    });
    expect(statement.rows[1]).toMatchObject({
      date: '2026-10-03',
      creditMinor: 50_000,
      balanceMinor: 140_000,
    });
    expect(statement.openingBalanceMinor).toBe(100_000);
    expect(statement.closingBalanceMinor).toBe(140_000);
  });

  it('prefers layout evidence over an unverifiable anydoc table', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: NO_BALANCE_MARKDOWN });
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: layoutItems(), page_count: 1 });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]?.balanceMinor).toBe(90_000);
    expect(statement.rows[1]?.balanceMinor).toBe(140_000);
  });

  it('keeps anydoc rows for statements without a balance column', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: NO_BALANCE_MARKDOWN });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.every((row) => row.balanceMinor === undefined)).toBe(true);
  });

  it('passes the password to Docling, anydoc and layout', async () => {
    mocks.pdfOcrFromDocling.mockResolvedValue({ code: 'invoke', error: 'docling missing' });
    mocks.pdfMarkdownFromRust.mockResolvedValue({ code: 'encrypted', error: 'encrypted' });
    mocks.pdfLayoutFromRust.mockResolvedValue({
      items: [],
      page_count: 0,
      code: 'encrypted',
      error: 'encrypted',
    });

    await expect(parsePdfStatement(BYTES, { password: 'secret' })).rejects.toThrow(ScannedPdfError);

    expect(mocks.pdfOcrFromDocling).toHaveBeenCalledWith(BYTES, 'secret');
    expect(mocks.pdfMarkdownFromRust).toHaveBeenCalledWith(BYTES, 'secret');
    expect(mocks.pdfLayoutFromRust).toHaveBeenCalledWith(BYTES, 'secret');
  });

  it('reports anydoc, layout and Docling failures', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ code: 'needsOcr', error: 'pages need OCR' });
    mocks.pdfLayoutFromRust.mockResolvedValue({ code: 'pdfInspector', error: 'bad xref' });
    mocks.pdfOcrFromDocling.mockResolvedValue({ code: 'invoke', error: 'docling missing' });

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(ScannedPdfError);
    await expect(parsePdfStatement(BYTES)).rejects.toThrow(
      /anydoc \(needsOcr\) failed: pages need OCR.*layout \(pdfInspector\) failed: bad xref.*Docling failed: docling missing/,
    );
  });
});

describe('positioned statement parsing', () => {
  it('parses compact DDMONYYYY dates used by Indian bank statements', () => {
    expect(parseStatementDate('01OCT2026')).toBe('2026-10-01');
    expect(parseStatementDate('30OCT2026')).toBe('2026-10-30');
  });

  it('does not treat a reference that merely starts with a date as a transaction date', () => {
    expect(parseStatementDate('6OCT202602L')).toBeUndefined();
  });

  it('ignores summary cells that contain a date outside the date column', () => {
    const items = layoutItems();
    items.push(item('SUMMARY', 30, -10));
    items.push(item('08-10-2026', 220, -20));
    const statement = parsePositionedStatement(items);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.map((row) => row.date)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('keeps narration that shares a text run with the date', () => {
    const items = [
      item('DATE', 30, 100),
      item('PARTICULARS', 120, 100),
      item('WITHDRAWALS', 380, 100),
      item('BALANCE', 470, 100),
      item('01-10-2026 B/F', 30, 80),
      item('1,000.00', 480, 80),
      item('02-10-2026 UPI PAYMENT', 30, 60),
      item('100.00', 400, 60),
      item('900.00', 480, 60),
      item('31-10-2026 CLOSING BALANCE', 30, 40),
      item('900.00', 480, 40),
    ];
    const statement = parsePositionedStatement(items);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      balanceMinor: 90_000,
    });
    expect(statement.openingBalanceMinor).toBe(100_000);
    expect(statement.closingBalanceMinor).toBe(90_000);
  });

  it('rejects rows that do not reconcile against the running balance', async () => {
    const broken = layoutItems();
    broken[12] = item('850.00', 480, 60);
    mocks.pdfMarkdownFromRust.mockResolvedValue({});
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: broken, page_count: 1 });
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(
      /layout extracted 2 rows that failed balance verification/,
    );
  });
});
