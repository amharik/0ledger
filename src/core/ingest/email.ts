import PostalMime, { type Attachment } from 'postal-mime';
import { parseAmountToMinor } from '@/core/money/money';
import { sha256Hex } from '@/core/util/hash';
import { detectStatementAdapter } from './adapters';
import { identifyUniqueAccount, normalizeText, type ExtractedAccount } from './accounts';
import {
  isGiftCardEmail,
  parseGiftCardEmail,
  extractGiftCardDetails,
  type ExtractedGiftCard,
} from './giftcards';
import {
  parseCsvStatement,
  parsePdfStatement,
  parseStatementDate,
  parseTextStatement,
  parseXlsxStatement,
} from './parsers';
import {
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_BODY_CHARS,
  assertByteLimit,
  assertTextLimit,
} from './limits';
import type { ParsedStatement, ParsedStatementRow, StatementKind } from './types';

export interface ParsedEmailAttachment {
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface ParsedEmail {
  subject: string;
  from: string;
  date?: string;
  messageId?: string;
  text: string;
  attachments: ParsedEmailAttachment[];
  raw: { html?: string };
}

export type TransactionRail =
  | 'upi'
  | 'rtgs'
  | 'neft'
  | 'imps'
  | 'card_auth'
  | 'order'
  | 'fastag'
  | 'generic'
  | 'schema_org'
  | 'message_id'
  | 'giftcard';

export interface ExtractedTransaction {
  id: string;
  rail: TransactionRail;
  confidence: number;
}

export interface SchemaOrgOrderDetails {
  type: string;
  orderNumber?: string;
  identifier?: string;
  trackingNumber?: string;
  amountMinor?: number;
  currency?: string;
  merchantName?: string;
}

function bytesOf(attachment: Attachment): ArrayBuffer {
  const content = attachment.content;
  const bytes = bytesFrom(content, attachment.encoding);
  assertByteLimit(bytes, `Attachment ${attachment.filename ?? ''}`.trim());
  return bytes;
}

function bytesFrom(content: Attachment['content'], encoding?: string): ArrayBuffer {
  if (typeof content === 'string') {
    if (encoding === 'base64') {
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    }
    return new TextEncoder().encode(content).buffer;
  }
  if (content instanceof Uint8Array) {
    return Uint8Array.from(content).buffer;
  }
  return content;
}

export async function parseEmail(source: string | ArrayBuffer | Uint8Array): Promise<ParsedEmail> {
  if (typeof source === 'string') assertTextLimit(source, 'Email');
  else assertByteLimit(source, 'Email');
  const email = await PostalMime.parse(source, { attachmentEncoding: 'arraybuffer' });
  if (email.attachments.length > MAX_EMAIL_ATTACHMENTS) {
    throw new Error(`Email has too many attachments (max ${MAX_EMAIL_ATTACHMENTS})`);
  }
  return {
    subject: email.subject ?? '',
    from: email.from?.address ?? '',
    ...(email.date ? { date: email.date } : {}),
    ...(email.messageId ? { messageId: email.messageId } : {}),
    text: (email.text ?? '').slice(0, MAX_EMAIL_BODY_CHARS),
    attachments: email.attachments.map((attachment) => ({
      fileName: (attachment.filename ?? 'attachment').slice(0, 512),
      mimeType: attachment.mimeType,
      bytes: bytesOf(attachment),
    })),
    raw: email.html ? { html: email.html.slice(0, MAX_EMAIL_BODY_CHARS) } : {},
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8377;/gi, '₹')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Tier 1: Schema.org JSON-LD Extraction for E-commerce & Invoices.
 * Parses <script type="application/ld+json"> directly from HTML.
 */
export function extractSchemaOrgDetails(html: string): SchemaOrgOrderDetails | undefined {
  if (!html) return undefined;
  const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const jsonText = match[1];
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] ?? '');
        if (
          type.includes('Order') ||
          type.includes('Invoice') ||
          type.includes('ParcelDelivery') ||
          type.includes('Reservation')
        ) {
          const orderNumber =
            item.orderNumber ??
            item.confirmationNumber ??
            item.identifier ??
            item.partOfOrder?.orderNumber;
          const trackingNumber = item.trackingNumber;
          const merchant =
            item.seller?.name ??
            item.merchant?.name ??
            item.provider?.name ??
            item.broker?.name;

          let amountMinor: number | undefined;
          const price = item.price ?? item.totalPaymentDue?.price ?? item.totalPrice;
          if (price !== undefined) {
            try {
              amountMinor = Math.abs(parseAmountToMinor(String(price)));
            } catch {
              // ignore
            }
          }
          const currency =
            item.priceCurrency ??
            item.totalPaymentDue?.priceCurrency ??
            item.currency ??
            'INR';

          return {
            type,
            ...(orderNumber ? { orderNumber: String(orderNumber).trim() } : {}),
            ...(item.identifier ? { identifier: String(item.identifier).trim() } : {}),
            ...(trackingNumber ? { trackingNumber: String(trackingNumber).trim() } : {}),
            ...(amountMinor !== undefined ? { amountMinor } : {}),
            ...(currency ? { currency } : {}),
            ...(merchant ? { merchantName: String(merchant).trim() } : {}),
          };
        }
      }
    } catch {
      // ignore json parse error
    }
  }
  return undefined;
}

