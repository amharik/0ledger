import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pdfMarkdownFromRust: vi.fn(),
  pdfLayoutFromRust: vi.fn(),
  pdfOcrFromDocling: vi.fn(),
  pdfJsDocument: vi.fn(),
}));

vi.mock('@/core/ingest/pdf-rust', () => mocks);

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mocks.pdfJsDocument,
}));

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

describe('PDF extraction fallback', () => {
  beforeEach(() => {
    mocks.pdfMarkdownFromRust.mockReset();
    mocks.pdfLayoutFromRust.mockReset();
    mocks.pdfOcrFromDocling.mockReset();
    mocks.pdfJsDocument.mockReset();
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: [], page_count: 0 });
    mocks.pdfJsDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 0,
        getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
      }),
      destroy: async () => {},
    });
  });

  it('uses anydoc when its output parses and balances', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: GOOD_MARKDOWN });
    mocks.pdfOcrFromDocling.mockResolvedValue({ markdown: BAD_MARKDOWN });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(mocks.pdfMarkdownFromRust).toHaveBeenCalledWith(BYTES, undefined);
    expect(mocks.pdfLayoutFromRust).not.toHaveBeenCalled();
    expect(mocks.pdfOcrFromDocling).not.toHaveBeenCalled();
  });

  it('uses positioned text when anydoc flattens the statement table', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: BAD_MARKDOWN });
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: layoutItems(), page_count: 1 });
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });

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
    expect(mocks.pdfOcrFromDocling).not.toHaveBeenCalled();
  });

  it('falls back to Docling when both anydoc and positioned text fail balance verification', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: BAD_MARKDOWN });
    const broken = layoutItems();
    broken[12] = item('850.00', 480, 60);
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: broken, page_count: 1 });
    mocks.pdfOcrFromDocling.mockResolvedValue({ markdown: GOOD_MARKDOWN });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(mocks.pdfOcrFromDocling).toHaveBeenCalledWith(BYTES, undefined);
  });

  it('prefers layout evidence over an unverifiable anydoc table', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: NO_BALANCE_MARKDOWN });
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: layoutItems(), page_count: 1 });
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows[0]?.balanceMinor).toBe(90_000);
    expect(statement.rows[1]?.balanceMinor).toBe(140_000);
    expect(mocks.pdfOcrFromDocling).not.toHaveBeenCalled();
  });

  it('keeps anydoc rows for statements without a balance column', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ markdown: NO_BALANCE_MARKDOWN });
    mocks.pdfLayoutFromRust.mockResolvedValue({ items: [], page_count: 0 });
    mocks.pdfOcrFromDocling.mockResolvedValue({ error: 'not installed' });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.every((row) => row.balanceMinor === undefined)).toBe(true);
    expect(mocks.pdfOcrFromDocling).not.toHaveBeenCalled();
  });

  it('uses pdf.js text when the native extractors are unavailable', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ code: 'desktopRequired', error: 'desktop only' });
    mocks.pdfLayoutFromRust.mockResolvedValue({
      items: [],
      page_count: 0,
      code: 'desktopRequired',
      error: 'desktop only',
    });
    mocks.pdfOcrFromDocling.mockResolvedValue({ code: 'desktopRequired', error: 'desktop only' });
    mocks.pdfJsDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: 'Statement of Account', transform: [1, 0, 0, 1, 30, 100] },
              { str: '01-10-2026 B/F 1,000.00', transform: [1, 0, 0, 1, 30, 80] },
              { str: '02-10-2026 UPI PAYMENT 100.00 900.00', transform: [1, 0, 0, 1, 30, 60] },
            ],
          }),
        }),
      }),
      destroy: async () => {},
    });

    const statement = await parsePdfStatement(BYTES);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]).toMatchObject({
      date: '2026-10-02',
      description: 'UPI PAYMENT',
      debitMinor: 10_000,
      balanceMinor: 90_000,
    });
  });

  it('passes the password to every extractor', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ code: 'encrypted', error: 'encrypted' });
    mocks.pdfOcrFromDocling.mockResolvedValue({ markdown: GOOD_MARKDOWN });

    await parsePdfStatement(BYTES, { password: 'secret' });

    expect(mocks.pdfMarkdownFromRust).toHaveBeenCalledWith(BYTES, 'secret');
    expect(mocks.pdfLayoutFromRust).toHaveBeenCalledWith(BYTES, 'secret');
    expect(mocks.pdfOcrFromDocling).toHaveBeenCalledWith(BYTES, 'secret');
  });

  it('reports anydoc, layout and Docling failures', async () => {
    mocks.pdfMarkdownFromRust.mockResolvedValue({ code: 'needsOcr', error: 'pages need OCR' });
    mocks.pdfLayoutFromRust.mockResolvedValue({ code: 'pdfInspector', error: 'bad xref' });
    mocks.pdfOcrFromDocling.mockResolvedValue({ code: 'invoke', error: 'docling missing' });

    await expect(parsePdfStatement(BYTES)).rejects.toThrow(ScannedPdfError);
    await expect(parsePdfStatement(BYTES)).rejects.toThrow(
      /anydoc \(needsOcr\) failed: pages need OCR.*layout \(pdfInspector\) failed: bad xref.*Docling fallback failed: docling missing/,
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
