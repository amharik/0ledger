import Papa from 'papaparse';
import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter, getAdapter } from './adapters';
import { parseSpecializedStatement } from './specialized';
import {
  pdfLayoutFromRust,
  pdfMarkdownFromRust,
  pdfOcrFromDocling,
  type PdfOcrResult,
  type PdfTextItem,
} from './pdf-rust';
import { assertByteLimit, assertRowLimit, assertTextLimit } from './limits';
import { verifyStatementBalance, type BalanceLine } from './balance';
import type {
  ParsedStatement,
  ParsedStatementRow,
  ParseStatementOptions,
  StatementAdapter,
} from './types';

type Role = 'date' | 'valueDate' | 'description' | 'reference' | 'debit' | 'credit' | 'amount' | 'type' | 'balance';

const ROLE_ALIASES: Record<Role, string[]> = {
  valueDate: ['value date', 'val date', 'value dt'],
  date: ['txn date', 'transaction date', 'tran date', 'post date', 'posting date', 'date', 'dt'],
  description: [
    'narration',
    'transaction details',
    'transaction description',
    'particulars',
    'description',
    'details',
    'remarks',
    'merchant',
    'narrative',
  ],
  reference: [
    'chq/ref no',
    'cheque/ref no',
    'chq ref no',
    'cheque no',
    'reference no',
    'reference',
    'ref no',
    'utr',
    'transaction id',
    'txn id',
    'transaction reference',
  ],
  type: ['dr/cr', 'debit/credit', 'transaction type', 'txn type', 'type'],
  debit: [
    'withdrawal amt',
    'withdrawal amount',
    'withdrawal',
    'debit amount',
    'amount debited',
    'debit',
    'dr',
    'paid out',
    'out',
    'outflow',
    'outflow amount',
    'outflow amt',
    'debits',
    'withdrawals',
    'withdrawals amt',
    'withdrawals amount',
    'withdrawal amt',
  ],
  credit: [
    'deposit amt',
    'deposit amount',
    'deposit',
    'credit amount',
    'amount credited',
    'credit',
    'cr',
    'paid in',
    'in',
    'inflow',
    'inflow amount',
    'inflow amt',
    'credits',
    'deposits',
    'deposits amt',
    'deposits amount',
  ],
  amount: ['transaction amount', 'txn amount', 'amount inr', 'amount'],
  balance: ['closing balance', 'available balance', 'running balance', 'balance'],
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._/()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function normalizeYear(value: string): number {
  const year = Number.parseInt(value, 10);
  if (value.length <= 2) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

function matchStatementDate(text: string): { date: string; length: number } | undefined {
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const date = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date) return { date, length: iso[0].length };
  }

  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dmy) {
    const date = validDate(normalizeYear(dmy[3] ?? ''), Number(dmy[2]), Number(dmy[1]));
    if (date) return { date, length: dmy[0].length };
  }

  const compactDMonY = text.match(/^(\d{1,2})([A-Za-z]{3,9})(\d{2,4})(?![0-9])/);
  if (compactDMonY) {
    const month = MONTHS[(compactDMonY[2] ?? '').toLowerCase()];
    const date = month
      ? validDate(normalizeYear(compactDMonY[3] ?? ''), month, Number(compactDMonY[1]))
      : undefined;
    if (date) return { date, length: compactDMonY[0].length };
  }

  const dMonY = text.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})/);
  if (dMonY) {
    const month = MONTHS[(dMonY[2] ?? '').toLowerCase()];
    const date = month ? validDate(normalizeYear(dMonY[3] ?? ''), month, Number(dMonY[1])) : undefined;
    if (date) return { date, length: dMonY[0].length };
  }

  const monDY = text.match(/^([A-Za-z]{3,9})[\s-]+(\d{1,2})[\s,-]+(\d{2,4})/);
  if (monDY) {
    const month = MONTHS[(monDY[1] ?? '').toLowerCase()];
    const date = month ? validDate(normalizeYear(monDY[3] ?? ''), month, Number(monDY[2])) : undefined;
    if (date) return { date, length: monDY[0].length };
  }

  return undefined;
}

export function parseStatementDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const serial = Math.floor(value);
    if (serial > 20000 && serial < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }
  }

  const text = String(value ?? '').trim();
  if (text.length === 0) return undefined;
  return matchStatementDate(text)?.date;
}

const BALANCE_FORWARD =
  /^(?:b\/f|bf|brought forward|balance forward|balance brought forward|balance b\/f|opening balance|opening bal|c\/f|cf|carried forward|closing balance|closing bal|balance carried forward|balance c\/f)$/i;

function isBalanceForwardDescription(value: string): boolean {
  const normalized = value.trim().replace(/[.:;-]+$/, '').replace(/\s+/g, ' ').trim();
  return BALANCE_FORWARD.test(normalized);
}

