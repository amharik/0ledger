import { parseAmountToMinor } from '@/core/money/money';
import { parseStatementDate } from './parsers';
import type { ParsedStatement, ParsedStatementRow, StatementKind } from './types';
import { normalizeText, maskPan } from './accounts';

export interface ExtractedGiftCard {
  platform: string;
  brand: string;
  maskedId?: string | undefined;
  quantity: number;
  maskedQuantity: string;
  orderReference?: string | undefined;
  orderId?: string | undefined;
  validity?: string | undefined;
  denominationMinor?: number | undefined;
  totalAmountMinor?: number | undefined;
  amountMinor?: number | undefined;
  currency?: string | undefined;
  narration?: string | undefined;
}

/**
 * Checks if email subject, body, or sender corresponds to a gift card or shopping voucher confirmation.
 */
export function isGiftCardEmail(subject?: string, text?: string, from?: string): boolean {
  const combined = `${subject ?? ''}\n${from ?? ''}\n${text ?? ''}`.toLowerCase();

  // Specific platforms & senders
  if (
    combined.includes('ishop') ||
    combined.includes('gyftr') ||
    combined.includes('woohoo') ||
    combined.includes('qwikcilver') ||
    combined.includes('giftcards@') ||
    combined.includes('vouchers@')
  ) {
    return true;
  }

  // Voucher booking or confirmation patterns
  const giftCardRegex = /(?:shopping voucher|gift\s*card|instant voucher|e-voucher|gift voucher|e-gift voucher|voucher booking)/i;
  return giftCardRegex.test(combined);
}

/**
 * Extracts complete gift card / shopping voucher details (platform, masked quantity & ID, order reference).
 * Strict compliance: never extracts or stores raw voucher codes or PINs.
 */
export function extractGiftCardDetails(
  text: string,
  subject = '',
  html = '',
): ExtractedGiftCard | undefined {
  const combined = normalizeText(`${subject}\n${text}\n${html}`);

  if (
    !isGiftCardEmail(subject, text, undefined) &&
    !/(?:shopping\s*voucher|gift\s*(?:card|voucher)|e-gift|brand\s*voucher|voucher\s*booking|voucher\s*code|ishop|gyftr|woohoo|qwikcilver|hubble)/i.test(
      combined,
    )
  ) {
    return undefined;
  }

  // 1. Detect platform
  let platform = 'Gift Card Platform';
  if (/ishop/i.test(combined)) platform = 'iShop';
  else if (/gyftr|vouchagram/i.test(combined)) platform = 'Gyftr';
  else if (/woohoo/i.test(combined)) platform = 'Woohoo';
  else if (/qwikcilver|pine\s*labs/i.test(combined)) platform = 'Qwikcilver';
  else if (/amazon/i.test(combined)) platform = 'Amazon';
  else if (/flipkart/i.test(combined)) platform = 'Flipkart';
  else if (/hubble/i.test(combined)) platform = 'Hubble';
  else if (/magicpin/i.test(combined)) platform = 'Magicpin';

  // 2. Brand
  const brand = extractGiftCardBrand(combined, subject);

  // 3. Quantity
  const quantity = extractGiftCardQuantity(combined);
  const maskedQuantity = `Qty: ${quantity}`;

  // 4. Masked ID
  const maskedId = extractMaskedCardId(combined);

  // 5. Order reference
  const { orderId } = extractGiftCardPlatformAndOrderId(combined, subject, undefined);
  const orderMatch = combined.match(
    /\b(?:booking\s*(?:id|#|ref)|order\s*(?:id|#|no|number)|ishp\s*order)[:\s#-]*([A-Za-z0-9_-]{5,32})\b/i,
  );
  const orderReference = orderId ?? orderMatch?.[1];

  // 6. Denomination and total amount
  let denominationMinor: number | undefined;
  const denomMatch = combined.match(
    /\b(?:denomination|voucher\s*value|value)\s*[:\-]?\s*(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{2})?)/i,
  );
  if (denomMatch?.[1]) {
    try {
      denominationMinor = Math.abs(parseAmountToMinor(denomMatch[1]));
    } catch { }
  }

  let totalAmountMinor: number | undefined;
  const totalMatch = combined.match(
    /\b(?:total\s*amount|amount\s*paid|order\s*total|net\s*amount)\s*[:\-]?\s*(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{2})?)/i,
  );
  if (totalMatch?.[1]) {
    try {
      totalAmountMinor = Math.abs(parseAmountToMinor(totalMatch[1]));
    } catch { }
  }

  if (!totalAmountMinor && denominationMinor) {
    totalAmountMinor = denominationMinor * quantity;
  }

  const validity = extractGiftCardValidity(combined);

  return {
    platform,
    brand,
    ...(maskedId ? { maskedId } : {}),
    quantity,
    maskedQuantity,
    ...(orderReference ? { orderReference, orderId: orderReference } : {}),
    ...(denominationMinor ? { denominationMinor } : {}),
    ...(totalAmountMinor ? { totalAmountMinor, amountMinor: totalAmountMinor } : {}),
    ...(validity ? { validity } : {}),
  };
}

