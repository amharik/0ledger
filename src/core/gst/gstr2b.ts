import { z } from 'zod';
import Papa from 'papaparse';
import { parseAmountToMinor } from '../money/money';
import { newId, nowIso } from '../ids';

export const Gstr2bInvoiceItemSchema = z.object({
  rate: z.number().default(0),
  taxableValueMinor: z.number().int().default(0),
  igstMinor: z.number().int().default(0),
  cgstMinor: z.number().int().default(0),
  sgstMinor: z.number().int().default(0),
  cessMinor: z.number().int().default(0),
});
export type Gstr2bInvoiceItem = z.infer<typeof Gstr2bInvoiceItemSchema>;

export const Gstr2bRecordSchema = z.object({
  id: z.string(),
  supplierGstin: z.string().min(15).max(15),
  supplierName: z.string().default(''),
  invoiceNumber: z.string(),
  invoiceType: z.string().default('Regular'),
  invoiceDate: z.string(), // YYYY-MM-DD
  invoiceValueMinor: z.number().int(),
  placeOfSupply: z.string().default(''),
  reverseCharge: z.boolean().default(false),
  itcAvailable: z.boolean().default(true),
  itcReason: z.string().optional(),
  filingDate: z.string().optional(),
  taxableValueMinor: z.number().int(),
  igstMinor: z.number().int().default(0),
  cgstMinor: z.number().int().default(0),
  sgstMinor: z.number().int().default(0),
  cessMinor: z.number().int().default(0),
  totalTaxMinor: z.number().int(),
  rawSource: z.enum(['json', 'csv', 'manual']).default('json'),
});
export type Gstr2bRecord = z.infer<typeof Gstr2bRecordSchema>;

export type ReconMatchStatus =
  | 'matched' // Matched in books & 2B (ITC claimable)
  | 'missing_in_books' // In 2B but missing in ledger (Unclaimed invoice!)
  | 'missing_in_2b' // In books / paid, but vendor hasn't filed (ITC at risk!)
  | 'tax_mismatch'; // Both exist, but amounts/taxes disagree

export interface Gstr2bReconItem {
  id: string;
  status: ReconMatchStatus;
  supplierGstin: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  gstr2bRecord?: Gstr2bRecord;
  voucherId?: string;
  voucherNumber?: string;
  voucherDate?: string;
  booksAmountMinor?: number;
  gstr2bAmountMinor?: number;
  booksTaxMinor?: number;
  gstr2bTaxMinor?: number;
  discrepancyNote?: string;
  vendorFollowupText?: string;
}

export interface Gstr2bSummary {
  period: string;
  totalRecordsIn2B: number;
  matchedCount: number;
  missingInBooksCount: number;
  missingIn2bCount: number;
  taxMismatchCount: number;
  totalItcAvailableMinor: number;
  claimedItcMinor: number;
  itcAtRiskMinor: number; // In books, not in 2B
  unbookedItcMinor: number; // In 2B, not yet in books
}

export interface BookPurchase {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  partyName: string;
  partyGstin?: string | undefined;
  invoiceNumber?: string | undefined;
  taxableValueMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
}