export interface ExtractTxnOptions {
  html?: string;
  messageId?: string;
}

/**
 * Tiered Transaction Identifier Extractor:
 * 1. Tier 1: Schema.org JSON-LD (orders, invoices)
 * 2. Tier 2: Payment Rail specific regex (UPI RRN, RTGS UTR, NEFT UTR, IMPS, Card Auth, Orders)
 * 3. Tier 3: RFC 5322 Message-ID fallback
 */
export function extractTransactionDetails(
  text: string,
  subject?: string,
  options: ExtractTxnOptions = {},
): ExtractedTransaction | undefined {
  // 1. Tier 1: Schema.org JSON-LD
  if (options.html) {
    const schema = extractSchemaOrgDetails(options.html);
    const schemaId = schema?.orderNumber ?? schema?.identifier ?? schema?.trackingNumber;
    if (schemaId) {
      return { id: schemaId, rail: 'schema_org', confidence: 0.98 };
    }
  }

  const combined = normalizeText(`${subject ?? ''}\n${text}`);

  // Gift Card Booking / Order Reference / Masked Voucher ID
  const giftCard = extractGiftCardDetails(combined, subject, options.html);
  if (giftCard) {
    if (giftCard.orderReference) {
      return { id: giftCard.orderReference, rail: 'giftcard', confidence: 0.95 };
    }
    if (giftCard.maskedId) {
      return { id: giftCard.maskedId, rail: 'giftcard', confidence: 0.9 };
    }
  }

  // 2. Tier 2: Payment Rail-Specific Patterns

  // A. UPI RRN (12 numeric digits assigned by NPCI switch)
  const upiMatch =
    combined.match(/\b(?:upi(?:\s*(?:ref|txn|reference)(?:\s*no)?)?|rrn)[:\s/#-]*(\d{12})\b/i) ??
    combined.match(/upi(?:\/p2[amp])?\/(\d{12})\b/i) ??
    combined.match(/\bupi[a-z0-9_@.-]*?[/-](\d{12})\b/i) ??
    combined.match(/upi\/[a-z0-9_-]+\/(\d{12})\b/i);
  if (upiMatch?.[1]) {
    return { id: upiMatch[1], rail: 'upi', confidence: 0.95 };
  }

  // B. RTGS UTR (alphanumeric characters, starting with 4-letter IFSC)
  const rtgsMatch =
    combined.match(/\b([A-Z]{4}\d{18})\b/i) ??
    combined.match(/\b(?:rtgs)(?:\s*(?:no|ref|txn|reference|utr|cr|dr|credit|debit))?[:\s/#-]*([A-Z]{4}[A-Z0-9]{12,18})\b/i);
  if (rtgsMatch?.[1]) {
    return { id: rtgsMatch[1].toUpperCase(), rail: 'rtgs', confidence: 0.95 };
  }

  // C. NEFT UTR (16 to 22 alphanumeric characters, often starting with N or bank IFSC)
  const neftMatch =
    combined.match(/\b(?:neft)(?:\s*(?:no|ref|txn|reference|utr))?[:\s/#-]*([A-Z0-9]{16,22})\b/i) ??
    combined.match(/\b(N\d{15,21})\b/i);
  if (neftMatch?.[1]) {
    return { id: neftMatch[1].toUpperCase(), rail: 'neft', confidence: 0.94 };
  }

  // D. IMPS Reference / RRN (10-12 numeric digits)
  const impsMatch =
    combined.match(/\b(?:imps)(?:\s*(?:ref|txn|reference|rrn)(?:\s*no)?)?[:\s/#-]*(\d{10,16})\b/i) ??
    combined.match(/imps\/[a-z0-9_-]+\/(\d{10,16})\b/i);
  if (impsMatch?.[1]) {
    return { id: impsMatch[1], rail: 'imps', confidence: 0.93 };
  }

  // E. Card Approval / Authorization Code (6 alphanumeric characters)
  const cardAuthMatch =
    combined.match(/\b(?:auth(?:orization)?\s*code|approval\s*code|appr\s*code)[:\s=]*([A-Za-z0-9]{6})\b/i);
  if (cardAuthMatch?.[1]) {
    return { id: cardAuthMatch[1].toUpperCase(), rail: 'card_auth', confidence: 0.92 };
  }

  // F. FASTag Toll Txn ID / Tag ID
  const fastagMatch =
    combined.match(/\b(?:toll\s*(?:txn|transaction)\s*id|fastag\s*(?:txn|ref|id))[:\s#-]*([A-Za-z0-9_-]{6,30})\b/i) ??
    combined.match(/\b(?:tag\s*id)[:\s#-]*([A-Za-z0-9]{10,32})\b/i);
  if (fastagMatch?.[1]) {
    return { id: fastagMatch[1], rail: 'fastag', confidence: 0.9 };
  }

  // G. E-Commerce Order IDs (Amazon 3-7-7, Flipkart OD...)
  const amazonOrderMatch = combined.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  if (amazonOrderMatch?.[1]) {
    return { id: amazonOrderMatch[1], rail: 'order', confidence: 0.95 };
  }
  const flipkartOrderMatch = combined.match(/\b(OD\d{16,20})\b/i);
  if (flipkartOrderMatch?.[1]) {
    return { id: flipkartOrderMatch[1].toUpperCase(), rail: 'order', confidence: 0.94 };
  }

  // H. Generic Order ID / Invoice No
  const orderMatch = combined.match(
    /\b(?:order\s*(?:id|#)|invoice\s*(?:no|#)|bill\s*(?:no|#))[:\s#-]*([A-Za-z0-9#-]{6,30})\b/i,
  );
  if (orderMatch?.[1]) {
    return { id: orderMatch[1], rail: 'order', confidence: 0.85 };
  }

  // I. Universal Transaction ID Fallback Pattern
  const universalMatch = combined.match(
    /(?:upi\s*ref(?:\s*no)?|rrn|ref(?:\s*no|\s*id)?|utr(?:\s*no)?|txn\s*id|transaction\s*id)[:\s=]*([A-Za-z0-9]{6,22})\b/i,
  );
  if (universalMatch?.[1]) {
    return { id: universalMatch[1], rail: 'generic', confidence: 0.8 };
  }

  // 3. Tier 3: RFC 5322 Message-ID fallback
  if (options.messageId) {
    const cleanMsgId = options.messageId.replace(/[<>]/g, '').trim();
    if (cleanMsgId) {
      return { id: cleanMsgId, rail: 'message_id', confidence: 0.6 };
    }
  }

  return undefined;
}

export function extractTransactionId(
  text: string,
  subject?: string,
  options?: ExtractTxnOptions,
): string | undefined {
  const result = extractTransactionDetails(text, subject, options);
  return result?.id;
}

/**
 * Computes canonical deduplication hash:
 * 1. Exact Key: when reference ID is present: SHA256('exact|' + txnId)
 * 2. Windowed Composite Key: when reference ID is absent, clusters by 72-hour sliding window
 *    + accountTail + normalized amount + direction + payee.
 */
export async function computeTransactionDedupeKey(params: {
  transactionId?: string;
  messageId?: string;
  accountTail?: string;
  date: string;
  amountMinor: number;
  direction: string;
  payee?: string;
}): Promise<string> {
  if (params.transactionId) {
    return sha256Hex(`exact|${params.transactionId.trim().toLowerCase()}`);
  }
  if (params.messageId) {
    return sha256Hex(`msgid|${params.messageId.trim().toLowerCase()}`);
  }

  // 72-hour sliding time window calculation
  const epochDays = Math.floor(new Date(params.date).getTime() / (86400 * 1000));
  const windowBucket = Math.floor(epochDays / 3);
  const normalizedPayee = (params.payee ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  return sha256Hex(
    [
      'window',
      params.accountTail ?? '',
      windowBucket,
      params.amountMinor,
      params.direction.toLowerCase(),
      normalizedPayee,
    ].join('|'),
  );
}

function attachmentStatement(
  attachment: ParsedEmailAttachment,
  password?: string,
): Promise<ParsedStatement> | ParsedStatement | undefined {
  const name = attachment.fileName.toLowerCase();
  if (name.endsWith('.csv') || attachment.mimeType === 'text/csv') {
    const text = new TextDecoder().decode(attachment.bytes);
    return parseCsvStatement(text, { fileName: attachment.fileName });
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseXlsxStatement(attachment.bytes, { fileName: attachment.fileName });
  }
  if (name.endsWith('.pdf') || attachment.mimeType === 'application/pdf') {
    return parsePdfStatement(attachment.bytes, {
      fileName: attachment.fileName,
      ...(password ? { password } : {}),
    });
  }
  if (name.endsWith('.txt')) {
    return parseTextStatement(new TextDecoder().decode(attachment.bytes), {
      fileName: attachment.fileName,
    });
  }
  return undefined;
}

const AMOUNT_PATTERN =
  /(?:₹|inr|rs\.?)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:inr|rs\.?)/i;

export interface AlertTextInput {
  text: string;
  html?: string;
  subject?: string;
  from?: string;
  date?: string;
  messageId?: string;
}

export function parseAlertText(input: AlertTextInput): ParsedStatement | undefined {
  // Check for Gift Card / Shopping Voucher email confirmations first
  if (isGiftCardEmail(input.subject, input.text, input.from)) {
    const giftCardStmt = parseGiftCardEmail(input);
    if (giftCardStmt && giftCardStmt.rows.length > 0) {
      return giftCardStmt;
    }
  }

  const body = normalizeText(
    `${input.subject ?? ''}\n${input.text}\n${input.html ? stripHtml(input.html) : ''}`,
  );
  const haystack = `${input.from ?? ''}\n${body}`.toLowerCase();
  const adapter = detectStatementAdapter(haystack, input.subject ?? '');

  // Check for Schema.org JSON-LD details in HTML first
  const schemaOrg = input.html ? extractSchemaOrgDetails(input.html) : undefined;

  const isFastagText =
    adapter.kind === 'fastag' ||
    /(?:fastag|toll|nhai|ihmcl|plaza|toll deduction)/i.test(haystack);

  const isGiftCardText =
    adapter.kind === 'giftcard' ||
    /(?:shopping\s*voucher|gift\s*(?:card|voucher)|e-gift|brand\s*voucher|voucher\s*booking|voucher\s*code|ishop|gyftr|woohoo|qwikcilver|hubble)/i.test(
      haystack,
    );

  const isBankOrPaymentText =
    Boolean(schemaOrg) ||
    isGiftCardText ||
    adapter.id !== 'generic-bank' ||
    /(?:debited|credited|debit|credit|paid|payment|order|invoice|bill|withdraw|withdrawn|deposit|refund|recharge|purchase|toll|salary|interest)/i.test(
      haystack,
    );

  if (!isFastagText && !isBankOrPaymentText) return undefined;

  const giftCard = isGiftCardText
    ? extractGiftCardDetails(body, input.subject ?? '', input.html ?? '')
    : undefined;

  let amount: number | undefined = giftCard?.totalAmountMinor ?? schemaOrg?.amountMinor;
  if (!amount) {
    const amountMatch = body.match(AMOUNT_PATTERN);
    if (!amountMatch) return undefined;
    try {
      amount = Math.abs(parseAmountToMinor(amountMatch[1] ?? amountMatch[2] ?? ''));
    } catch {
      return undefined;
    }
  }
  if (!amount || amount === 0) return undefined;

  const dateMatch =
    body.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/) ??
    body.match(/\b(\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4})\b/);
  const date =
    parseStatementDate(dateMatch?.[1] ?? '') ??
    parseStatementDate(input.date ?? '') ??
    new Date().toISOString().slice(0, 10);

  const lower = body.toLowerCase();
  const credit = /(?:credited|credit|deposit|received|refund|recharge)/.test(lower);
  const debit = /(?:debited|debit|withdraw|withdrawn|paid|payment|purchase|toll|deducted)/.test(lower);
  const isDebit = giftCard ? true : schemaOrg ? true : (debit && !credit ? true : credit && !debit ? false : isFastagText);

  // Extract transaction details and rail
  const txnDetails = extractTransactionDetails(body, input.subject, {
    ...(input.html ? { html: input.html } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  });
  const reference = giftCard?.orderReference ?? giftCard?.maskedId ?? txnDetails?.id;

  // Extract Unique Account (Bank account tail, card ending, UPI VPA, etc.)
  const accountInfo: ExtractedAccount | undefined = identifyUniqueAccount({
    text: body,
    subject: input.subject,
    from: input.from,
    html: input.html,
  });

  // Clean description
  let description = input.subject?.trim();
  if (giftCard) {
    const brandSuffix = giftCard.brand ? ` (${giftCard.brand})` : '';
    const maskedIdPart = giftCard.maskedId ? `, ID: ${giftCard.maskedId}` : '';
    const refPart = giftCard.orderReference ? `, Ref: ${giftCard.orderReference}` : '';
    description = `Shopping Voucher - ${giftCard.platform}${brandSuffix} (${giftCard.maskedQuantity}${maskedIdPart}${refPart})`;
  } else if (schemaOrg?.merchantName) {
    description = `Order at ${schemaOrg.merchantName}${schemaOrg.orderNumber ? ` (${schemaOrg.orderNumber})` : ''}`;
  } else if (!description || description.length < 5) {
    const firstLine = body.trim().split('\n')[0] || '';
    description = firstLine.slice(0, 200) || (isFastagText ? 'FASTag Toll Deduction' : 'Bank alert');
  }

  const rawMetadata: Record<string, unknown> = {
    ...(input.subject ? { subject: input.subject.slice(0, 512) } : {}),
    ...(input.from ? { from: input.from.slice(0, 256) } : {}),
    ...(reference ? { reference } : {}),
    ...(giftCard
      ? { rail: 'giftcard' }
      : txnDetails?.rail
        ? { rail: txnDetails.rail }
        : {}),
    ...(accountInfo?.accountNumberMasked ? { account: accountInfo.accountNumberMasked } : {}),
    ...(accountInfo?.accountTail ? { accountTail: accountInfo.accountTail } : {}),
    ...(accountInfo?.category ? { accountCategory: accountInfo.category } : {}),
    ...(accountInfo?.institution ? { institution: accountInfo.institution } : {}),
    ...(giftCard
      ? {
          giftCard: {
            platform: giftCard.platform,
            quantity: giftCard.quantity,
            maskedQuantity: giftCard.maskedQuantity,
            ...(giftCard.maskedId ? { maskedId: giftCard.maskedId } : {}),
            ...(giftCard.brand ? { brand: giftCard.brand } : {}),
            ...(giftCard.orderReference ? { orderReference: giftCard.orderReference } : {}),
            ...(giftCard.denominationMinor ? { denominationMinor: giftCard.denominationMinor } : {}),
            ...(giftCard.totalAmountMinor ? { totalAmountMinor: giftCard.totalAmountMinor } : {}),
          },
        }
      : {}),
  };

  const row: ParsedStatementRow = {
    date,
    description: description.slice(0, 512),
    debitMinor: isDebit ? amount : 0,
    creditMinor: isDebit ? 0 : amount,
    currency: schemaOrg?.currency ?? 'INR',
    raw: rawMetadata,
  };
  if (reference) row.reference = reference;

  const kind: StatementKind = isGiftCardText ? 'giftcard' : isFastagText ? 'fastag' : 'bank';
  let adapterName = adapter.name;
  if (isGiftCardText) {
    adapterName = giftCard ? `${giftCard.platform} Shopping Voucher` : 'Gift Card / Shopping Voucher';
  } else if (adapter.id === 'generic-bank') {
    if (schemaOrg || /(?:amazon|flipkart|swiggy|zomato|uber|ola|blinkit|zepto|aws|google)/i.test(haystack)) {
      adapterName = 'E-Commerce / Shopping Invoice';
    } else {
      adapterName = 'Bank / Payment Alert';
    }
  }

  return {
    adapterId: adapter.id,
    adapterName,
    kind,
    currency: schemaOrg?.currency ?? 'INR',
    rows: [row],
  };
}

export function parseAlertEmail(email: ParsedEmail): ParsedStatement | undefined {
  return parseAlertText({
    text: email.text,
    ...(email.raw.html ? { html: email.raw.html } : {}),
    subject: email.subject,
    from: email.from,
    ...(email.date ? { date: email.date } : {}),
    ...(email.messageId ? { messageId: email.messageId } : {}),
  });
}

export async function parseEmailStatements(
  source: string | ArrayBuffer | Uint8Array,
  options: { password?: string } = {},
): Promise<{ email: ParsedEmail; statements: ParsedStatement[] }> {
  const email = await parseEmail(source);
  const statements: ParsedStatement[] = [];
  for (const attachment of email.attachments) {
    const result = attachmentStatement(attachment, options.password);
    if (result) statements.push(await result);
  }
  if (statements.length === 0) {
    const alert = parseAlertEmail(email);
    if (alert) statements.push(alert);
  }
  return { email, statements };
}

export { extractGiftCardDetails } from './giftcards';
