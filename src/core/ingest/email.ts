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
  raw: Email;
}

function bytesOf(attachment: Attachment): ArrayBuffer {
  const content = attachment.content;
  if (typeof content === 'string') {
    if (attachment.encoding === 'base64') {
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
  const email = await PostalMime.parse(source, { attachmentEncoding: 'arraybuffer' });
  return {
    subject: email.subject ?? '',
    from: email.from?.address ?? '',
    ...(email.date ? { date: email.date } : {}),
    text: email.text ?? '',
    attachments: email.attachments.map((attachment) => ({
      fileName: attachment.filename ?? 'attachment',
      mimeType: attachment.mimeType,
      bytes: bytesOf(attachment),
    })),
    raw: email,
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

export function parseAlertText(input: AlertTextInput): ParsedStatement | undefined {
  const body = `${input.subject ?? ''}\n${input.text}\n${input.html ? stripHtml(input.html) : ''}`;
  const adapter = detectStatementAdapter(`${input.from ?? ''}\n${body}`, input.subject ?? '');
  if (adapter.id === 'generic-bank' || adapter.id === 'generic-fastag') return undefined;

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
  const isDebit = debit && !credit ? true : credit && !debit ? false : adapter.kind === 'fastag';

  const reference =
    body.match(/(?:ref|utr|txn|transaction)(?:\s*(?:no|id|ref))?[:\s#-]*([A-Z0-9]{6,})/i)?.[1] ?? undefined;

  const row: ParsedStatementRow = {
    date,
    description: input.subject || body.trim().split('\n')[0] || 'Bank alert',
    debitMinor: isDebit ? amount : 0,
    creditMinor: isDebit ? 0 : amount,
    currency: 'INR',
    raw: { subject: input.subject, from: input.from, text: input.text },
  };
  if (reference) row.reference = reference;

  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: adapter.kind,
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