function amountSide(value: string): 'debit' | 'credit' | undefined {
  const text = value.trim();
  if (/(?:^|\s)cr\s*$/i.test(text)) return 'credit';
  if (/(?:^|\s)dr\s*$/i.test(text)) return 'debit';
  if (/^\(.*\)$/.test(text) || /^-/.test(text)) return 'debit';
  return undefined;
}

export function parseStatementAmount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return parseAmountToMinor(Math.abs(value));
  }
  const text = String(value ?? '').trim();
  if (text.length === 0 || /^[-–—]+$/.test(text)) return undefined;
  try {
    return Math.abs(parseAmountToMinor(text));
  } catch {
    return undefined;
  }
}

export function parseStatementBalance(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return parseAmountToMinor(value);
  }
  const text = String(value ?? '').trim();
  if (text.length === 0 || /^[-–—]+$/.test(text)) return undefined;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text) || /(?:^|\s)dr\.?\s*$/i.test(text);
  const cleaned = text.replace(/^\(|\)$/g, '').replace(/\s*(?:cr|dr)\.?\s*$/i, '').trim();
  try {
    const amount = Math.abs(parseAmountToMinor(cleaned));
    return negative ? -amount : amount;
  } catch {
    return undefined;
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return parseStatementDate(value) ?? value.toISOString();
  return String(value).trim();
}

function mapHeader(row: string[]): { roles: Partial<Record<Role, number>>; score: number } {
  const normalized = row.map(normalizeHeader);
  const roles: Partial<Record<Role, number>> = {};
  const used = new Set<number>();

  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as Array<[Role, string[]]>) {
    for (const rawAlias of aliases) {
      const alias = normalizeHeader(rawAlias);
      const index = normalized.findIndex(
        (header, position) =>
          !used.has(position) &&
          (header === alias || header.startsWith(`${alias} `) || header.endsWith(` ${alias}`)),
      );
      if (index >= 0) {
        roles[role] = index;
        used.add(index);
        break;
      }
    }
  }

  let score = Object.keys(roles).length;
  if (roles.date === undefined && roles.valueDate === undefined) score -= 3;
  if (roles.description === undefined) score -= 1;
  if (roles.debit === undefined && roles.credit === undefined && roles.amount === undefined) score -= 2;
  return { roles, score };
}

function findHeader(rows: unknown[][]): { index: number; roles: Partial<Record<Role, number>> } | undefined {
  let best: { index: number; roles: Partial<Record<Role, number>>; score: number } | undefined;
  const limit = Math.min(rows.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const row = (rows[index] ?? []).map(cellText);
    const mapped = mapHeader(row);
    if (!best || mapped.score > best.score) best = { index, ...mapped };
  }
  return best && best.score >= 3 ? { index: best.index, roles: best.roles } : undefined;
}

function getCell(row: string[], roles: Partial<Record<Role, number>>, role: Role): string {
  const index = roles[role];
  return index === undefined ? '' : (row[index] ?? '').trim();
}

function stripMarkdownCell(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\\\|/g, '|')
    .trim();
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(stripMarkdownCell(current));
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(stripMarkdownCell(current));
  return cells;
}

function isMarkdownSeparator(line: string): boolean {
  const cells = splitMarkdownRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

const INLINE_MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const INLINE_DATE = new RegExp(
  `\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}${INLINE_MONTH}\\d{2,4}|\\d{1,2}[\\s-]+${INLINE_MONTH}[\\s,-]+\\d{2,4}|${INLINE_MONTH}[\\s-]+\\d{1,2}[\\s,-]+\\d{2,4})\\b`,
  'gi',
);

function splitInlineDates(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      INLINE_DATE.lastIndex = 0;
      const matches = [...line.matchAll(INLINE_DATE)];
      if (matches.length < 2) return line;
      let result = '';
      let last = 0;
      for (const match of matches) {
        const index = match.index ?? 0;
        if (index === 0) continue;
        const before = line.slice(last, index);
        result += before.replace(/\s+$/, '') + '\n';
        last = index;
      }
      return result + line.slice(last);
    })
    .join('\n');
}

function extractMarkdownTables(markdown: string): string[][][] {
  const lines = markdown.split(/\r?\n/);
  const tables: string[][][] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? '';
    const separator = lines[index + 1]?.trim() ?? '';
    if (!line.startsWith('|') || !isMarkdownSeparator(separator)) {
      index += 1;
      continue;
    }
    const table: string[][] = [splitMarkdownRow(line)];
    index += 2;
    while (index < lines.length) {
      const rowLine = lines[index]?.trim() ?? '';
      if (!rowLine.startsWith('|')) break;
      if (!isMarkdownSeparator(rowLine)) table.push(splitMarkdownRow(rowLine));
      index += 1;
    }
    tables.push(table);
  }
  return tables;
}

