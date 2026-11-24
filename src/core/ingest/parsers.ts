import Papa from 'papaparse';
import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter, getAdapter } from './adapters';
import { parseSpecializedStatement } from './specialized';
import { pdfDoclingFromRust } from './pdf-rust';
import { detectInstitution, identifyUniqueAccount } from './accounts';
import { assertByteLimit, assertRowLimit, assertTextLimit } from './limits';
import { verifyStatementBalance, type BalanceLine, type BalanceMismatch } from './balance';
import type {
  ParsedStatement,
  ParsedStatementMetadata,
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
    if (
      isSummaryRow(cells) &&
      !parseStatementDate(cells[header.roles.date ?? -1] ?? '')
    ) {
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

  constructor(message = 'PDF extraction failed. Docling did not produce a statement.') {
    super(message);
    this.name = 'ScannedPdfError';
  }
}

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

const BOUNDARY_CELL =
  /^(?:opening balance|balance b\/f|b\/f|brought forward|closing balance|balance c\/f|c\/f|carried forward)[.:;-]*$/i;
const OPENING_LABEL = /^(?:opening balance|balance b\/f|b\/f|brought forward)\b(?!\s*\()/i;
const CLOSING_LABEL = /^(?:closing balance|balance c\/f|c\/f|carried forward)\b(?!\s*\()/i;

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
      // A boundary cell must be exactly the label. This deliberately ignores
      // qualified summary rows such as "Closing Balance (Cumulative)".
      candidate = cells.find((cell) => BOUNDARY_CELL.test(cell.trim())) ?? '';
    } else {
      const dateMatch = line.match(DATE_START);
      if (dateMatch) candidate = line.slice(dateMatch[0].length).trim();
    }
    if (!candidate) continue;
    const opening = OPENING_LABEL.test(candidate);
    const closing = CLOSING_LABEL.test(candidate);
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

function looksLikeAmountCell(value: string): boolean {
  return /^[\s(]*(?:₹|inr|rs\.?)?\s*-?\d[\d,]*(?:\.\d{1,2})?\)?\s*(?:cr|dr)?$/i.test(value.trim());
}

const SUMMARY_ROW =
  /^(?:total|grand\s+total|sub\s*total|subtotal|opening\s+balance|closing\s+balance|balance\s+[bc]\/f|statement\s+summary|end\s+of\s+statement)\b/i;

function isSummaryRow(cells: string[]): boolean {
  return cells.some((cell) => SUMMARY_ROW.test(cell.trim()));
}

function tableHeaderSignature(table: string[][]): string | undefined {
  const header = findHeader(table);
  if (!header) return undefined;
  return (table[header.index] ?? [])
    .map((cell) => normalizeHeader(cell))
    .filter(Boolean)
    .join('|');
}

/**
 * Join a row that was split by a page break onto the previous row. Docling
 * sometimes ends a page with the date/narration and starts the next page with
 * only the amount and balance cells.
 */
function mergeContinuationRows(rows: string[][]): string[][] {
  const merged: string[][] = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push([...row]);
      continue;
    }
    // Never absorb an opening/closing/total summary row into the last
    // transaction, even when it carries the same number of columns.
    if (isSummaryRow(row) || row.some(isBalanceForwardDescription)) {
      merged.push([...row]);
      continue;
    }
    const rowHasDate = row.some((cell) => parseStatementDate(cell) !== undefined);
    const previousHasDate = previous.some((cell) => parseStatementDate(cell) !== undefined);
    const rowHasAmount = row.some(looksLikeAmountCell);
    const previousHasAmount = previous.some(looksLikeAmountCell);
    const shouldJoin = (!rowHasDate && previousHasDate) || (rowHasAmount && !previousHasAmount);
    if (!shouldJoin) {
      merged.push([...row]);
      continue;
    }
    const width = Math.max(previous.length, row.length);
    for (let index = 0; index < width; index += 1) {
      const value = (row[index] ?? '').trim();
      if (!value) continue;
      const existing = (previous[index] ?? '').trim();
      previous[index] = existing ? `${existing} ${value}` : value;
    }
  }
  return merged;
}

/**
 * Docling emits one Markdown table per detected table/page. Re-join tables
 * that repeat the same header, or continuation tables with the same column
 * shape, so a statement that spans pages is parsed as one ledger.
 */