/**
 * Extracts only the masked identifier from raw voucher/card number tokens.
 * Complies strictly with privacy standards: never stores unmasked secret codes or PINs.
 */
export function extractMaskedCardId(text: string): string | undefined {
  const combinedRegex =
    /\b(?:card\s*(?:no|number|id)|voucher\s*(?:code|no|number|id)|gift\s*card\s*(?:claim\s*code|code|no|number)|claim\s*code)[:\s=]*([A-Za-z0-9•\*\- ]{4,32})/gi;

  const matches = [...text.matchAll(combinedRegex)];
  for (const m of matches) {
    if (m[1]) {
      const raw = m[1].replace(/[\s-]/g, '').trim();
      if (raw.length >= 4) {
        const tail = raw.slice(-4);
        return `••••${tail}`;
      }
    }
  }

  const maskedToken = text.match(/\b(60\d{2}[xX•\*]{4,12}\d{4})\b/) ?? text.match(/\b([xX•\*]{4,12}\d{4})\b/);
  if (maskedToken?.[1] || maskedToken?.[0]) {
    const raw = (maskedToken[1] ?? maskedToken[0]).replace(/[\s-]/g, '').trim();
    const tail = raw.slice(-4);
    return `••••${tail}`;
  }

  return undefined;
}

/**
 * Extracts quantity of gift cards/vouchers purchased (defaults to 1).
 */