function rowFromCells(
  cells: string[],
  roles: Partial<Record<Role, number>>,
  headers: string[],
  adapter: StatementAdapter,
  options: ParseStatementOptions,
): ParsedStatementRow | undefined {
  const date = parseStatementDate(getCell(cells, roles, 'date')) ?? parseStatementDate(getCell(cells, roles, 'valueDate'));
  if (!date) return undefined;

  const description = getCell(cells, roles, 'description');
  if (cells.some(isBalanceForwardDescription)) return undefined;

  const debitCell = getCell(cells, roles, 'debit');
  const creditCell = getCell(cells, roles, 'credit');
  const amountCell = getCell(cells, roles, 'amount');
  const typeCell = getCell(cells, roles, 'type');

  let debitMinor = parseStatementAmount(debitCell) ?? 0;
  let creditMinor = parseStatementAmount(creditCell) ?? 0;

  if (debitMinor === 0 && creditMinor === 0 && amountCell) {
    const amount = parseStatementAmount(amountCell);
    if (amount !== undefined && amount !== 0) {
      const kind = `${typeCell} ${amountCell}`.toLowerCase();
      const side = amountSide(amountCell);
      if (side === 'debit' || /(?:^|\b)(?:dr|debit|withdrawal)\b/.test(kind)) {
        debitMinor = amount;
      } else if (side === 'credit' || /(?:^|\b)(?:cr|credit|deposit)\b/.test(kind)) {
        creditMinor = amount;
      } else if (adapter.kind === 'fastag' || amountCell.trim().startsWith('-')) {
        debitMinor = amount;
      } else {
        creditMinor = amount;
      }
    }
  }

  if (debitMinor === 0 && creditMinor === 0) return undefined;

  const reference = getCell(cells, roles, 'reference');
  if (!description && !reference) return undefined;

  const balance = parseStatementAmount(getCell(cells, roles, 'balance'));
  const raw: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    if (header) raw[header] = cells[index] ?? '';
  });

  const row: ParsedStatementRow = {
    date,
    description: description || reference || 'Statement line',
    debitMinor,
    creditMinor,
    currency: options.currency ?? 'INR',
    raw,
  };
  const valueDate = parseStatementDate(getCell(cells, roles, 'valueDate'));
  if (valueDate) row.valueDate = valueDate;
  if (reference) row.reference = reference;
  if (balance !== undefined) row.balanceMinor = balance;
  return row;
}

function rowsFromTable(
  table: unknown[][],
  adapter: StatementAdapter,
  options: ParseStatementOptions,
): ParsedStatementRow[] {
  const header = findHeader(table);
  if (!header) return [];
  const headers = (table[header.index] ?? []).map(cellText);
  const rows: ParsedStatementRow[] = [];
  for (let index = header.index + 1; index < table.length; index += 1) {
    const cells = (table[index] ?? []).map(cellText);
    const joined = cells.join(' ').toLowerCase();
    if (/statement summary|closing balance|opening balance|end of statement/.test(joined) && !parseStatementDate(cells[header.roles.date ?? -1] ?? '')) {
      continue;
    }
    const parsed = rowFromCells(cells, header.roles, headers, adapter, options);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function statementFromRows(
  rows: ParsedStatementRow[],
  adapter: StatementAdapter,
  options: ParseStatementOptions,
): ParsedStatement {
  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    kind: adapter.kind,
    currency: options.currency ?? 'INR',
    rows,
  };
}

function resolveAdapter(text: string, options: ParseStatementOptions): StatementAdapter {
  if (options.adapterId) {
    const adapter = getAdapter(options.adapterId);
    if (adapter) return adapter;
  }
  return detectStatementAdapter(text, options.fileName);
}

export function parseCsvStatement(text: string, options: ParseStatementOptions = {}): ParsedStatement {
  assertTextLimit(text, 'CSV statement');
  const adapter = resolveAdapter(text, options);
  if (['nps', 'ppf', 'interest', 'p2p'].includes(adapter.kind)) {
    const specialized = parseSpecializedStatement(text, { fileName: options.fileName, kind: adapter.kind });
    if (specialized && specialized.rows.length > 0) return specialized;
  }
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
  });
  assertRowLimit(parsed.data.length, 'CSV statement');
  return {
    ...statementFromRows(rowsFromTable(parsed.data, adapter, options), adapter, options),
    ...extractStatementBoundaries(text),
  };
}

export async function parseXlsxStatement(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseStatementOptions = {},
): Promise<ParsedStatement> {
  assertByteLimit(bytes, 'Workbook');
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets.find((candidate) => candidate.rowCount > 1) ?? workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no worksheets');
  assertRowLimit(sheet.rowCount, 'Workbook');
  const table: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values;
    table.push(Array.isArray(values) ? values.slice(1) : []);
  });
  assertRowLimit(table.length, 'Workbook');
  const text = table.map((row) => row.map(cellText).join(' ')).join('\n');
  const adapter = resolveAdapter(text, options);
  return {
    ...statementFromRows(rowsFromTable(table, adapter, options), adapter, options),
    ...extractStatementBoundaries(text),
  };
}

