import { getDb } from '@/core/db/db';
import type { LedgerDatabase } from '@/core/db/db';
import { newId, nowIso } from '@/core/ids';
import {
  AuditEventSchema,
  ImportBatchSchema,
  StatementLineSchema,
  type ImportBatch,
  type ImportSource,
  type NewVoucher,
  type StatementLine,
  type VoucherType,
} from '@/core/model';
import { compact } from '@/core/util/objects';
import { sha256Hex } from '@/core/util/hash';
import { cancelVoucher, deleteVoucher, postVoucher } from '@/core/ledger';
import { parseCsvStatement, parsePdfStatement, parseTextStatement, parseXlsxStatement } from './parsers';
import { parseEmailStatements } from './email';
import type { IngestFileInput, ParsedStatement, ParsedStatementRow } from './types';

export interface StageImportInput {
  workspaceId: string;
  source: ImportSource;
  statement: ParsedStatement;
  fileName?: string;
  fileSha256?: string;
  accountId?: string;
}

export interface StageImportResult {
  batch: ImportBatch;
  lines: StatementLine[];
  duplicates: number;
}

function signature(row: {
  date: string;
  description: string;
  reference?: string | undefined;
  debitMinor: number;
  creditMinor: number;
}): string {
  return [
    row.date,
    row.debitMinor,
    row.creditMinor,
    (row.reference ?? '').trim().toLowerCase(),
    row.description.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('|');
}

export async function stageImport(
  db: LedgerDatabase,
  input: StageImportInput,
): Promise<StageImportResult> {
  if (!input.statement.rows.length) throw new Error('Statement has no transaction rows');

  const existing = await db.statementLines.where('workspaceId').equals(input.workspaceId).toArray();
  const seen = new Set(existing.map(signature));
  const now = nowIso();
  const batchId = newId('imp');
  const lines: StatementLine[] = [];
  let duplicates = 0;

  input.statement.rows.forEach((row, index) => {
    const key = signature(row);
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    lines.push(
      StatementLineSchema.parse(
        compact({
          id: newId('stl'),
          workspaceId: input.workspaceId,
          importBatchId: batchId,
          accountId: input.accountId,
          lineNo: lines.length + 1,
          date: row.date,
          valueDate: row.valueDate,
          description: row.description,
          reference: row.reference,
          debitMinor: row.debitMinor,
          creditMinor: row.creditMinor,
          balanceMinor: row.balanceMinor,
          currency: row.currency,
          raw: row.raw,
          matchStatus: 'unmatched',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  });

  if (lines.length === 0) throw new Error('All rows are already staged or imported');

  const batch = ImportBatchSchema.parse(
    compact({
      id: batchId,
      workspaceId: input.workspaceId,
      source: input.source,
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      adapterId: input.statement.adapterId,
      adapterVersion: '1',
      status: 'staged',
      totalLines: lines.length,
      committedLines: 0,
      failedLines: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );

  await db.transaction('rw', [db.importBatches, db.statementLines], async () => {
    await db.importBatches.add(batch);
    await db.statementLines.bulkAdd(lines);
  });

  return { batch, lines, duplicates };
}

export async function ingestFile(
  db: LedgerDatabase,
  workspaceId: string,
  input: IngestFileInput,
  options: { accountId?: string; password?: string } = {},
): Promise<StageImportResult[]> {
  const fileName = input.fileName;
  const lower = fileName.toLowerCase();
  const source: ImportSource = lower.endsWith('.eml')
    ? 'email'
    : lower.endsWith('.pdf')
      ? 'pdf'
      : lower.endsWith('.xlsx') || lower.endsWith('.xls')
        ? 'xlsx'
        : lower.endsWith('.csv')
          ? 'csv'
          : 'manual';
  const fileSha256 = input.bytes ? await sha256Hex(input.bytes) : await sha256Hex(input.text ?? '');

  const statements: ParsedStatement[] = [];
  if (lower.endsWith('.eml')) {
    if (!input.text && !input.bytes) throw new Error('Email file has no content');
    const password = options.password ?? input.password;
    const result = await parseEmailStatements(input.text ?? input.bytes!, {
      ...(password ? { password } : {}),
    });
    statements.push(...result.statements);
  } else if (lower.endsWith('.pdf')) {
    if (!input.bytes) throw new Error('PDF file has no bytes');
    const password = options.password ?? input.password;
    statements.push(
      await parsePdfStatement(input.bytes, {
        fileName,
        ...(password ? { password } : {}),
      }),
    );
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    if (!input.bytes) throw new Error('Workbook has no bytes');
    statements.push(await parseXlsxStatement(input.bytes, { fileName }));
  } else if (lower.endsWith('.csv')) {
    if (!input.text && !input.bytes) throw new Error('CSV file has no content');
    const text = input.text ?? new TextDecoder().decode(input.bytes);
    statements.push(parseCsvStatement(text, { fileName }));
  } else {
    if (!input.text) throw new Error('Text statement has no content');
    statements.push(parseTextStatement(input.text, { fileName }));
  }

  if (statements.length === 0) throw new Error('No statement found in file or email');
  const results: StageImportResult[] = [];
  for (const statement of statements) {
    results.push(
      await stageImport(db, {
        workspaceId,
        source: statement.kind === 'fastag' ? 'fastag' : source,
        statement,
        fileName,
        fileSha256,
        ...(options.accountId ? { accountId: options.accountId } : {}),
      }),
    );
  }
  return results;
}

export interface BalanceMismatch {
  lineNo: number;
  date: string;
  description: string;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
}

export interface BalanceAssertion {
  checked: number;
  openingMinor?: number;
  closingMinor?: number;
  mismatches: BalanceMismatch[];
}

export function verifyStatementBalance(lines: StatementLine[]): BalanceAssertion {
  const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  let previousBalance: number | undefined;
  let openingMinor: number | undefined;
  let closingMinor: number | undefined;
  let checked = 0;
  const mismatches: BalanceMismatch[] = [];

  for (const line of ordered) {
    if (line.balanceMinor === undefined) continue;
    if (previousBalance === undefined) {
      previousBalance = line.balanceMinor;
      openingMinor = line.balanceMinor;
      closingMinor = line.balanceMinor;
      continue;
    }
    const expectedMinor = previousBalance + line.creditMinor - line.debitMinor;
    checked += 1;
    if (expectedMinor !== line.balanceMinor) {
      mismatches.push({
        lineNo: line.lineNo,
        date: line.date,
        description: line.description,
        expectedMinor,
        actualMinor: line.balanceMinor,
        differenceMinor: line.balanceMinor - expectedMinor,
      });
    }
    previousBalance = line.balanceMinor;
    closingMinor = line.balanceMinor;
  }

  return {
    checked,
    ...(openingMinor === undefined ? {} : { openingMinor }),
    ...(closingMinor === undefined ? {} : { closingMinor }),
    mismatches,
  };
}

export interface CommitImportOptions {
  accountId: string;
  defaultLedgerId: string;
  rules?: Array<{ pattern: string; ledgerId: string }>;
  actor?: string;
}

function contraLedgerId(description: string, options: CommitImportOptions): string {
  const lower = description.toLowerCase();
  for (const rule of options.rules ?? []) {
    if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) return rule.ledgerId;
  }
  return options.defaultLedgerId;
}

export interface CommitImportResult {
  batch: ImportBatch;
  committed: number;
  failed: number;
  errors: string[];
}

export async function commitImportBatch(
  db: LedgerDatabase,
  workspaceId: string,
  batchId: string,
  options: CommitImportOptions,
): Promise<CommitImportResult> {
  const batch = await db.importBatches.get(batchId);
  if (!batch || batch.workspaceId !== workspaceId) throw new Error('Import batch not found');
  if (batch.status === 'committed' || batch.status === 'cancelled') {
    throw new Error(`Import batch is already ${batch.status}`);
  }

  const rows = await db.statementLines.where('importBatchId').equals(batchId).toArray();
  const pending = rows.filter((row) => row.matchStatus === 'unmatched');
  if (pending.length === 0) throw new Error('Import batch has no unmatched rows');

  const source = batch.source === 'fastag' ? 'fastag' : batch.source === 'email' ? 'email' : 'statement';
  let committed = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = nowIso();

  for (const row of pending) {
    const net = row.debitMinor - row.creditMinor;
    if (net === 0) {
      await db.statementLines.update(row.id, { matchStatus: 'ignored', updatedAt: now });
      continue;
    }
    const voucherType: VoucherType = net > 0 ? 'Payment' : 'Receipt';
    const contra = contraLedgerId(row.description, options);
    const amount = Math.abs(net);
    const input: NewVoucher = {
      workspaceId,
      voucherType,
      date: row.date,
      reference: row.reference ?? batch.fileName,
      narration: row.description,
      source,
      sourceRef: `import:${batchId}:${row.id}`,
      status: 'regular',
      currency: row.currency,
      reverseCharge: false,
      groupIds: [],
      tags: ['statement-import'],
      items: [],
      lines:
        net > 0
          ? [
              { ledgerId: contra, amountMinor: amount, currency: row.currency, billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
              { ledgerId: options.accountId, amountMinor: -amount, currency: row.currency, billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
            ]
          : [
              { ledgerId: options.accountId, amountMinor: amount, currency: row.currency, billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
              { ledgerId: contra, amountMinor: -amount, currency: row.currency, billAllocations: [], costCenterAllocations: [], taxAllocations: [] },
            ],
    };
    try {
      const posted = await postVoucher(db, input, { actor: options.actor ?? 'import' });
      await db.statementLines.update(row.id, {
        matchStatus: 'matched',
        matchedVoucherId: posted.voucher.id,
        matchConfidence: 1,
        updatedAt: nowIso(),
      });
      committed += 1;
    } catch (cause) {
      failed += 1;
      if (errors.length < 10) {
        errors.push(`${row.date} ${row.description}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  const status = failed === 0 ? 'committed' : committed === 0 ? 'failed' : 'committed';
  const updated = ImportBatchSchema.parse(
    compact({
      ...batch,
      status,
      committedLines: committed,
      failedLines: failed,
      error: errors.length ? errors.join('\n') : undefined,
      updatedAt: nowIso(),
    }),
  );
  await db.importBatches.put(updated);
  await db.auditEvents.add(
    AuditEventSchema.parse(
      compact({
        id: newId('aud'),
        workspaceId,
        entityType: 'importBatch',
        entityId: batchId,
        action: 'import',
        at: nowIso(),
        actor: options.actor,
        meta: { committed, failed, adapterId: batch.adapterId, fileName: batch.fileName },
      }),
    ),
  );
  return { batch: updated, committed, failed, errors };
}

export async function discardImportBatch(db: LedgerDatabase, batchId: string): Promise<void> {
  await db.transaction('rw', [db.importBatches, db.statementLines], async () => {
    await db.statementLines.where('importBatchId').equals(batchId).delete();
    await db.importBatches.delete(batchId);
  });
}

export async function undoImportBatch(
  db: LedgerDatabase,
  workspaceId: string,
  batchId: string,
): Promise<number> {
  const batch = await db.importBatches.get(batchId);
  if (!batch || batch.workspaceId !== workspaceId) throw new Error('Import batch not found');
  if (batch.status !== 'committed') throw new Error('Only a committed batch can be undone');

  const rows = await db.statementLines.where('importBatchId').equals(batchId).toArray();
  let restored = 0;
  for (const row of rows) {
    if (!row.matchedVoucherId) continue;
    const voucher = await db.vouchers.get(row.matchedVoucherId);
    if (voucher && voucher.status !== 'cancelled') {
      await cancelVoucher(db, voucher.id, { actor: 'import-undo' });
    }
    await deleteVoucher(db, row.matchedVoucherId, { actor: 'import-undo' });
    await db.statementLines.update(row.id, {
      matchStatus: 'unmatched',
      matchedVoucherId: undefined,
      matchConfidence: undefined,
      updatedAt: nowIso(),
    });
    restored += 1;
  }
  await db.importBatches.update(batchId, {
    status: 'cancelled',
    committedLines: 0,
    updatedAt: nowIso(),
  });
  return restored;
}

export async function listImportBatches(db: LedgerDatabase, workspaceId: string): Promise<ImportBatch[]> {
  return db.importBatches.where('workspaceId').equals(workspaceId).reverse().sortBy('createdAt');
}

export async function listStatementLines(
  db: LedgerDatabase,
  batchId: string,
): Promise<StatementLine[]> {
  const rows = await db.statementLines.where('importBatchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.lineNo - b.lineNo);
}

export const stage = stageImport;
export const commit = commitImportBatch;