function mergeMarkdownTables(tables: string[][][]): string[][][] {
  const merged: string[][][] = [];
  let current: string[][] | undefined;
  let currentSignature: string | undefined;
  let currentColumns = 0;

  for (const table of tables) {
    if (table.length === 0) continue;
    const header = findHeader(table);
    const signature = tableHeaderSignature(table);
    if (header && header.index <= 1) {
      if (current && signature && currentSignature === signature) {
        current.push(...table.slice(header.index + 1));
      } else {
        current = [...table];
        currentSignature = signature;
        currentColumns = current[0]?.length ?? 0;
        merged.push(current);
      }
      continue;
    }
    const looksTransactional = table.some(
      (row) =>
        row.some((cell) => parseStatementDate(cell) !== undefined) ||
        row.some(looksLikeAmountCell),
    );
    const sameShape =
      current !== undefined &&
      currentSignature !== undefined &&
      looksTransactional &&
      table.every((row) => row.length === currentColumns);
    if (current && sameShape) {
      current.push(...table);
    } else {
      current = [...table];
      currentSignature = undefined;
      currentColumns = current[0]?.length ?? 0;
      merged.push(current);
    }
  }

  return merged.map((table) => {
    const header = findHeader(table);
    if (!header) return mergeContinuationRows(table);
    return [
      ...table.slice(0, header.index + 1),
      ...mergeContinuationRows(table.slice(header.index + 1)),
    ];
  });
}