export class ScannedPdfError extends Error {
  readonly requiresOcr = true;

  constructor(message = 'PDF extraction failed. anydoc and Docling did not produce a statement.') {
    super(message);
    this.name = 'ScannedPdfError';
  }
}

export const OCR_ENABLED = false;

const PAGE_BREAK = '\u000c';
const DATE_START =
  /^(?:[*-]\s*)?(?:\d{1,4}\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[A-Za-z]{3,9}\d{2,4}(?![0-9])|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}|[A-Za-z]{3,9}[\s-]+\d{1,2}[\s,-]+\d{2,4})\b/;
const TEXT_AMOUNT =
  /(?:(?:₹|inr|rs\.?)\s*)?\(?-?\d[\d,]*(?:\.\d{1,2})?\)?\s*(?:cr|dr)?/gi;
const NOISE_LINE = [
  /^page\s+\d+\s*(?:of|\/)\s*\d+/i,
  /^\d{1,3}\s*\/\s*\d{1,3}$/,
  /^continued\b/i,
  /^statement\s+(?:of\s+account|summary|period)/i,
  /^(?:account|a\/c)\s*(?:no|number|#)\s*[:.-]?\s*[xX*\d]/i,
  /^ifsc\s*(?:code)?\s*[:.-]/i,
  /^branch\s*(?:name|code)?\s*[:.-]/i,
  /^customer\s*(?:name|id|care)?\s*[:.-]/i,
  /^address\s*[:.-]/i,
  /^period\b/i,
  /^from\s+\d/i,
  /^date\s+(?:narration|description|particulars|transaction)/i,
  /^(?:narration|description|particulars)\s+(?:chq|ref|debit|credit|withdrawal|deposit|balance)/i,
  /^(?:opening|closing)\s+balance\b/i,
  /^(?:total|grand\s+total)\b/i,
  /computer\s+generated|registered\s+office|subject\s+to\s+(?:realisation|verification)|please\s+examine/i,
  /^[-–—]+$/,
];

function isNoiseLine(line: string): boolean {
  return NOISE_LINE.some((pattern) => pattern.test(line));
}

function textAmountMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(TEXT_AMOUNT)].filter((match) => {
    const token = match[0].trim();
    const digits = token.replace(/[^0-9]/g, '');
    if (!digits) return false;
    if (!/[.,]/.test(token) && !/(?:₹|inr|rs)/i.test(token) && /^(?:19|20)\d{2}$/.test(digits)) {
      return false;
    }
    if (!/[.,]/.test(token) && !/(?:₹|inr|rs)/i.test(token) && digits.length > 12) return false;
    return true;
  });
}

function extractStatementBoundaries(text: string): {
  openingBalanceMinor?: number;
  closingBalanceMinor?: number;
} {
  let openingBalanceMinor: number | undefined;
  let closingBalanceMinor: number | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let candidate = line;
    if (line.startsWith('|')) {
      const cells = splitMarkdownRow(line);
      candidate =
        cells.find((cell) =>
          /^(?:opening balance|balance b\/f|b\/f|brought forward|closing balance|balance c\/f|c\/f|carried forward)\b/i.test(
            cell.trim(),
          ),
        ) ?? '';
    } else {
      const dateMatch = line.match(DATE_START);
      if (dateMatch) candidate = line.slice(dateMatch[0].length).trim();
    }
    if (!candidate) continue;
    const opening = /^(?:opening balance|balance b\/f|b\/f|brought forward)\b/i.test(candidate);
    const closing = /^(?:closing balance|balance c\/f|c\/f|carried forward)\b/i.test(candidate);
    if (!opening && !closing) continue;
    const matches = textAmountMatches(line);
    const last = matches[matches.length - 1];
    if (!last) continue;
    const amount = parseStatementBalance(last[0]);
    if (amount === undefined) continue;
    if (opening && openingBalanceMinor === undefined) openingBalanceMinor = amount;
    if (closing) closingBalanceMinor = amount;
  }
  return {
    ...(openingBalanceMinor === undefined ? {} : { openingBalanceMinor }),
    ...(closingBalanceMinor === undefined ? {} : { closingBalanceMinor }),
  };
}

