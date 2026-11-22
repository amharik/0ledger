import type { ParsedStatementRow, StatementAdapter } from './types';
import { parseStatementAmount, parseStatementDate } from './parsers';
import { parseAmountToMinor } from '../money/money';

export interface OcrTextResult {
  text: string;
  confidence: number;
  lines: string[];
}

export interface ExtractedBillInfo {
  vendorName?: string | undefined;
  gstin?: string | undefined;
  invoiceNumber?: string | undefined;
  date?: string | undefined;
  totalMinor?: number | undefined;
  taxMinor?: number | undefined;
  confidence: number;
  rawText: string;
}

const DATE_REGEX =
  /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})\b/;
const GSTIN_REGEX = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/i;
const INVOICE_NO_REGEX =
  /(?:inv(?:oice)?\.?\s*(?:no\.?|num\.?|#|:)|bill\s*(?:no\.?|#|:)|receipt\s*(?:#|no\.?|:))\s*[:.-]?\s*([A-Za-z0-9/-]{3,30})/i;
const AMOUNT_LINE_REGEX =
  /(?:total|grand\s*total|net\s*amount|amount\s*payable|invoice\s*total)\s*[:.-]?\s*(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const TAX_LINE_REGEX =
  /(?:total\s*tax|gst|tax\s*amount|cgst\s*\+\s*sgst|igst)\s*[:.-]?\s*(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i;

/**
 * Extracts structured financial fields from unstructured OCR text.
 */
export function extractBillFields(ocrText: string): ExtractedBillInfo {
  const lines = ocrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let vendorName: string | undefined;
  let gstin: string | undefined;
  let invoiceNumber: string | undefined;
  let date: string | undefined;
  let totalMinor: number | undefined;
  let taxMinor: number | undefined;

  // 1. Search for GSTIN
  const gstinMatch = ocrText.match(GSTIN_REGEX);
  if (gstinMatch?.[0]) {
    gstin = gstinMatch[0].toUpperCase();
  }

  // 2. Search for Vendor name (usually near the top before date/invoice)
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    if (
      line &&
      !/invoice|tax|bill|cash|receipt|gstin|phone|email|date|tel/i.test(line) &&
      line.length >= 3 &&
      line.length <= 60
    ) {
      vendorName = line;
      break;
    }
  }

  // 3. Search for Invoice Number
  const invMatch = ocrText.match(INVOICE_NO_REGEX);
  if (invMatch?.[1]) {
    invoiceNumber = invMatch[1].trim();
  }

  // 4. Search for Date
  const dateMatch = ocrText.match(DATE_REGEX);
  if (dateMatch?.[0]) {
    date = parseStatementDate(dateMatch[0]);
  }

  // 5. Search for Total Amount
  const totalMatch = ocrText.match(AMOUNT_LINE_REGEX);
  if (totalMatch?.[1]) {
    totalMinor = parseAmountToMinor(totalMatch[1]);
  } else {
    // Fallback: look for the highest prominent number near the bottom
    const allAmounts: number[] = [];
    for (const line of lines.slice(-10)) {
      const match = line.match(/(?:₹|inr|rs\.?)?\s*([\d,]+\.\d{2})/i);
      if (match?.[1]) {
        try {
          allAmounts.push(parseAmountToMinor(match[1]));
        } catch {
          // ignore invalid numbers
        }
      }
    }
    if (allAmounts.length > 0) {
      totalMinor = Math.max(...allAmounts);
    }
  }

  // 6. Search for Tax Amount
  const taxMatch = ocrText.match(TAX_LINE_REGEX);
  if (taxMatch?.[1]) {
    taxMinor = parseAmountToMinor(taxMatch[1]);
  }

  // Confidence calculation
  let score = 0.2;
  if (totalMinor && totalMinor > 0) score += 0.3;
  if (date) score += 0.2;
  if (invoiceNumber) score += 0.15;
  if (gstin) score += 0.15;

  return {
    vendorName,
    gstin,
    invoiceNumber,
    date,
    totalMinor,
    taxMinor,
    confidence: Math.min(1.0, score),
    rawText: ocrText,
  };
}

/**
 * Converts OCR text into structured statement rows if text resembles a bank statement table.
 */
export function ocrTextToStatementRows(
  ocrText: string,
  _adapter: StatementAdapter,
): ParsedStatementRow[] {
  const lines = ocrText.split(/\r?\n/);
  const rows: ParsedStatementRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 10) continue;

    const dateMatch = trimmed.match(DATE_REGEX);
    if (!dateMatch?.[0]) continue;

    const date = parseStatementDate(dateMatch[0]);
    if (!date) continue;

    // Look for numbers representing transaction amounts
    const numMatches = [...trimmed.matchAll(/(?:₹|inr|rs\.?)?\s*([\d,]+\.\d{2})/gi)];
    if (numMatches.length === 0) continue;

    const lastMatch = numMatches[numMatches.length - 1];
    if (!lastMatch?.[1]) continue;

    const amountToken = lastMatch[1];
    const amountMinor = parseAmountToMinor(amountToken);
    if (amountMinor <= 0) continue;

    const isCredit = /cr(?:edit)?|deposit|refund|received/i.test(trimmed);

    rows.push({
      date,
      description: trimmed.slice(0, 80),
      debitMinor: isCredit ? 0 : amountMinor,
      creditMinor: isCredit ? amountMinor : 0,
      currency: 'INR',
      raw: { line: trimmed, ocr: true },
    });
  }

  return rows;
}
