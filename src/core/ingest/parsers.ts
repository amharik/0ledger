import Papa from 'papaparse';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter, getAdapter } from './adapters';
import { parseSpecializedStatement } from './specialized';
import { pdfMarkdownFromRust, pdfOcrFromDocling } from './pdf-rust';
import {
  MAX_PDF_PAGES,
  assertByteLimit,
  assertRowLimit,
  assertTextLimit,
} from './limits';
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

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dmy) return validDate(normalizeYear(dmy[3] ?? ''), Number(dmy[2]), Number(dmy[1]));

  const dMonY = text.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})/);
  if (dMonY) {
    const month = MONTHS[(dMonY[2] ?? '').toLowerCase()];
    if (month) return validDate(normalizeYear(dMonY[3] ?? ''), month, Number(dMonY[1]));
  }

  const monDY = text.match(/^([A-Za-z]{3,9})[\s-]+(\d{1,2})[\s,-]+(\d{2,4})/);
  if (monDY) {
    const month = MONTHS[(monDY[1] ?? '').toLowerCase()];
    if (month) return validDate(normalizeYear(monDY[3] ?? ''), month, Number(monDY[2]));
  }

  return undefined;
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
  `\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}[\\s-]+${INLINE_MONTH}[\\s,-]+\\d{2,4}|${INLINE_MONTH}[\\s-]+\\d{1,2}[\\s,-]+\\d{2,4})\\b`,
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

  constructor(message = 'PDF has no text layer. Docling OCR fallback is unavailable.') {
    super(message);
    this.name = 'ScannedPdfError';
  }
}

export const OCR_ENABLED = false;

async function pdfText(bytes: ArrayBuffer | Uint8Array, password?: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const loadingTask = pdfjs.getDocument({
    data,
    password,
    useSystemFonts: true,
  });
  try {
    const doc = await loadingTask.promise;
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF has too many pages (max ${MAX_PDF_PAGES})`);
    }
    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const positioned = content.items
        .flatMap((item) => {
          if (!('str' in item) || !('transform' in item)) return [];
          const transform = item.transform as number[];
          return [{ text: item.str, x: transform[4] ?? 0, y: transform[5] ?? 0 }];
        })
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const byLine = new Map<number, string[]>();
      for (const item of positioned) {
        const key = Math.round(item.y * 2) / 2;
        const bucket = byLine.get(key) ?? [];
        bucket.push(item.text);
        byLine.set(key, bucket);
      }
      for (const value of [...byLine.entries()].sort((a, b) => b[0] - a[0]).map((entry) => entry[1])) {
        lines.push(value.join(' ').replace(/\s+/g, ' ').trim());
      }
      if (pageNumber < doc.numPages) lines.push(PAGE_BREAK);
    }
    return lines.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

const PAGE_BREAK = '\u000c';
const DATE_START =
  /^(?:[*-]\s*)?(?:\d{1,4}\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}|[A-Za-z]{3,9}[\s-]+\d{1,2}[\s,-]+\d{2,4})\b/;
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

export async function parsePdfStatement(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseStatementOptions & { password?: string } = {},
): Promise<ParsedStatement> {
  assertByteLimit(bytes, 'PDF');
  if (!options.password) {
    const markdown = await pdfMarkdownFromRust(bytes);
    if (markdown) {
      const parsed = parseMarkdownStatement(markdown, options);
      if (parsed.rows.length > 0) return parsed;
    }
  }
  const text = await pdfText(bytes, options.password);
  if (text.replace(/\s/g, '').length < 20) {
    const ocr = await pdfOcrFromDocling(bytes);
    if (ocr.markdown) {
      const parsed = parseMarkdownStatement(ocr.markdown, options);
      if (parsed.rows.length > 0) return parsed;
    }
    throw new ScannedPdfError(
      ocr.error
        ? `PDF has no text layer. Docling OCR failed: ${ocr.error}`
        : 'PDF has no text layer. Docling OCR returned no statement rows.',
    );
  }
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