function parseTextBlock(
  block: { lines: string[]; page: number },
  adapter: StatementAdapter,
  options: ParseStatementOptions,
): ParsedStatementRow | undefined {
  const text = block.lines.join(' ').replace(/\s+/g, ' ').trim();
  const dateMatch = text.match(DATE_START);
  const date = parseStatementDate(dateMatch?.[1] ?? '');
  if (!dateMatch || !date) return undefined;

  const rest = text.slice(dateMatch[0].length).trim();
  const matches = textAmountMatches(rest);
  if (matches.length === 0) return undefined;

  const amountMatch = matches[matches.length - (matches.length >= 2 ? 2 : 1)];
  const balanceMatch = matches.length >= 2 ? matches[matches.length - 1] : undefined;
  if (!amountMatch) return undefined;
  const amount = parseStatementAmount(amountMatch[0]);
  if (!amount) return undefined;

  const beforeAmount = rest.slice(0, amountMatch.index).trim();
  const afterAmount = rest.slice((amountMatch.index ?? 0) + amountMatch[0].length).trim();
  const side =
    amountSide(amountMatch[0]) ??
    (/^(?:cr|credit)\b/i.test(afterAmount) ? 'credit' : /^(?:dr|debit)\b/i.test(afterAmount) ? 'debit' : undefined);
  const description = beforeAmount || 'Statement line';
  if (isBalanceForwardDescription(description)) return undefined;
  const lower = rest.toLowerCase();
  const debit = side === 'debit' || /(?:debit|withdraw|paid|payment|purchase|toll|deducted)/.test(lower);
  const credit = side === 'credit' || /(?:credit|deposit|received|refund|recharge)/.test(lower);
  const isDebit = debit && !credit ? true : credit && !debit ? false : adapter.kind === 'fastag';

  const balance = balanceMatch ? parseStatementBalance(balanceMatch[0]) : undefined;
  const row: ParsedStatementRow = {
    date,
    description,
    debitMinor: isDebit ? amount : 0,
    creditMinor: isDebit ? 0 : amount,
    page: block.page,
    currency: options.currency ?? 'INR',
    raw: { line: text, page: block.page },
  };
  if (balance !== undefined) row.balanceMinor = balance;
  return row;
}

export function parseTextRows(text: string, adapter: StatementAdapter, options: ParseStatementOptions = {}): ParsedStatementRow[] {
  assertTextLimit(text, 'Text statement');
  const rows: ParsedStatementRow[] = [];
  const blocks: Array<{ lines: string[]; page: number }> = [];
  let current: { lines: string[]; page: number } | undefined;
  let page = 1;

  for (const rawLine of splitInlineDates(text).split(/\r?\n/)) {
    let line = rawLine;
    if (line.includes(PAGE_BREAK)) {
      page += 1;
      line = line.replace(/\f/g, ' ').trim();
      if (!line) continue;
    }
    line = line.trim();
    if (!line) continue;
    if (DATE_START.test(line)) {
      if (current) blocks.push(current);
      current = { lines: [line], page };
      continue;
    }
    if (isNoiseLine(line)) continue;
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  for (const block of blocks) {
    const row = parseTextBlock(block, adapter, options);
    if (!row) continue;
    rows.push(row);
    assertRowLimit(rows.length, 'Text statement');
  }
  return rows;
}

export function parseTextStatement(text: string, options: ParseStatementOptions = {}): ParsedStatement {
  const adapter = resolveAdapter(text, options);
  if (['nps', 'ppf', 'interest', 'p2p'].includes(adapter.kind)) {
    const specialized = parseSpecializedStatement(text, { fileName: options.fileName, kind: adapter.kind });
    if (specialized && specialized.rows.length > 0) return specialized;
  }
  return {
    ...statementFromRows(parseTextRows(text, adapter, options), adapter, options),
    ...extractStatementBoundaries(text),
    sourceText: text,
  };
}

export function parseMarkdownStatement(
  markdown: string,
  options: ParseStatementOptions = {},
): ParsedStatement {
  assertTextLimit(markdown, 'Markdown statement');
  const adapter = resolveAdapter(markdown, options);
  const rows: ParsedStatementRow[] = [];
  for (const table of extractMarkdownTables(markdown)) {
    rows.push(...rowsFromTable(table, adapter, options));
    assertRowLimit(rows.length, 'Markdown statement');
  }
  if (rows.length === 0) {
    const text = splitInlineDates(
      markdown
        .split(/\r?\n/)
        .filter((line) => !isMarkdownSeparator(line))
        .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' '))
        .join('\n'),
    );
    rows.push(...parseTextRows(text, adapter, options));
  }
  return {
    ...statementFromRows(rows, adapter, options),
    ...extractStatementBoundaries(markdown),
    sourceText: markdown,
  };
}

interface LayoutLine {
  page: number;
  y: number;
  items: PdfTextItem[];
  text: string;
}

interface LayoutPosition {
  x: number;
  end: number;
}

type LayoutRoles = Partial<Record<Role, LayoutPosition>>;

const LAYOUT_AMOUNT_TOKEN =
  /^(?:₹|inr|rs\.?)?\s*\(?-?\d[\d,]*(?:\.\d{1,2})?\)?\s*(?:cr|dr)?$/i;