export function parseMarkdownStatement(
  markdown: string,
  options: ParseStatementOptions = {},
): ParsedStatement {
  assertTextLimit(markdown, 'Markdown statement');
  const adapter = resolveAdapter(markdown, options);
  const rows: ParsedStatementRow[] = [];
  for (const table of mergeMarkdownTables(extractMarkdownTables(markdown))) {
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

function parseExtractedPdfMarkdown(
  markdown: string,
  options: ParseStatementOptions,
): ParsedStatement {
  const adapter = resolveAdapter(markdown, options);
  let statement: ParsedStatement | undefined;
  if (['nps', 'ppf', 'interest', 'p2p'].includes(adapter.kind)) {
    const specialized = parseSpecializedStatement(markdown, {
      fileName: options.fileName,
      kind: adapter.kind,
    });
    if (specialized && specialized.rows.length > 0) statement = specialized;
  }
  statement ??= parseMarkdownStatement(markdown, options);
  const metadata = extractPdfMetadata(markdown);
  if (metadata) statement.metadata = { ...(statement.metadata ?? {}), ...metadata };
  return statement;
}

type BalanceStatus = 'verified' | 'unverifiable' | 'mismatch';

export class StatementReconciliationError extends Error {
  readonly mismatches: BalanceMismatch[];
  readonly issues: string[];

  constructor(message: string, options: { mismatches?: BalanceMismatch[]; issues?: string[] } = {}) {
    super(message);
    this.name = 'StatementReconciliationError';
    this.mismatches = options.mismatches ?? [];
    this.issues = options.issues ?? [];
  }
}

interface ReconciliationOutcome {
  status: BalanceStatus;
  repaired: number;
  mismatches: BalanceMismatch[];
  issues: string[];
}

function statementLines(statement: ParsedStatement): BalanceLine[] {
  return statement.rows.map((row, index) => ({
    lineNo: index + 1,
    date: row.date,
    description: row.description,
    debitMinor: row.debitMinor,
    creditMinor: row.creditMinor,
    balanceMinor: row.balanceMinor,
    page: row.page,
  }));
}

/**
 * Reconcile extracted rows against the statement's own arithmetic before the
 * rows are allowed to reach the ledger. Obvious extraction mistakes (an amount
 * on the wrong side, a missing amount, a missing running balance) are repaired
 * deterministically; anything that still fails is rejected.
 */
function reconcileStatement(statement: ParsedStatement): ReconciliationOutcome {
  let repaired = 0;
  const issues: string[] = [];

  for (const [index, row] of statement.rows.entries()) {
    if (!Number.isSafeInteger(row.debitMinor) || !Number.isSafeInteger(row.creditMinor)) {
      issues.push(`Row ${index + 1} has a non-integer amount`);
      continue;
    }
    if (row.debitMinor < 0) {
      row.debitMinor = Math.abs(row.debitMinor);
      repaired += 1;
    }
    if (row.creditMinor < 0) {
      row.creditMinor = Math.abs(row.creditMinor);
      repaired += 1;
    }
    if (row.balanceMinor !== undefined && !Number.isSafeInteger(row.balanceMinor)) {
      issues.push(`Row ${index + 1} has a non-integer balance`);
    }
  }

  // Use the statement's own running balance to repair missing or swapped
  // debit/credit columns. Statements are normally chronological, but sort by
  // date (then original line order) so a page break cannot hide a mismatch.
  const ordered = statement.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.date.localeCompare(b.row.date) || a.index - b.index);

  // Seed the running balance from the statement's opening balance. The B/F
  // row itself is not emitted as a transaction, so without this anchor the
  // first real row can never be checked or repaired.
  let previousBalance: number | undefined = statement.openingBalanceMinor;
  for (const { row } of ordered) {
    if (row.debitMinor > 0 && row.creditMinor > 0) {
      // Both sides filled is ambiguous unless the running balance tells us
      // which one is real. Resolve it below when a balance is available.
      if (row.balanceMinor === undefined) {
        issues.push(`Row ${row.date} has both debit and credit amounts`);
      }
    }

    if (row.balanceMinor === undefined) {
      if (previousBalance !== undefined && (row.debitMinor > 0 || row.creditMinor > 0)) {
        row.balanceMinor = previousBalance + row.creditMinor - row.debitMinor;
        previousBalance = row.balanceMinor;
        repaired += 1;
      }
      continue;
    }

    if (previousBalance !== undefined) {
      const delta = row.balanceMinor - previousBalance;
      const expectedDebit = delta < 0 ? -delta : 0;
      const expectedCredit = delta > 0 ? delta : 0;
      const matches = row.debitMinor === expectedDebit && row.creditMinor === expectedCredit;
      if (!matches) {
        const amount = Math.max(row.debitMinor, row.creditMinor);
        const swapped =
          expectedDebit !== expectedCredit &&
          amount === Math.abs(delta) &&
          ((delta > 0 && row.debitMinor === amount) || (delta < 0 && row.creditMinor === amount));
        const missing = row.debitMinor === 0 && row.creditMinor === 0;
        const wrongSide = amount === Math.abs(delta);
        if (swapped || missing || wrongSide) {
          row.debitMinor = expectedDebit;
          row.creditMinor = expectedCredit;
          repaired += 1;
        }
      }
    }
    previousBalance = row.balanceMinor;
  }

  // A row must never carry both sides after repair. If it still does and the
  // balance did not resolve it, reject rather than guessing.
  for (const [index, row] of statement.rows.entries()) {
    if (row.debitMinor > 0 && row.creditMinor > 0) {
      issues.push(`Row ${index + 1} has both debit and credit amounts`);
    }
  }

  const assertion = verifyStatementBalance(statementLines(statement), {
    openingBalanceMinor: statement.openingBalanceMinor,
    closingBalanceMinor: statement.closingBalanceMinor,
  });
  const status: BalanceStatus =
    assertion.mismatches.length > 0
      ? 'mismatch'
      : assertion.checked > 0 || assertion.closingDifferenceMinor !== undefined
        ? 'verified'
        : 'unverifiable';

  return { status, repaired, mismatches: assertion.mismatches, issues };
}

function formatReconciliationError(outcome: ReconciliationOutcome): string {
  const parts: string[] = [];
  if (outcome.issues.length > 0) parts.push(outcome.issues.slice(0, 5).join('; '));
  if (outcome.mismatches.length > 0) {
    const first = outcome.mismatches[0];
    const where =
      first?.kind === 'closing' ? 'closing balance' : `row ${first?.lineNo ?? '?'}`;
    parts.push(
      `${outcome.mismatches.length} balance mismatch${outcome.mismatches.length === 1 ? '' : 'es'} (first: ${where} expected ${first?.expectedMinor ?? '?'} actual ${first?.actualMinor ?? '?'})`,
    );
  }
  return `Statement does not reconcile. ${parts.join(' ')}`.trim();
}

const DEBUG_PDF = import.meta.env.DEV && import.meta.env.MODE !== 'test';

function maskAccountNumber(value: string): { masked: string; tail: string } | undefined {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  const alreadyMasked = /[Xx*•]/.test(trimmed);
  if (digits.length < (alreadyMasked ? 4 : 6)) return undefined;
  const tail = digits.slice(-4);
  // Preserve the bank's own masking (for example XXXXXXXX1234) instead of
  // replacing it with bullets; otherwise mask a full account number.
  if (alreadyMasked) {
    return { masked: trimmed.replace(/[\s-]/g, '').replace(/x/g, 'X'), tail };
  }
  return { masked: `••••${tail}`, tail };
}

const MONTH_TOKEN =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_TOKEN = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2}\\s*${MONTH_TOKEN}\\s*\\d{2,4}|${MONTH_TOKEN}\\s*\\d{1,2}\\s*,?\\s*\\d{2,4})`;
const PERIOD_PATTERN = new RegExp(
  `(?:statement\\s*(?:period|from)|period|for\\s+the\\s+period)\\s*[:\\s|]*(${DATE_TOKEN})\\s*(?:to|[-–—])\\s*(${DATE_TOKEN})`,
  'i',
);

const METADATA_LABELS =
  /\s+(?:account\s*(?:no\.?|number|holder)|a\/c|ifsc|branch|customer\s*name|statement\s*(?:period|from)|period)\b.*$/i;

function cleanMetadataValue(value: string): string {
  return value.replace(METADATA_LABELS, '').replace(/\s+/g, ' ').trim();
}

function extractPdfMetadata(markdown: string): ParsedStatementMetadata | undefined {
  const metadata: ParsedStatementMetadata = {};
  const account = identifyUniqueAccount({ text: markdown });
  if (account) {
    metadata.accountNumberMasked = account.accountNumberMasked;
    metadata.accountTail = account.accountTail;
    metadata.accountCategory = account.category;
    if (account.institution) metadata.institution = account.institution;
  }

  const labeledAccount = markdown.match(
    /(?:account\s*(?:no\.?|number)|a\/c\s*(?:no\.?|number)?)[:\s|]*([Xx*•\d][Xx*•\d\s-]{5,24})/i,
  )?.[1];
  if (labeledAccount) {
    const masked = maskAccountNumber(labeledAccount);
    if (
      masked &&
      (!metadata.accountNumberMasked ||
        masked.masked.length > metadata.accountNumberMasked.length)
    ) {
      metadata.accountNumberMasked = masked.masked;
      metadata.accountTail = masked.tail;
      metadata.accountCategory ??= 'bank_account';
    }
  }

  const institution = detectInstitution(markdown);
  if (institution && !metadata.institution) metadata.institution = institution;

  const ifsc = markdown.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/)?.[1];
  if (ifsc) metadata.ifsc = ifsc;

  const holder = markdown.match(
    /(?:account\s*holders?|customer\s*name|name\s*of\s*(?:the\s*)?account\s*holder)[:\s|]+([A-Za-z][A-Za-z0-9 .'&/-]{2,80})/i,
  )?.[1];
  if (holder) metadata.accountHolder = cleanMetadataValue(holder);

  const branch = markdown.match(/(?:branch(?:\s*name)?)[:\s|]+([A-Za-z][A-Za-z .'-]{2,60})/i)?.[1];
  if (branch) metadata.branch = cleanMetadataValue(branch);

  const period = markdown.match(PERIOD_PATTERN);
  if (period) {
    const from = parseStatementDate(period[1]);
    const to = parseStatementDate(period[2]);
    if (from) metadata.statementFrom = from;
    if (to) metadata.statementTo = to;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export async function parsePdfStatement(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseStatementOptions & { password?: string } = {},
): Promise<ParsedStatement> {
  assertByteLimit(bytes, 'PDF');

  const result = await pdfDoclingFromRust(bytes, options.password, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  if (result.error || !result.markdown) {
    throw new ScannedPdfError(
      result.error
        ? `PDF extraction failed. Docling${result.code ? ` (${result.code})` : ''}: ${result.error}`
        : 'PDF extraction failed. Docling returned no Markdown output.',
    );
  }

  const statement = parseExtractedPdfMarkdown(result.markdown, options);
  // The raw Markdown can contain full account numbers and holder details.
  // Rows and metadata are sufficient downstream, so never retain it.
  delete statement.sourceText;
  if (statement.rows.length === 0) {
    throw new ScannedPdfError('PDF extraction failed. Docling returned no statement rows.');
  }
  if (statement.closingBalanceMinor === undefined) {
    const ordered = [...statement.rows].sort((a, b) => a.date.localeCompare(b.date));
    const lastBalance = ordered[ordered.length - 1]?.balanceMinor;
    if (lastBalance !== undefined) statement.closingBalanceMinor = lastBalance;
  }

  const outcome = reconcileStatement(statement);
  const metadata: ParsedStatementMetadata = {
    ...(statement.metadata ?? {}),
    extractor: result.mode === 'native' ? 'docling-native' : 'docling-ocr',
    pageCount: result.page_count,
    textPages: result.text_pages,
    ocrPages: result.ocr_pages,
    ...(outcome.repaired > 0 ? { repairedRows: outcome.repaired } : {}),
  };
  statement.metadata = metadata;

  if (DEBUG_PDF) {
    console.info(
      `[pdf] Docling ${result.mode}: ${statement.rows.length} rows, ${outcome.status}, ${outcome.repaired} repaired`,
    );
  }

  if (outcome.issues.length > 0 || outcome.status === 'mismatch') {
    throw new StatementReconciliationError(formatReconciliationError(outcome), {
      mismatches: outcome.mismatches,
      issues: outcome.issues,
    });
  }

  return statement;
}