export function extractGiftCardQuantity(text: string): number {
  const qtyMatch =
    text.match(/\b(?:quantity|qty|no\.?\s*of\s*(?:vouchers|cards))[:\s]*(\d+)\b/i) ??
    text.match(/\b(\d+)\s*(?:x\s*(?:rs\.?|₹|inr|voucher|card))\b/i) ??
    text.match(/\b(\d+)\s*(?:voucher|card)s?\b/i);

  if (qtyMatch?.[1]) {
    const parsed = parseInt(qtyMatch[1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 1000) {
      return parsed;
    }
  }

  return 1;
}

/**
 * Extracts validity / expiry date of gift card (critical ledger parameter).
 * Normalizes to ISO YYYY-MM-DD.
 */
export function extractGiftCardValidity(text: string, referenceDate?: string): string | undefined {
  // 1. Explicit date formats (Valid Till: 31/03/2027, Expiry Date: 2027-05-31, Expires on: 30-Jun-2027)
  const validityMatch =
    text.match(/\b(?:valid(?:ity)?\s*(?:till|thru|through|upto|up to|until|date)?|expiry\s*(?:date)?|expires\s*(?:on)?|valid\s*to)[:\s]*([0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+[0-9]{2,4}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2})\b/i);

  if (validityMatch?.[1]) {
    const parsed = parseStatementDate(validityMatch[1]);
    if (parsed) return parsed;
  }

  // 2. Relative validity (e.g. "Validity: 1 Year", "Valid for 12 months")
  const relativeMatch = text.match(/\b(?:valid(?:ity)?\s*(?:for|period)?|expires\s*after)[:\s]*(\d+)\s*(year|month)s?\b/i);
  if (relativeMatch?.[1] && relativeMatch[2]) {
    const num = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const baseDate = referenceDate ? new Date(referenceDate) : new Date();
    if (!isNaN(baseDate.getTime())) {
      const expDate = new Date(baseDate);
      if (unit.startsWith('year')) {
        expDate.setFullYear(expDate.getFullYear() + num);
      } else {
        expDate.setMonth(expDate.getMonth() + num);
      }
      return expDate.toISOString().slice(0, 10);
    }
  }

  return undefined;
}

/**
 * Extracts Brand/Merchant for the voucher (e.g. Amazon Shopping Voucher, Flipkart Gift Card).
 */
export function extractGiftCardBrand(text: string, subject?: string): string {
  const combined = `${subject ?? ''}\n${text}`;

  // Direct brand lines
  const brandMatch =
    combined.match(/\b(?:brand|product|voucher\s*(?:name|for))[:\s]*([^\n\r,;]{3,60})/i);
  if (brandMatch?.[1]) {
    const cleaned = brandMatch[1].replace(/[.,;:]+$/, '').trim();
    if (cleaned.length > 2 && !/^(booking|successful|confirmed|order)$/i.test(cleaned)) {
      return cleaned;
    }
  }

  // Known popular brand patterns
  if (/amazon\s*(?:shopping\s*voucher|pay\s*gift\s*card|gift\s*card)/i.test(combined)) {
    return 'Amazon Shopping Voucher';
  }
  if (/flipkart\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'Flipkart Gift Card';
  }
  if (/swiggy\s*(?:money\s*voucher|voucher|gift\s*card)/i.test(combined)) {
    return 'Swiggy Money Voucher';
  }
  if (/zomato\s*(?:voucher|gift\s*card)/i.test(combined)) {
    return 'Zomato Gift Card';
  }
  if (/makemytrip|mmt\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'MakeMyTrip Gift Card';
  }
  if (/uber\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'Uber Voucher';
  }
  if (/croma\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'Croma Gift Card';
  }
  if (/tata\s*cliq\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'Tata CLiQ Voucher';
  }
  if (/myntra\s*(?:gift\s*card|voucher)/i.test(combined)) {
    return 'Myntra Gift Card';
  }

  if (/ishop/i.test(combined)) {
    return 'iShop Shopping Voucher';
  }
  if (/gyftr/i.test(combined)) {
    return 'Gyftr Instant Voucher';
  }
  if (/woohoo/i.test(combined)) {
    return 'Woohoo Gift Card';
  }

  return 'Shopping Voucher';
}

/**
 * Extracts platform, Order ID / Booking ID for gift card.
 */
export function extractGiftCardPlatformAndOrderId(
  text: string,
  subject?: string,
  from?: string,
): { platform: ExtractedGiftCard['platform']; orderId?: string } {
  const combined = `${subject ?? ''}\n${from ?? ''}\n${text}`;
  const lower = combined.toLowerCase();

  let platform: ExtractedGiftCard['platform'] = 'generic';
  if (lower.includes('ishop')) platform = 'iShop';
  else if (lower.includes('gyftr')) platform = 'Gyftr';
  else if (lower.includes('woohoo')) platform = 'Woohoo';
  else if (lower.includes('qwikcilver')) platform = 'Qwikcilver';
  else if (lower.includes('amazon')) platform = 'Amazon';
  else if (lower.includes('flipkart')) platform = 'Flipkart';

  // Extract Order / Booking Reference
  const orderMatch =
    combined.match(/\b(?:order\s*(?:id|no|#|ref|number)|booking\s*(?:id|ref|no|reference))[:\s#-]*([A-Za-z0-9#-]{5,32})\b/i) ??
    combined.match(/\b(ISHOP[A-Za-z0-9]{4,20})\b/i) ??
    combined.match(/\b(WH-[A-Za-z0-9]{4,20})\b/i);

  const orderId = orderMatch?.[1];

  return { platform, ...(orderId ? { orderId } : {}) };
}

/**
 * Parses gift card booking/order confirmation emails into a structured statement.
 * Injects validity, masked ID, and quantity directly into the ledger parameters.
 */
export function parseGiftCardEmail(input: {
  text: string;
  subject?: string;
  from?: string;
  html?: string;
  date?: string;
}): ParsedStatement | undefined {
  const fullText = normalizeText(`${input.subject ?? ''}\n${input.text}`);
  if (!isGiftCardEmail(input.subject, input.text, input.from)) {
    return undefined;
  }

  // 1. Amount
  const amountMatch =
    fullText.match(/(?:total\s*(?:amount|value)?|voucher\s*(?:value|amount)|denomination|worth|paid)[:\s]*(?:₹|inr|rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    fullText.match(/(?:₹|inr|rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/i);

  if (!amountMatch?.[1]) return undefined;
  let amountMinor = 0;
  try {
    amountMinor = Math.abs(parseAmountToMinor(amountMatch[1]));
  } catch {
    return undefined;
  }
  if (amountMinor === 0) return undefined;

  // 2. Date of transaction
  const dateMatch =
    fullText.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/) ??
    fullText.match(/\b(\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4})\b/);
  const date =
    parseStatementDate(dateMatch?.[1] ?? '') ??
    parseStatementDate(input.date ?? '') ??
    new Date().toISOString().slice(0, 10);

  // 3. Masked ID (Strictly masked, e.g. ••••4829 or 6014••••4829)
  const maskedId = extractMaskedCardId(fullText) ?? '••••' + (amountMinor % 10000).toString().padStart(4, '0');

  // 4. Quantity
  const quantity = extractGiftCardQuantity(fullText);

  // 5. Validity / Expiry (Key parameter in the ledger)
  const validity = extractGiftCardValidity(fullText, date);

  // 6. Brand & Platform
  const brand = extractGiftCardBrand(fullText, input.subject);
  const { platform, orderId } = extractGiftCardPlatformAndOrderId(fullText, input.subject, input.from);

  // 7. Structured Narration for the Ledger
  const valPart = validity ? ` | Valid Till: ${validity}` : '';
  const refPart = orderId ? ` | Ref: ${orderId}` : '';
  const narration = `Gift Voucher: ${brand} (Qty: ${quantity}) | Card: ${maskedId}${valPart}${refPart}`;

  const reference = orderId ?? maskedId;

  const raw: Record<string, unknown> = {
    statementKind: 'giftcard',
    rail: 'giftcard',
    platform,
    brand,
    quantity,
    maskedQuantity: `Qty: ${quantity}`,
    maskedId,
    giftCard: {
      platform,
      brand,
      quantity,
      maskedQuantity: `Qty: ${quantity}`,
      maskedId,
      ...(orderId ? { orderReference: orderId, orderId } : {}),
      ...(validity ? { validity } : {}),
    },
    ...(validity ? { validity } : {}),
    ...(orderId ? { orderId, orderReference: orderId } : {}),
    reference,
    ...(input.subject ? { subject: input.subject.slice(0, 512) } : {}),
    ...(input.from ? { from: input.from.slice(0, 256) } : {}),
  };

  const row: ParsedStatementRow = {
    date,
    ...(validity ? { valueDate: validity } : {}), // Store validity as valueDate in the ledger
    description: narration.slice(0, 1024),
    reference,
    debitMinor: amountMinor, // Payment for gift card asset
    creditMinor: 0,
    currency: 'INR',
    raw,
  };

  return {
    adapterId: `giftcard-${platform}`,
    adapterName: `${platform.toUpperCase()} Gift Voucher`,
    kind: 'giftcard',
    currency: 'INR',
    rows: [row],
    sourceText: fullText,
  };
}