function buildLayoutLines(items: PdfTextItem[]): LayoutLine[] {
  const ordered = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: LayoutLine[] = [];
  let current: LayoutLine | undefined;

  for (const item of ordered) {
    const tolerance = Math.max(1.5, Math.min(3, (item.height || 8) * 0.45));
    if (!current || current.page !== item.page || Math.abs(current.y - item.y) > tolerance) {
      current = { page: item.page, y: item.y, items: [], text: '' };
      lines.push(current);
    }
    current.items.push(item);
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return lines;
}

function roleForHeaderToken(token: string): Role | undefined {
  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as Array<[Role, string[]]>) {
    for (const rawAlias of aliases) {
      const alias = normalizeHeader(rawAlias);
      if (token === alias || token.startsWith(`${alias} `) || token.endsWith(` ${alias}`)) {
        return role;
      }
    }
  }
  return undefined;
}

function layoutHeaderRoles(line: LayoutLine): LayoutRoles | undefined {
  const roles: LayoutRoles = {};
  for (const item of line.items) {
    for (const match of item.text.matchAll(/\S+/g)) {
      const token = normalizeHeader(match[0]);
      if (!token) continue;
      const role = roleForHeaderToken(token);
      if (!role || roles[role]) continue;
      const length = Math.max(1, item.text.length);
      const start = (match.index ?? 0) / length;
      const end = ((match.index ?? 0) + match[0].length) / length;
      roles[role] = { x: item.x + item.width * start, end: item.x + item.width * end };
    }
  }

  // A header never carries a transaction date in its leading columns. This
  // guards against prose lines that happen to contain words like "balance".
  const dateLimit =
    roles.description?.x ??
    Math.min(
      ...[roles.debit?.x, roles.credit?.x, roles.amount?.x, roles.balance?.x].filter(
        (value): value is number => value !== undefined,
      ),
    );
  if (
    Number.isFinite(dateLimit) &&
    line.items.some((item) => item.x < dateLimit && parseStatementDate(item.text.trim()))
  ) {
    return undefined;
  }

  let score = Object.keys(roles).length;
  if (!roles.date && !roles.valueDate) score -= 3;
  if (!roles.description) score -= 1;
  if (!roles.debit && !roles.credit && !roles.amount) score -= 2;
  return score >= 3 ? roles : undefined;
}

function layoutAmountRole(x: number, roles: LayoutRoles): Role | undefined {
  const useSplitColumns = Boolean(roles.debit || roles.credit);
  const candidates: Array<{ role: Role; position: LayoutPosition }> = [];
  if (useSplitColumns) {
    if (roles.credit) candidates.push({ role: 'credit', position: roles.credit });
    if (roles.debit) candidates.push({ role: 'debit', position: roles.debit });
  } else if (roles.amount) {
    candidates.push({ role: 'amount', position: roles.amount });
  }
  if (roles.balance) candidates.push({ role: 'balance', position: roles.balance });
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => a.position.x - b.position.x);
  let selected = candidates[0]!.role;
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const next = candidates[index]!;
    const boundary = (previous.position.end + next.position.x) / 2;
    if (x >= boundary) selected = next.role;
  }
  return selected;
}

function layoutLineDate(
  line: LayoutLine,
  roles: LayoutRoles,
): { date: string; item: PdfTextItem; remainder: string } | undefined {
  const descriptionStart = roles.description?.x;
  const dateColumn = roles.date?.x ?? roles.valueDate?.x;
  const leftmost = line.items.reduce((min, item) => Math.min(min, item.x), Number.POSITIVE_INFINITY);
  // A row date sits in the leading date column, not in a reference or a
  // summary cell that merely contains a date. When the header position is
  // known, use it instead of assuming a fixed column width.
  const dateLimit = dateColumn === undefined ? leftmost + 30 : dateColumn + 24;
  for (const item of line.items) {
    if (descriptionStart !== undefined && item.x >= descriptionStart) continue;
    if (item.x > dateLimit) continue;
    const text = item.text.trim();
    const match = matchStatementDate(text);
    if (match) {
      return { date: match.date, item, remainder: text.slice(match.length).trim() };
    }
  }
  return undefined;
}

function isLayoutNoiseLine(text: string): boolean {
  return (
    isNoiseLine(text) ||
    /^\d+\s+of\s+\d+\b/i.test(text) ||
    /^page\s+\d+\b/i.test(text)
  );
}

function isLayoutSectionBreak(text: string): boolean {
  return /^(?:summary\b|statement of\b|account details\b|account holders?\b|fixed deposits?\b|deposits linked\b|other information\b|nominee\b|please note\b|this is a computer[- ]generated\b)/i.test(
    text,
  );
}

