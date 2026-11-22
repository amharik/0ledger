import { describe, expect, it } from 'vitest';
import {
  parseGstr2bJson,
  parseGstr2bCsv,
  reconcileGstr2bWithBooks,
  type BookPurchase,
} from '../src/core/gst/gstr2b';

describe('GSTR-2B Reconciler', () => {
  const sampleJson = JSON.stringify({
    gstin: '29ABCDE1234F1Z5',
    fp: '042026',
    data: {
      b2b: [
        {
          ctin: '27AAACB2894G1ZN',
          cname: 'Apex Infotech Solutions',
          inv: [
            {
              inum: 'INV/2026/042',
              idt: '15-04-2026',
              val: 11800.0,
              pos: '29',
              inv_typ: 'R',
              itcavl: 'Y',
              items: [
                {
                  num: 1,
                  txval: 10000.0,
                  rt: 18.0,
                  iamt: 1800.0,
                  camt: 0.0,
                  samt: 0.0,
                  csamt: 0.0,
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const sampleCsv = `GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value,Place of supply,Reverse Charge,Applicable % of Tax Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax,Cess,GSTR-1/IFF/GSTR-5 Filing Date,ITC Availability,Reason
27AAACB2894G1ZN,Apex Infotech Solutions,INV/2026/042,Regular,15-04-2026,11800.00,29-Karnataka,No,18,10000.00,1800.00,0.00,0.00,0.00,11-05-2026,Yes,`;

  it('parses GST portal JSON correctly into minor integer units', () => {
    const records = parseGstr2bJson(sampleJson);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.supplierGstin).toBe('27AAACB2894G1ZN');
    expect(rec.supplierName).toBe('Apex Infotech Solutions');
    expect(rec.invoiceNumber).toBe('INV/2026/042');
    expect(rec.invoiceDate).toBe('2026-04-15');
    expect(rec.invoiceValueMinor).toBe(1180000); // ₹11,800.00
    expect(rec.taxableValueMinor).toBe(1000000); // ₹10,000.00
    expect(rec.igstMinor).toBe(180000); // ₹1,800.00
    expect(rec.totalTaxMinor).toBe(180000);
    expect(rec.itcAvailable).toBe(true);
  });

  it('parses GST portal CSV export correctly', () => {
    const records = parseGstr2bCsv(sampleCsv);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.supplierGstin).toBe('27AAACB2894G1ZN');
    expect(rec.invoiceNumber).toBe('INV/2026/042');
    expect(rec.invoiceValueMinor).toBe(1180000);
    expect(rec.totalTaxMinor).toBe(180000);
  });

  it('identifies exact matches with book purchases', () => {
    const records = parseGstr2bJson(sampleJson);
    const books: BookPurchase[] = [
      {
        voucherId: 'vch_001',
        voucherNumber: 'PUR-001',
        voucherDate: '2026-04-15',
        partyName: 'Apex Infotech Solutions',
        partyGstin: '27AAACB2894G1ZN',
        invoiceNumber: 'INV/2026/042',
        taxableValueMinor: 1000000,
        taxAmountMinor: 180000,
        totalAmountMinor: 1180000,
      },
    ];

    const { items, summary } = reconcileGstr2bWithBooks(records, books, '2026-04');
    expect(summary.matchedCount).toBe(1);
    expect(summary.missingInBooksCount).toBe(0);
    expect(summary.missingIn2bCount).toBe(0);
    expect(summary.claimedItcMinor).toBe(180000);
    expect(items[0]?.status).toBe('matched');
  });

  it('identifies invoices in GSTR-2B missing in books', () => {
    const records = parseGstr2bJson(sampleJson);
    const books: BookPurchase[] = [];

    const { items, summary } = reconcileGstr2bWithBooks(records, books, '2026-04');
    expect(summary.matchedCount).toBe(0);
    expect(summary.missingInBooksCount).toBe(1);
    expect(summary.unbookedItcMinor).toBe(180000);
    expect(items[0]?.status).toBe('missing_in_books');
  });

  it('identifies invoices in books missing in GSTR-2B (vendor failed to file) and generates follow-up text', () => {
    const records: ReturnType<typeof parseGstr2bJson> = [];
    const books: BookPurchase[] = [
      {
        voucherId: 'vch_002',
        voucherNumber: 'PUR-002',
        voucherDate: '2026-04-20',
        partyName: 'Delta Hardware Suppliers',
        partyGstin: '29XYZAB1234C1Z9',
        invoiceNumber: 'DH/2026/89',
        taxableValueMinor: 500000,
        taxAmountMinor: 90000,
        totalAmountMinor: 590000,
      },
    ];

    const { items, summary } = reconcileGstr2bWithBooks(records, books, '2026-04');
    expect(summary.missingIn2bCount).toBe(1);
    expect(summary.itcAtRiskMinor).toBe(90000);
    const item0 = items[0]!;
    expect(item0.status).toBe('missing_in_2b');
    expect(item0.vendorFollowupText).toContain('Delta Hardware Suppliers');
    expect(item0.vendorFollowupText).toContain('DH/2026/89');
    expect(item0.vendorFollowupText).toContain('claim Input Tax Credit');
  });
});