function normalizeInvoiceNumber(inv: string): string {
  return inv.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseDdmmyyyy(dateStr: string): string {
  const parts = dateStr.trim().split(/[-/]/);
  const p0 = parts[0];
  const p1 = parts[1];
  const p2 = parts[2];
  if (p0 && p1 && p2) {
    if (p0.length === 2 && p2.length === 4) {
      // DD-MM-YYYY
      return `${p2}-${p1.padStart(2, '0')}-${p0.padStart(2, '0')}`;
    }
    if (p0.length === 4) {
      // YYYY-MM-DD
      return `${p0}-${p1.padStart(2, '0')}-${p2.padStart(2, '0')}`;
    }
  }
  return dateStr;
}

/**
 * Parses official GSTN portal GSTR-2B JSON payload.
 */
export function parseGstr2bJson(jsonString: string): Gstr2bRecord[] {
  const raw = JSON.parse(jsonString);
  const data = raw.data ?? raw;
  const records: Gstr2bRecord[] = [];

  const b2bList = data.b2b ?? [];
  for (const group of b2bList) {
    const ctin = String(group.ctin ?? '').trim().toUpperCase();
    const cname = String(group.cname ?? group.tradeName ?? '').trim();

    const invList = group.inv ?? [];
    for (const inv of invList) {
      const inum = String(inv.inum ?? '').trim();
      const idt = parseDdmmyyyy(String(inv.idt ?? ''));
      const valMinor = Math.round(Number(inv.val ?? 0) * 100);
      const pos = String(inv.pos ?? '');
      const rev = inv.rchrg === 'Y' || inv.rev === true;
      const itcavl = inv.itcavl !== 'N';
      const itcReason = inv.rsn ? String(inv.rsn) : undefined;
      const filingDate = inv.fldt ? parseDdmmyyyy(String(inv.fldt)) : undefined;

      let taxableMinor = 0;
      let igstMinor = 0;
      let cgstMinor = 0;
      let sgstMinor = 0;
      let cessMinor = 0;

      const items = inv.items ?? [];
      for (const item of items) {
        taxableMinor += Math.round(Number(item.txval ?? 0) * 100);
        igstMinor += Math.round(Number(item.iamt ?? 0) * 100);
        cgstMinor += Math.round(Number(item.camt ?? 0) * 100);
        sgstMinor += Math.round(Number(item.samt ?? 0) * 100);
        cessMinor += Math.round(Number(item.csamt ?? 0) * 100);
      }

      const totalTaxMinor = igstMinor + cgstMinor + sgstMinor + cessMinor;

      records.push(
        Gstr2bRecordSchema.parse({
          id: newId('g2b'),
          supplierGstin: ctin,
          supplierName: cname,
          invoiceNumber: inum,
          invoiceType: String(inv.inv_typ ?? 'Regular'),
          invoiceDate: idt,
          invoiceValueMinor: valMinor,
          placeOfSupply: pos,
          reverseCharge: rev,
          itcAvailable: itcavl,
          itcReason,
          filingDate,
          taxableValueMinor: taxableMinor,
          igstMinor,
          cgstMinor,
          sgstMinor,
          cessMinor,
          totalTaxMinor,
          rawSource: 'json',
        }),
      );
    }
  }

  return records;
}

/**
 * Parses official GST Portal GSTR-2B CSV/Excel export.
 */
export function parseGstr2bCsv(csvContent: string): Gstr2bRecord[] {
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const records: Gstr2bRecord[] = [];

  for (const row of parsed.data) {
    const keys = Object.keys(row);
    const getVal = (pattern: RegExp) => {
      const match = keys.find((k) => pattern.test(k));
      return match ? (row[match] ?? '').trim() : '';
    };

    const gstin = getVal(/GSTIN/i).toUpperCase();
    if (!gstin || gstin.length !== 15) continue;

    const name = getVal(/(Trade|Legal).*Name/i);
    const inum = getVal(/Invoice.*Number/i);
    const idt = parseDdmmyyyy(getVal(/Invoice.*Date/i));
    const invValStr = getVal(/Invoice.*Value/i);
    const taxableStr = getVal(/Taxable.*Value/i);
    const igstStr = getVal(/Integrated.*Tax/i);
    const cgstStr = getVal(/Central.*Tax/i);
    const sgstStr = getVal(/State.*Tax/i);
    const cessStr = getVal(/Cess/i);
    const itcAvlStr = getVal(/ITC.*Availability/i);

    const invoiceValueMinor = parseAmountToMinor(invValStr || '0');
    const taxableValueMinor = parseAmountToMinor(taxableStr || '0');
    const igstMinor = parseAmountToMinor(igstStr || '0');
    const cgstMinor = parseAmountToMinor(cgstStr || '0');
    const sgstMinor = parseAmountToMinor(sgstStr || '0');
    const cessMinor = parseAmountToMinor(cessStr || '0');
    const totalTaxMinor = igstMinor + cgstMinor + sgstMinor + cessMinor;

    records.push(
      Gstr2bRecordSchema.parse({
        id: newId('g2b'),
        supplierGstin: gstin,
        supplierName: name,
        invoiceNumber: inum || 'UNKNOWN',
        invoiceType: 'Regular',
        invoiceDate: idt || nowIso().slice(0, 10),
        invoiceValueMinor,
        placeOfSupply: '',
        reverseCharge: false,
        itcAvailable: itcAvlStr.toUpperCase() !== 'N',
        taxableValueMinor,
        igstMinor,
        cgstMinor,
        sgstMinor,
        cessMinor,
        totalTaxMinor,
        rawSource: 'csv',
      }),
    );
  }

  return records;
}

/**
 * Reconciles GSTR-2B parsed records with book purchase records.
 */
export function reconcileGstr2bWithBooks(
  gstr2bRecords: Gstr2bRecord[],
  bookPurchases: BookPurchase[],
  period: string,
): { items: Gstr2bReconItem[]; summary: Gstr2bSummary } {
  const reconItems: Gstr2bReconItem[] = [];
  const matchedBookIds = new Set<string>();

  // Tolerance for minor difference (₹2 = 200 minor units) due to round-off
  const AMOUNT_TOLERANCE_PAISE = 200;

  for (const g2b of gstr2bRecords) {
    const normInv = normalizeInvoiceNumber(g2b.invoiceNumber);

    // Look for matching book purchase by GSTIN + Invoice Number
    let candidate = bookPurchases.find(
      (b) =>
        !matchedBookIds.has(b.voucherId) &&
        b.partyGstin &&
        b.partyGstin.toUpperCase() === g2b.supplierGstin &&
        normalizeInvoiceNumber(b.invoiceNumber || '') === normInv,
    );

    // Secondary heuristic: Match by GSTIN + Amount within tolerance
    if (!candidate) {
      candidate = bookPurchases.find(
        (b) =>
          !matchedBookIds.has(b.voucherId) &&
          b.partyGstin &&
          b.partyGstin.toUpperCase() === g2b.supplierGstin &&
          Math.abs(b.totalAmountMinor - g2b.invoiceValueMinor) <= AMOUNT_TOLERANCE_PAISE,
      );
    }

    // Tertiary heuristic: Match by Normalized Invoice No + Amount
    if (!candidate && normInv.length >= 3) {
      candidate = bookPurchases.find(
        (b) =>
          !matchedBookIds.has(b.voucherId) &&
          normalizeInvoiceNumber(b.invoiceNumber || '') === normInv &&
          Math.abs(b.totalAmountMinor - g2b.invoiceValueMinor) <= AMOUNT_TOLERANCE_PAISE,
      );
    }

    if (candidate) {
      matchedBookIds.add(candidate.voucherId);
      const taxDiff = Math.abs(candidate.taxAmountMinor - g2b.totalTaxMinor);
      const amountDiff = Math.abs(candidate.totalAmountMinor - g2b.invoiceValueMinor);

      if (taxDiff <= AMOUNT_TOLERANCE_PAISE && amountDiff <= AMOUNT_TOLERANCE_PAISE) {
        reconItems.push({
          id: newId('rcn'),
          status: 'matched',
          supplierGstin: g2b.supplierGstin,
          supplierName: g2b.supplierName || candidate.partyName,
          invoiceNumber: g2b.invoiceNumber,
          invoiceDate: g2b.invoiceDate,
          gstr2bRecord: g2b,
          voucherId: candidate.voucherId,
          voucherNumber: candidate.voucherNumber,
          voucherDate: candidate.voucherDate,
          booksAmountMinor: candidate.totalAmountMinor,
          gstr2bAmountMinor: g2b.invoiceValueMinor,
          booksTaxMinor: candidate.taxAmountMinor,
          gstr2bTaxMinor: g2b.totalTaxMinor,
        });
      } else {
        reconItems.push({
          id: newId('rcn'),
          status: 'tax_mismatch',
          supplierGstin: g2b.supplierGstin,
          supplierName: g2b.supplierName || candidate.partyName,
          invoiceNumber: g2b.invoiceNumber,
          invoiceDate: g2b.invoiceDate,
          gstr2bRecord: g2b,
          voucherId: candidate.voucherId,
          voucherNumber: candidate.voucherNumber,
          voucherDate: candidate.voucherDate,
          booksAmountMinor: candidate.totalAmountMinor,
          gstr2bAmountMinor: g2b.invoiceValueMinor,
          booksTaxMinor: candidate.taxAmountMinor,
          gstr2bTaxMinor: g2b.totalTaxMinor,
          discrepancyNote: `Amount diff: ₹${((candidate.totalAmountMinor - g2b.invoiceValueMinor) / 100).toFixed(2)}, Tax diff: ₹${((candidate.taxAmountMinor - g2b.totalTaxMinor) / 100).toFixed(2)}`,
        });
      }
    } else {
      // In GSTR-2B but missing in books!
      reconItems.push({
        id: newId('rcn'),
        status: 'missing_in_books',
        supplierGstin: g2b.supplierGstin,
        supplierName: g2b.supplierName,
        invoiceNumber: g2b.invoiceNumber,
        invoiceDate: g2b.invoiceDate,
        gstr2bRecord: g2b,
        gstr2bAmountMinor: g2b.invoiceValueMinor,
        gstr2bTaxMinor: g2b.totalTaxMinor,
        discrepancyNote: 'Invoice uploaded by supplier in GST portal, but not recorded in 0ledger.',
      });
    }
  }

  // Any book purchase not matched is missing in 2B!
  for (const book of bookPurchases) {
    if (matchedBookIds.has(book.voucherId)) continue;

    const followup = `Hello ${book.partyName || 'Accounts Team'}, our records show invoice ${book.invoiceNumber || book.voucherNumber} dated ${book.voucherDate} for ₹${(book.totalAmountMinor / 100).toFixed(2)} is missing from our GSTR-2B. Kindly ensure this is filed in your GSTR-1 so we can claim Input Tax Credit.`;

    reconItems.push({
      id: newId('rcn'),
      status: 'missing_in_2b',
      supplierGstin: book.partyGstin || 'UNKNOWN',
      supplierName: book.partyName,
      invoiceNumber: book.invoiceNumber || book.voucherNumber,
      invoiceDate: book.voucherDate,
      voucherId: book.voucherId,
      voucherNumber: book.voucherNumber,
      voucherDate: book.voucherDate,
      booksAmountMinor: book.totalAmountMinor,
      booksTaxMinor: book.taxAmountMinor,
      discrepancyNote: 'Recorded in books, but supplier has not uploaded to GSTR-2B. ITC cannot be claimed!',
      vendorFollowupText: followup,
    });
  }

  // Compute Summary
  let totalItcAvailableMinor = 0;
  let claimedItcMinor = 0;
  let itcAtRiskMinor = 0;
  let unbookedItcMinor = 0;

  for (const item of reconItems) {
    if (item.status === 'matched') {
      totalItcAvailableMinor += item.gstr2bTaxMinor ?? 0;
      claimedItcMinor += item.booksTaxMinor ?? 0;
    } else if (item.status === 'missing_in_books') {
      totalItcAvailableMinor += item.gstr2bTaxMinor ?? 0;
      unbookedItcMinor += item.gstr2bTaxMinor ?? 0;
    } else if (item.status === 'missing_in_2b') {
      itcAtRiskMinor += item.booksTaxMinor ?? 0;
    } else if (item.status === 'tax_mismatch') {
      totalItcAvailableMinor += item.gstr2bTaxMinor ?? 0;
      claimedItcMinor += item.booksTaxMinor ?? 0;
    }
  }

  const summary: Gstr2bSummary = {
    period,
    totalRecordsIn2B: gstr2bRecords.length,
    matchedCount: reconItems.filter((i) => i.status === 'matched').length,
    missingInBooksCount: reconItems.filter((i) => i.status === 'missing_in_books').length,
    missingIn2bCount: reconItems.filter((i) => i.status === 'missing_in_2b').length,
    taxMismatchCount: reconItems.filter((i) => i.status === 'tax_mismatch').length,
    totalItcAvailableMinor,
    claimedItcMinor,
    itcAtRiskMinor,
    unbookedItcMinor,
  };

  return { items: reconItems, summary };
}