export function parsePositionedStatement(
  items: PdfTextItem[],
  options: ParseStatementOptions = {},
): ParsedStatement {
  const adapter = resolveAdapter(
    items
      .map((item) => item.text)
      .join(' ')
      .slice(0, 200_000),
    options,
  );
  const lines = buildLayoutLines(items);
  const rows: ParsedStatementRow[] = [];
  let roles: LayoutRoles | undefined;
  let current: { page: number; date: string; lines: LayoutLine[] } | undefined;
  let openingBalanceMinor: number | undefined;
  let closingBalanceMinor: number | undefined;

  const finishBlock = () => {
    if (!current || !roles) return;
    const block = current;
    current = undefined;
    const amountRoles: Role[] = ['credit', 'debit', 'amount', 'balance'];
    const amountStart = Math.min(
      ...amountRoles
        .map((role) => roles?.[role]?.x)
        .filter((value): value is number => value !== undefined),
    );
    const allItems = block.lines.flatMap((line) => line.items);
    const byRole: Partial<Record<Role, PdfTextItem[]>> = {};
    for (const item of allItems) {
      const text = item.text.trim();
      if (!LAYOUT_AMOUNT_TOKEN.test(text)) continue;
      const role = layoutAmountRole(item.x, roles);
      if (!role) continue;
      (byRole[role] ??= []).push(item);
    }
    const rightmost = (role: Role): PdfTextItem | undefined =>
      (byRole[role] ?? []).slice().sort((a, b) => b.x - a.x)[0];

    const creditItem = rightmost('credit') ?? rightmost('amount');
    const debitItem = rightmost('debit');
    let creditMinor = creditItem ? parseStatementAmount(creditItem.text) ?? 0 : 0;
    let debitMinor = debitItem ? parseStatementAmount(debitItem.text) ?? 0 : 0;

    if (amountSide(creditItem?.text ?? '') === 'debit' && !debitItem) {
      debitMinor = creditMinor;
      creditMinor = 0;
    }
    if (amountSide(debitItem?.text ?? '') === 'credit' && !creditItem) {
      creditMinor = debitMinor;
      debitMinor = 0;
    }

    const balanceItem = rightmost('balance');
    const balanceMinor = balanceItem ? parseStatementAmount(balanceItem.text) : undefined;

    const description = allItems
      .filter((item) => {
        const text = item.text.trim();
        if (amountStart !== Number.POSITIVE_INFINITY && item.x >= amountStart - 1) return false;
        if (LAYOUT_AMOUNT_TOKEN.test(text)) return false;
        if (parseStatementDate(text)) return false;
        return true;
      })
      .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!description && !balanceItem) return;
    const normalizedDescription = description.toLowerCase();
    const isClosing =
      /^(?:closing balance|balance c\/f|c\/f|carried forward)\b/i.test(description) ||
      normalizedDescription.includes('closing balance');
    const isOpening = !isClosing && isBalanceForwardDescription(description);
    if (isOpening || isClosing) {
      if (balanceMinor !== undefined) {
        if (isOpening && openingBalanceMinor === undefined) openingBalanceMinor = balanceMinor;
        if (isClosing) closingBalanceMinor = balanceMinor;
      }
      return;
    }

    if (debitMinor === 0 && creditMinor === 0) return;
    if (amountStart === Number.POSITIVE_INFINITY && !description) return;

    const raw: Record<string, unknown> = { page: block.page, layout: true };
    const row: ParsedStatementRow = {
      date: block.date,
      description: description || 'Statement line',
      debitMinor,
      creditMinor,
      page: block.page,
      currency: options.currency ?? 'INR',
      raw,
    };
    if (balanceMinor !== undefined) row.balanceMinor = balanceMinor;
    rows.push(row);
    assertRowLimit(rows.length, 'PDF statement');
  };

  for (const line of lines) {
    const header = layoutHeaderRoles(line);
    if (header) {
      finishBlock();
      roles = header;
      continue;
    }
    if (!roles) continue;
    const dateHit = layoutLineDate(line, roles);
    if (dateHit) {
      finishBlock();
      // A bank may emit the date and the narration as one text run. Keep the
      // remainder so the transaction description is not lost.
      const items = line.items.flatMap((item) => {
        if (item !== dateHit.item) return [item];
        return dateHit.remainder ? [{ ...item, text: dateHit.remainder }] : [];
      });
      current = {
        page: line.page,
        date: dateHit.date,
        lines: [
          {
            ...line,
            items,
            text: items
              .map((item) => item.text)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim(),
          },
        ],
      };
      continue;
    }
    if (current && (isLayoutSectionBreak(line.text) || line.page !== current.page)) {
      finishBlock();
      continue;
    }
    if (current && !isLayoutNoiseLine(line.text)) current.lines.push(line);
  }
  finishBlock();

  const statement = statementFromRows(rows, adapter, options);
  if (openingBalanceMinor !== undefined) statement.openingBalanceMinor = openingBalanceMinor;
  if (closingBalanceMinor !== undefined) statement.closingBalanceMinor = closingBalanceMinor;
  return statement;
}

function parseExtractedPdfMarkdown(
  markdown: string,
  options: ParseStatementOptions,
): ParsedStatement {
  const adapter = resolveAdapter(markdown, options);
  if (['nps', 'ppf', 'interest', 'p2p'].includes(adapter.kind)) {
    const specialized = parseSpecializedStatement(markdown, {
      fileName: options.fileName,
      kind: adapter.kind,
    });
    if (specialized && specialized.rows.length > 0) return specialized;
  }
  return parseMarkdownStatement(markdown, options);
}

