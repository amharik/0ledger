import PostalMime, { type Email, type Attachment } from 'postal-mime';
import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter } from './adapters';
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
import type { ParsedStatement, ParsedStatementRow } from './types';

export interface ParsedEmailAttachment {
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface ParsedEmail {
  subject: string;
  from: string;
  date?: string;
  text: string;
  attachments: ParsedEmailAttachment[];
  raw: { html?: string };
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
    text: (email.text ?? '').slice(0, MAX_EMAIL_BODY_CHARS),
    attachments: email.attachments.map((attachment) => ({
      fileName: (attachment.filename ?? 'attachment').slice(0, 512),
      mimeType: attachment.mimeType,
      bytes: bytesOf(attachment),
    })),
    raw: email.html ? { html: email.html.slice(0, MAX_EMAIL_BODY_CHARS) } : {},
  };
}

function stripHtml(html: string): string {
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
}

export function extractTransactionId(text: string, subject?: string): string | undefined {
  const combined = `${subject ?? ''}\n${text}`;

  // 1. UPI Ref / RRN (12 digits) or UPI/CR/..., UPI/DR/..., UPI/P2A/...
  const upiMatch =
    combined.match(/\b(?:upi(?:\s*(?:ref|txn|reference)(?:\s*no)?)?|rrn)[:\s/#-]*(\d{12})\b/i) ??
    combined.match(/upi\/[a-z0-9_-]+\/(\d{12})\b/i) ??
    combined.match(/\b(?:rrn)[:\s#-]*([A-Za-z0-9]{10,16})\b/i);
  if (upiMatch?.[1]) return upiMatch[1];

  // 2. NEFT / RTGS UTR (e.g. HDFCN..., PUNBN..., SBIN..., or 16-22 characters)
  const utrMatch =
    combined.match(/\b(?:neft|rtgs|utr)(?:\s*(?:no|ref|txn|reference))?[:\s/#-]*([A-Z]{4}[A-Z0-9]{10,18})\b/i) ??
    combined.match(/\b(?:utr)(?:\s*no)?[:\s#-]*([A-Z0-9]{12,22})\b/i);
  if (utrMatch?.[1]) return utrMatch[1];

  // 3. IMPS Reference
  const impsMatch = combined.match(/\b(?:imps)(?:\s*(?:ref|txn|reference)(?:\s*no)?)?[:\s/#-]*([A-Za-z0-9]{10,16})\b/i);
  if (impsMatch?.[1]) return impsMatch[1];

  // 4. FASTag Toll Txn ID / Tag ID
  const fastagMatch =
    combined.match(/\b(?:toll\s*(?:txn|transaction)\s*id|txn\s*id|transaction\s*id)[:\s#-]*([A-Za-z0-9_-]{6,30})\b/i) ??
    combined.match(/\b(?:tag\s*id)[:\s#-]*([A-Za-z0-9]{10,32})\b/i);
  if (fastagMatch?.[1]) return fastagMatch[1];

  // 5. E-Commerce Order ID / Invoice No
  const orderMatch =
    combined.match(/\b(?:order\s*(?:id|#))[:\s#-]*([0-9]{3}-[0-9]{7}-[0-9]{7})\b/i) ?? // Amazon format
    combined.match(/\b(?:order\s*(?:id|#)|invoice\s*(?:no|#)|bill\s*(?:no|#))[:\s#-]*([A-Za-z0-9#-]{6,30})\b/i);
  if (orderMatch?.[1]) return orderMatch[1];

  // 6. Generic Txn / Ref ID fallback
  const genericMatch = combined.match(/\b(?:ref|utr|txn|transaction)(?:\s*(?:no|id|ref|reference))?[:\s#-]*([A-Za-z0-9]{6,30})\b/i);
  if (genericMatch?.[1]) return genericMatch[1];

  return undefined;
}

export function parseAlertText(input: AlertTextInput): ParsedStatement | undefined {
  const body = `${input.subject ?? ''}\n${input.text}\n${input.html ? stripHtml(input.html) : ''}`;
  const haystack = `${input.from ?? ''}\n${body}`.toLowerCase();
  const adapter = detectStatementAdapter(haystack, input.subject ?? '');

  const isFastagText =
    adapter.kind === 'fastag' ||
    /(?:fastag|toll|nhai|ihmcl|plaza|toll deduction)/i.test(haystack);

  const isBankOrPaymentText =
    adapter.id !== 'generic-bank' ||
    /(?:debited|credited|debit|credit|paid|payment|order|invoice|bill|withdraw|withdrawn|deposit|refund|recharge|purchase|toll|salary|interest)/i.test(
      haystack,
    );

  if (!isFastagText && !isBankOrPaymentText) return undefined;

  const amountMatch = body.match(AMOUNT_PATTERN);
  if (!amountMatch) return undefined;
  let amount: number;
  try {
    amount = Math.abs(parseAmountToMinor(amountMatch[1] ?? amountMatch[2] ?? ''));
  } catch {
    return undefined;
  }
  if (amount === 0) return undefined;

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
  const isDebit = debit && !credit ? true : credit && !debit ? false : isFastagText;

  const reference = extractTransactionId(body, input.subject);

  // Clean description
  let description = input.subject?.trim();
  if (!description || description.length < 5) {
    const firstLine = body.trim().split('\n')[0] || '';
    description = firstLine.slice(0, 200) || (isFastagText ? 'FASTag Toll Deduction' : 'Bank alert');
  }

  const row: ParsedStatementRow = {
    date,
    description: description.slice(0, 512),
    debitMinor: isDebit ? amount : 0,
    creditMinor: isDebit ? 0 : amount,
    currency: 'INR',
    raw: {
      ...(input.subject ? { subject: input.subject.slice(0, 512) } : {}),
      ...(input.from ? { from: input.from.slice(0, 256) } : {}),
      ...(reference ? { reference } : {}),
    },
  };
  if (reference) row.reference = reference;

  const kind = isFastagText ? 'fastag' : 'bank';
  let adapterName = adapter.name;
  if (adapter.id === 'generic-bank') {
    if (/(?:amazon|flipkart|swiggy|zomato|uber|ola|blinkit|zepto|aws|google)/i.test(haystack)) {
      adapterName = 'E-Commerce / Shopping Invoice';
    } else {
      adapterName = 'Bank / Payment Alert';
    }
  }

  return {
    adapterId: adapter.id,
    adapterName,
    kind,
    currency: 'INR',
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
