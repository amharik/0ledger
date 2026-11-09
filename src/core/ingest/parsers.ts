import Papa from 'papaparse';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseAmountToMinor } from '@/core/money/money';
import { detectStatementAdapter, getAdapter } from './adapters';
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

function rowFromCells(
  cells: string[],
  roles: Partial<Record<Role, number>>,
  headers: string[],
  adapter: StatementAdapter,
  options: ParseStatementOptions,
): ParsedStatementRow | undefined {
  const date = parseStatementDate(getCell(cells, roles, 'date')) ?? parseStatementDate(getCell(cells, roles, 'valueDate'));
  if (!date) return undefined;

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

  const description = getCell(cells, roles, 'description');
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
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
  });
  assertRowLimit(parsed.data.length, 'CSV statement');
  const adapter = resolveAdapter(text, options);
  return statementFromRows(rowsFromTable(parsed.data, adapter, options), adapter, options);
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
  return statementFromRows(rowsFromTable(table, adapter, options), adapter, options);
}

export class ScannedPdfError extends Error {
  readonly requiresOcr = true;

  constructor(message = 'PDF has no text layer. OCR is required but is not enabled in this build.') {
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
    }
    return lines.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

const TEXT_AMOUNT = /(?:(?:₹|inr|rs\.?)\s*)?\(?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?\s*(?:cr|dr)?/gi;

export function parseTextRows(text: string, adapter: StatementAdapter, options: ParseStatementOptions = {}): ParsedStatementRow[] {
  assertTextLimit(text, 'Text statement');
  const rows: ParsedStatementRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const dateMatch = trimmed.match(
      /^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}|[A-Za-z]{3,9}[\s-]+\d{1,2}[\s,-]+\d{2,4})\b/,
    );
    const date = parseStatementDate(dateMatch?.[0] ?? '');
    if (!date) continue;

    const rest = trimmed.slice(dateMatch?.[0]?.length ?? 0).trim();
    const matches = [...rest.matchAll(TEXT_AMOUNT)].filter((match) => {
      const token = match[0].trim();
      return /[.,]/.test(token) || /(?:₹|inr|rs)/i.test(token);
    });
    if (matches.length === 0) continue;

    const amountMatch = matches[matches.length - (matches.length >= 2 ? 2 : 1)];
    const balanceMatch = matches.length >= 2 ? matches[matches.length - 1] : undefined;
    if (!amountMatch) continue;
    const amount = parseStatementAmount(amountMatch[0]);
    if (!amount) continue;

    const beforeAmount = rest.slice(0, amountMatch.index).trim();
    const afterAmount = rest.slice((amountMatch.index ?? 0) + amountMatch[0].length).trim();
    const side =
      amountSide(amountMatch[0]) ??
      (/^(?:cr|credit)\b/i.test(afterAmount) ? 'credit' : /^(?:dr|debit)\b/i.test(afterAmount) ? 'debit' : undefined);
    const lower = rest.toLowerCase();
    const debit = side === 'debit' || /(?:debit|withdraw|paid|payment|purchase|toll|deducted)/.test(lower);
    const credit = side === 'credit' || /(?:credit|deposit|received|refund|recharge)/.test(lower);
    const isDebit = debit && !credit ? true : credit && !debit ? false : adapter.kind === 'fastag';

    const balance = balanceMatch ? parseStatementAmount(balanceMatch[0]) : undefined;
    const row: ParsedStatementRow = {
      date,
      description: beforeAmount || 'Statement line',
      debitMinor: isDebit ? amount : 0,
      creditMinor: isDebit ? 0 : amount,
      currency: options.currency ?? 'INR',
      raw: { line: trimmed },
    };
    if (balance !== undefined) row.balanceMinor = balance;
    rows.push(row);
    assertRowLimit(rows.length, 'Text statement');
  }
  return rows;
}

export function parseTextStatement(text: string, options: ParseStatementOptions = {}): ParsedStatement {
  const adapter = resolveAdapter(text, options);
  return {
    ...statementFromRows(parseTextRows(text, adapter, options), adapter, options),
    sourceText: text,
  };
}

export async function parsePdfStatement(
  bytes: ArrayBuffer | Uint8Array,
  options: ParseStatementOptions & { password?: string } = {},
): Promise<ParsedStatement> {
  assertByteLimit(bytes, 'PDF');
  const text = await pdfText(bytes, options.password);
  if (!OCR_ENABLED && text.replace(/\s/g, '').length < 20) {
    throw new ScannedPdfError();
  }
  const adapter = resolveAdapter(text, options);
  return {
    ...statementFromRows(parseTextRows(text, adapter, options), adapter, options),
    sourceText: text,
  };
}
