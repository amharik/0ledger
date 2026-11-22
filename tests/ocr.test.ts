import { describe, expect, it } from 'vitest';
import { extractBillFields, ocrTextToStatementRows } from '../src/core/ingest/ocr';
import type { StatementAdapter } from '../src/core/ingest/types';

describe('OCR & Document Text Extractor', () => {
  const sampleBillOcr = `
    SUNSHINE STATIONERY AND LOGISTICS
    GSTIN: 29AAAAA0000A1Z5
    Phone: +91 98765 43210
    Tax Invoice
    Invoice No: SSL/2026/1049
    Date: 18-05-2026

    Items:
    1. A4 Copier Paper Reams (Qty 10) - 3,500.00
    2. File Folders Box - 1,500.00

    Taxable Value: 5,000.00
    Total Tax: 900.00
    Grand Total: ₹5,900.00
  `;

  it('extracts vendor, GSTIN, invoice number, date and total from OCR bill text', () => {
    const fields = extractBillFields(sampleBillOcr);
    expect(fields.vendorName).toBe('SUNSHINE STATIONERY AND LOGISTICS');
    expect(fields.gstin).toBe('29AAAAA0000A1Z5');
    expect(fields.invoiceNumber).toBe('SSL/2026/1049');
    expect(fields.date).toBe('2026-05-18');
    expect(fields.totalMinor).toBe(590000); // ₹5,900.00
    expect(fields.taxMinor).toBe(90000); // ₹900.00
    expect(fields.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('extracts statement rows from tabular OCR text', () => {
    const dummyAdapter: StatementAdapter = {
      id: 'generic-bank',
      name: 'Generic Bank',
      kind: 'bank',
      markers: ['Generic'],
    };

    const ocrStatement = `
      01/06/2026 UPI/RENT/PAYMENT 25,000.00
      05/06/2026 CLIENT INVOICE PAYMENT RECEIVED CR 75,000.00
    `;

    const rows = ocrTextToStatementRows(ocrStatement, dummyAdapter);
    expect(rows).toHaveLength(2);
    const row0 = rows[0]!;
    expect(row0.date).toBe('2026-06-01');
    expect(row0.debitMinor).toBe(2500000);
    expect(row0.creditMinor).toBe(0);

    const row1 = rows[1]!;
    expect(row1.date).toBe('2026-06-05');
    expect(row1.debitMinor).toBe(0);
    expect(row1.creditMinor).toBe(7500000);
  });
});
