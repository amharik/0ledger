import { newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import { compact } from '../util/objects';
import {
  AuditEventSchema,
  ReconciliationSchema,
  type Reconciliation,
  type ReconciliationMethod,
  type StatementLine,
  type Voucher,
} from '../model';
import type { LedgerDatabase } from '../db/db';
import { billAging, type BillAgingRow } from './reports';

export interface MatchCandidate {
  voucher: Voucher;
  bankAmountMinor: number;
  confidence: number;
  method: ReconciliationMethod;
  reasons: string[];
}

export interface StatementMatchQueueItem {
  line: StatementLine;
  candidates: MatchCandidate[];
}

export interface SuggestMatchOptions {
  accountId?: string;
  windowDays?: number;
  minConfidence?: number;
  limit?: number;
}

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function dateDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
  const right = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function voucherReferenceMatch(line: StatementLine, voucher: Voucher): boolean {
  const reference = normalize(line.reference);
  if (reference.length < 4) return false;
  return [voucher.reference, voucher.invoiceNumber, voucher.sourceRef, voucher.number]
    .map(normalize)
    .some((value) => value.length >= 4 && (value.includes(reference) || reference.includes(value)));
}

function scoreCandidate(
  line: StatementLine,
  voucher: Voucher,
  windowDays: number,
): MatchCandidate | undefined {
  const statementBankAmount = line.creditMinor - line.debitMinor;
  if (statementBankAmount === 0) return undefined;
  const diff = dateDiff(line.date, voucher.date);
  if (diff > windowDays) return undefined;

  const referenceMatch = voucherReferenceMatch(line, voucher);
  const overlap = tokenOverlap(line.description, `${voucher.narration ?? ''} ${voucher.reference ?? ''}`);
  let confidence = 0.45;
  confidence += Math.max(0, (windowDays + 1 - diff) / (windowDays + 1)) * 0.3;
  if (referenceMatch) confidence += 0.2;
  confidence += Math.min(overlap, 0.15);
  confidence = Math.min(Math.round(confidence * 100) / 100, 1);

  const reasons = ['amount matches'];
  if (referenceMatch) reasons.push('reference matches');
  if (diff === 0) reasons.push('same date');
  if (overlap > 0) reasons.push('description resembles narration');

  return {
    voucher,
    bankAmountMinor: statementBankAmount,
    confidence,
    method: referenceMatch ? 'reference' : diff <= 1 ? 'amount-date' : 'fuzzy',
    reasons,
  };
}

async function bankAmountsByVoucher(
  db: LedgerDatabase,
  workspaceId: string,
  accountId: string,
): Promise<Map<string, number>> {
  const lines = await db.voucherLines
    .where('[workspaceId+ledgerId]')
    .equals([workspaceId, accountId])
    .toArray();
  const amounts = new Map<string, number>();
  for (const line of lines) {
    amounts.set(line.voucherId, (amounts.get(line.voucherId) ?? 0) + line.amountMinor);
  }
  return amounts;
}

export async function suggestMatches(
  db: LedgerDatabase,
  workspaceId: string,
  options: SuggestMatchOptions = {},
): Promise<StatementMatchQueueItem[]> {
  const windowDays = options.windowDays ?? 5;
  const minConfidence = options.minConfidence ?? 0.5;
  const limit = options.limit ?? 5;
  const [unmatched, suggested] = await Promise.all([
    db.statementLines.where('[workspaceId+matchStatus]').equals([workspaceId, 'unmatched']).toArray(),
    db.statementLines.where('[workspaceId+matchStatus]').equals([workspaceId, 'suggested']).toArray(),
  ]);
  const pending = [...unmatched, ...suggested].sort((a, b) => a.date.localeCompare(b.date) || a.lineNo - b.lineNo);
  if (pending.length === 0) return [];

  const vouchers = (await db.vouchers.where('workspaceId').equals(workspaceId).toArray()).filter(
    (voucher) => voucher.status === 'regular',
  );
  const now = nowIso();
  const queue: StatementMatchQueueItem[] = [];
  const cache = new Map<string, Map<string, number>>();

  for (const line of pending) {
    const accountId = line.accountId ?? options.accountId;
    if (!accountId) {
      queue.push({ line, candidates: [] });
      continue;
    }
    let amounts = cache.get(accountId);
    if (!amounts) {
      amounts = await bankAmountsByVoucher(db, workspaceId, accountId);
      cache.set(accountId, amounts);
    }
    const statementBankAmount = line.creditMinor - line.debitMinor;
    const candidates: MatchCandidate[] = [];
    for (const voucher of vouchers) {
      const bankAmount = amounts.get(voucher.id);
      if (bankAmount === undefined || bankAmount !== statementBankAmount) continue;
      const candidate = scoreCandidate(line, voucher, windowDays);
      if (candidate && candidate.confidence >= minConfidence) candidates.push(candidate);
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const top = candidates.slice(0, limit);
    const topConfidence = top[0]?.confidence;
    const matchStatus = top.length > 0 ? 'suggested' : 'unmatched';
    queue.push({
      line: { ...line, matchStatus, ...(topConfidence === undefined ? {} : { matchConfidence: topConfidence }), updatedAt: now },
      candidates: top,
    });
    await db.statementLines.update(line.id, {
      matchStatus,
      matchConfidence: topConfidence,
      updatedAt: now,
    });
  }

  return queue;
}

export interface SplitCandidate {
  voucher: Voucher;
  bankAmountMinor: number;
}

export async function listSplitCandidates(
  db: LedgerDatabase,
  workspaceId: string,
  statementLineId: string,
  accountId: string,
  windowDays = 21,
): Promise<SplitCandidate[]> {
  const line = await db.statementLines.get(statementLineId);
  if (!line || line.workspaceId !== workspaceId) throw new Error('Statement line not found');
  const statementBankAmount = line.creditMinor - line.debitMinor;
  if (statementBankAmount === 0) return [];
  const amounts = await bankAmountsByVoucher(db, workspaceId, accountId);
  const vouchers = (await db.vouchers.where('workspaceId').equals(workspaceId).toArray()).filter(
    (voucher) => voucher.status === 'regular' && dateDiff(line.date, voucher.date) <= windowDays,
  );
  const candidates: SplitCandidate[] = [];
  for (const voucher of vouchers) {
    const amount = amounts.get(voucher.id);
    if (amount === undefined || amount === 0) continue;
    if (Math.sign(amount) !== Math.sign(statementBankAmount)) continue;
    if (Math.abs(amount) > Math.abs(statementBankAmount)) continue;
    candidates.push({ voucher, bankAmountMinor: amount });
  }
  return candidates.sort((a, b) => a.voucher.date.localeCompare(b.voucher.date));
}

export interface MatchPart {
  voucherId: string;
  amountMinor: number;
  method?: ReconciliationMethod;
  confidence?: number;
}

export async function confirmStatementMatch(
  db: LedgerDatabase,
  workspaceId: string,
  statementLineId: string,
  parts: MatchPart[],
  options: { actor?: string; note?: string } = {},
): Promise<Reconciliation[]> {
  const line = await db.statementLines.get(statementLineId);
  if (!line || line.workspaceId !== workspaceId) throw new Error('Statement line not found');
  if (line.matchStatus === 'ignored') throw new Error('Statement line is ignored');
  if (line.matchStatus === 'matched') throw new Error('Statement line is already matched');
  if (parts.length === 0) throw new Error('At least one voucher is required');

  const target = line.creditMinor - line.debitMinor;
  const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
  if (total !== target) {
    throw new Error(`Allocated amount ${total} does not equal statement amount ${target}`);
  }

  const now = nowIso();
  const records: Reconciliation[] = [];
  for (const part of parts) {
    const voucher = await db.vouchers.get(part.voucherId);
    if (!voucher || voucher.workspaceId !== workspaceId) throw new Error(`Voucher not found: ${part.voucherId}`);
    if (voucher.status !== 'regular') throw new Error(`Voucher ${voucher.number} is not regular`);
    records.push(
      ReconciliationSchema.parse(
        compact({
          id: newId('rec'),
          workspaceId,
          statementLineId,
          voucherId: part.voucherId,
          amountMinor: part.amountMinor,
          method: part.method ?? 'manual',
          status: 'confirmed',
          confidence: part.confidence ?? 1,
          note: options.note,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  }

  await db.transaction('rw', [db.reconciliations, db.statementLines, db.auditEvents], async () => {
    await db.reconciliations.bulkAdd(records);
    await db.statementLines.update(statementLineId, {
      matchStatus: 'matched',
      matchedVoucherId: parts.length === 1 ? parts[0]?.voucherId : undefined,
      matchConfidence: Math.min(...records.map((record) => record.confidence)),
      updatedAt: now,
    });
    await db.auditEvents.add(
      AuditEventSchema.parse(
        compact({
          id: newId('aud'),
          workspaceId,
          entityType: 'statementLine',
          entityId: statementLineId,
          action: 'update',
          at: now,
          actor: options.actor,
          meta: { action: 'match', voucherIds: parts.map((part) => part.voucherId) },
        }),
      ),
    );
  });
  await markDriveDirty(db, workspaceId);
  return records;
}

export async function unmatchStatementLine(
  db: LedgerDatabase,
  workspaceId: string,
  statementLineId: string,
  options: { actor?: string } = {},
): Promise<void> {
  const line = await db.statementLines.get(statementLineId);
  if (!line || line.workspaceId !== workspaceId) throw new Error('Statement line not found');
  const now = nowIso();
  const records = await db.reconciliations
    .where('[statementLineId+status]')
    .equals([statementLineId, 'confirmed'])
    .toArray();
  await db.transaction('rw', [db.reconciliations, db.statementLines, db.auditEvents], async () => {
    for (const record of records) {
      await db.reconciliations.update(record.id, { status: 'rejected', updatedAt: now });
    }
    await db.statementLines.update(statementLineId, {
      matchStatus: 'unmatched',
      matchedVoucherId: undefined,
      matchConfidence: undefined,
      updatedAt: now,
    });
    await db.auditEvents.add(
      AuditEventSchema.parse(
        compact({
          id: newId('aud'),
          workspaceId,
          entityType: 'statementLine',
          entityId: statementLineId,
          action: 'update',
          at: now,
          actor: options.actor,
          meta: { action: 'unmatch', vouchers: records.map((record) => record.voucherId) },
        }),
      ),
    );
  });
}

export async function ignoreStatementLine(
  db: LedgerDatabase,
  workspaceId: string,
  statementLineId: string,
  options: { actor?: string } = {},
): Promise<void> {
  const line = await db.statementLines.get(statementLineId);
  if (!line || line.workspaceId !== workspaceId) throw new Error('Statement line not found');
  await db.statementLines.update(statementLineId, {
    matchStatus: 'ignored',
    matchedVoucherId: undefined,
    matchConfidence: undefined,
    updatedAt: nowIso(),
  });
  await db.auditEvents.add(
    AuditEventSchema.parse(
      compact({
        id: newId('aud'),
        workspaceId,
        entityType: 'statementLine',
        entityId: statementLineId,
        action: 'update',
        at: nowIso(),
        actor: options.actor,
        meta: { action: 'ignore' },
      }),
    ),
  );
  await markDriveDirty(db, workspaceId);
}

export async function listStatementMatchQueue(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<StatementMatchQueueItem[]> {
  const [unmatched, suggested] = await Promise.all([
    db.statementLines.where('[workspaceId+matchStatus]').equals([workspaceId, 'unmatched']).toArray(),
    db.statementLines.where('[workspaceId+matchStatus]').equals([workspaceId, 'suggested']).toArray(),
  ]);
  return [...unmatched, ...suggested]
    .sort((a, b) => a.date.localeCompare(b.date) || a.lineNo - b.lineNo)
    .map((line) => ({ line, candidates: [] }));
}

export async function statementBalanceReport(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<Array<{ batchId: string; checked: number; mismatches: number }>> {
  const rows = await db.statementLines.where('workspaceId').equals(workspaceId).toArray();
  const byBatch = new Map<string, StatementLine[]>();
  for (const row of rows) {
    const list = byBatch.get(row.importBatchId) ?? [];
    list.push(row);
    byBatch.set(row.importBatchId, list);
  }
  const result: Array<{ batchId: string; checked: number; mismatches: number }> = [];
  for (const [batchId, lines] of byBatch) {
    const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
    let previous: number | undefined;
    let checked = 0;
    let mismatches = 0;
    for (const line of ordered) {
      if (line.balanceMinor === undefined) continue;
      if (previous === undefined) {
        previous = line.balanceMinor;
        continue;
      }
      checked += 1;
      if (previous + line.creditMinor - line.debitMinor !== line.balanceMinor) mismatches += 1;
      previous = line.balanceMinor;
    }
    result.push({ batchId, checked, mismatches });
  }
  return result.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

export interface PartyReconciliation {
  ledgerId: string;
  asOf: string;
  bills: BillAgingRow[];
  outstandingMinor: number;
}

export async function reconcileParty(
  db: LedgerDatabase,
  workspaceId: string,
  ledgerId: string,
  asOf = new Date().toISOString().slice(0, 10),
): Promise<PartyReconciliation> {
  const bills = (await billAging(db, workspaceId, asOf)).filter((row) => row.ledgerId === ledgerId);
  return {
    ledgerId,
    asOf,
    bills,
    outstandingMinor: bills.reduce((sum, row) => sum + row.outstandingMinor, 0),
  };
}