type BalanceStatus = 'verified' | 'unverifiable' | 'mismatch';

function balanceStatus(statement: ParsedStatement): BalanceStatus {
  if (statement.rows.length === 0) return 'mismatch';
  const lines: BalanceLine[] = statement.rows.map((row, index) => ({
    lineNo: index + 1,
    date: row.date,
    description: row.description,
    debitMinor: row.debitMinor,
    creditMinor: row.creditMinor,
    balanceMinor: row.balanceMinor,
    page: row.page,
  }));
  const assertion = verifyStatementBalance(lines, {
    openingBalanceMinor: statement.openingBalanceMinor,
    closingBalanceMinor: statement.closingBalanceMinor,
  });
  if (assertion.mismatches.length > 0) return 'mismatch';
  // Rows without any balance carry no arithmetic evidence, so a "clean"
  // assertion would be vacuous. Verified extraction needs a real check.
  return assertion.checked > 0 || assertion.closingDifferenceMinor !== undefined
    ? 'verified'
    : 'unverifiable';
}

// Prefer Docling in development so its table output can be validated in
// `tauri:dev`. Production builds keep native-first extraction.
const PREFER_DOCLING = import.meta.env.DEV;
const DEBUG_PDF = import.meta.env.DEV && import.meta.env.MODE !== 'test';

export async function parsePdfStatement(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseStatementOptions & { password?: string } = {},
): Promise<ParsedStatement> {
  assertByteLimit(bytes, 'PDF');

  let docling: PdfOcrResult | undefined;
  if (PREFER_DOCLING) {
    docling = await pdfOcrFromDocling(bytes, options.password);
    if (docling.markdown) {
      const parsed = parseExtractedPdfMarkdown(docling.markdown, options);
      if (DEBUG_PDF) {
        console.info(
          `[pdf] Docling: ${parsed.rows.length} rows, balance ${balanceStatus(parsed)}`,
        );
      }
      if (parsed.rows.length > 0) return parsed;
    } else if (DEBUG_PDF) {
      console.info(`[pdf] Docling unavailable: ${docling.error ?? docling.code ?? 'no output'}`);
    }
  }

  const anydoc = await pdfMarkdownFromRust(bytes, options.password);
  const anydocParsed = anydoc.markdown ? parseExtractedPdfMarkdown(anydoc.markdown, options) : undefined;
  const anydocStatus =
    anydocParsed && anydocParsed.rows.length > 0 ? balanceStatus(anydocParsed) : undefined;
  if (anydocParsed && anydocStatus === 'verified') return anydocParsed;

  // Borderless statement tables are often flattened by generic Markdown
  // conversion. Positioned runs preserve the debit/credit/balance columns
  // without the cost of OCR.
  const layout = await pdfLayoutFromRust(bytes, options.password);
  const layoutParsed =
    Array.isArray(layout.items) && layout.items.length > 0
      ? parsePositionedStatement(layout.items, options)
      : undefined;
  const layoutStatus =
    layoutParsed && layoutParsed.rows.length > 0 ? balanceStatus(layoutParsed) : undefined;
  if (layoutParsed && layoutStatus === 'verified') return layoutParsed;

  // A statement with no balance column cannot be proven arithmetically.
  // Prefer the default converter, then layout geometry, and skip OCR.
  if (anydocParsed && anydocStatus === 'unverifiable') return anydocParsed;
  if (layoutParsed && layoutStatus === 'unverifiable') return layoutParsed;

  if (!docling) docling = await pdfOcrFromDocling(bytes, options.password);
  if (docling.markdown) {
    const parsed = parseExtractedPdfMarkdown(docling.markdown, options);
    if (parsed.rows.length > 0) return parsed;
  }

  const anydocDetail = anydoc.error
    ? `anydoc${anydoc.code ? ` (${anydoc.code})` : ''} failed: ${anydoc.error}`
    : anydocParsed && anydocParsed.rows.length > 0
      ? 'anydoc extracted rows that failed balance verification'
      : anydoc.markdown
        ? 'anydoc extracted no statement rows'
        : 'anydoc returned no output';
  const layoutDetail = layout.error
    ? `layout${layout.code ? ` (${layout.code})` : ''} failed: ${layout.error}`
    : layoutParsed && layoutParsed.rows.length > 0
      ? `layout extracted ${layoutParsed.rows.length} rows that failed balance verification`
      : 'layout extracted no statement rows';
  throw new ScannedPdfError(
    docling.error
      ? `PDF extraction failed. ${anydocDetail}. ${layoutDetail}. Docling failed: ${docling.error}`
      : `PDF extraction failed. ${anydocDetail}. ${layoutDetail}. Docling returned no statement rows.`,
  );
}
