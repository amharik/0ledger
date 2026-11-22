import type { LedgerDatabase } from '@/core/db/db';
import { newId, nowIso } from '@/core/ids';
import { compact } from '@/core/util/objects';
import {
  ReconciliationSchema,
  type MoneyEvent,
  type Reconciliation,
  type StatementLine,
  type Voucher,
} from '@/core/model';
import { extractTransactionDetails, extractTransactionId } from './email';
import { verifyStatementBalance, type BalanceAssertion } from './service';
import type { ParsedStatement, ParsedStatementRow } from './types';

export interface RawStatementRowInput {
  date?: string;
  narration?: string;
  description?: string;
  reference?: string;
  debitMinor?: number;
  creditMinor?: number;
  balanceMinor?: number;
  [key: string]: unknown;
}

const DATE_START_PATTERN = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;

/**
 * Handles multi-line narration wrapping across statement tables (common in bank PDFs).
 * If a row does not start with a valid date, it is treated as an overflow string
 * and appended to the preceding transaction's narration.
 */
export function wrapMultiLineNarrations<T extends RawStatementRowInput>(rows: T[]): T[] {
  const result: T[] = [];
  let current: T | undefined;

  for (const row of rows) {
    const rawDate = (row.date ?? '').trim();
    const rawDesc = (row.narration ?? row.description ?? '').trim();

    // If row starts a new transaction (has valid date pattern)
    if (DATE_START_PATTERN.test(rawDate)) {
      if (current) result.push(current);
      current = { ...row, narration: rawDesc, description: rawDesc };
    } else if (current && rawDesc) {
      // Continuation line: append to current transaction's narration
      const prev = current.narration ?? current.description ?? '';
      const updated = `${prev} ${rawDesc}`.trim();
      current.narration = updated;
      current.description = updated;
    }
  }

  if (current) result.push(current);
  return result;
}

export interface StatementEnrichmentResult {
  totalStatementLines: number;
  enrichedMoneyEvents: number;
  reconciledVouchers: number;
  unmatchedLines: number;
  balanceAssertion: BalanceAssertion;
  details: Array<{
    lineNo: number;
    statementLineId: string;
    date: string;
    description: string;
    transactionId?: string;
    matchedType: 'money_event' | 'voucher' | 'none';
    matchedId?: string;
    actionTaken: 'enriched_event' | 'reconciled_voucher' | 'ambiguous_candidate' | 'none';
  }>;
}

export interface EnrichStatementOptions {
  autoReconcile?: boolean;
  toleranceDays?: number;
}

function parseDateToDays(isoDateString: string): number {
  return Math.floor(new Date(isoDateString).getTime() / (86400 * 1000));
}

/**
 * Monthly Statement Enrichment Engine:
 * 1. Matches statement lines to pre-existing real-time MoneyEvents by transaction ID (UPI RRN, UTR, IMPS)
 *    or date/amount sliding window.
 * 2. If MoneyEvent is unposted: enriches narration, links statementLineId, avoids duplicate MoneyEvents.
 * 3. If MoneyEvent is already posted to a Voucher: creates Reconciliation record and links statement line.
 * 4. Runs closed-loop balance invariant verification to guarantee zero missed rows.
 */
export async function enrichLedgerEntriesFromStatement(
  db: LedgerDatabase,
  workspaceId: string,
  input: {
    statement?: ParsedStatement;
    lines?: StatementLine[];
    importBatchId?: string;
  },
  options: EnrichStatementOptions = {},
): Promise<StatementEnrichmentResult> {
  const toleranceDays = options.toleranceDays ?? 3;
  const now = nowIso();

  // Load statement lines to process
  let lines: StatementLine[] = [];
  if (input.lines && input.lines.length > 0) {
    lines = input.lines;
  } else if (input.importBatchId) {
    lines = await db.statementLines.where('importBatchId').equals(input.importBatchId).toArray();
  } else if (input.statement) {
    // If passed a parsed statement directly, convert to StatementLine structure for matching
    lines = input.statement.rows.map((row, idx) => ({
      id: newId('stl'),
      workspaceId,
      importBatchId: newId('imp'),
      lineNo: idx + 1,
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
    }));
  }

  // Load existing MoneyEvents and Vouchers for this workspace
  const existingEvents = await db.moneyEvents.where('workspaceId').equals(workspaceId).toArray();
  const existingVouchers = await db.vouchers.where('workspaceId').equals(workspaceId).toArray();
  const existingVoucherLines = await db.voucherLines.where('workspaceId').equals(workspaceId).toArray();
  const existingReconciliations = await db.reconciliations.where('workspaceId').equals(workspaceId).toArray();

  const voucherLinesByVoucherId = new Map<string, typeof existingVoucherLines>();
  for (const vl of existingVoucherLines) {
    let group = voucherLinesByVoucherId.get(vl.voucherId);
    if (!group) {
      group = [];
      voucherLinesByVoucherId.set(vl.voucherId, group);
    }
    group.push(vl);
  }

  let enrichedMoneyEvents = 0;
  let reconciledVouchers = 0;
  let unmatchedLines = 0;
  const details: StatementEnrichmentResult['details'] = [];

  const matchedEventIds = new Set<string>();
  const matchedVoucherIds = new Set<string>();

  for (const line of lines) {
    const netAmount = line.debitMinor || line.creditMinor;
    const isDebit = line.debitMinor > 0;
    const direction = isDebit ? 'out' : 'in';
    const lineDays = parseDateToDays(line.date);

    // Extract transaction ID from statement row (from reference or narration)
    const txnId =
      line.reference ||
      extractTransactionId(line.description) ||
      (typeof line.raw?.reference === 'string' ? line.raw.reference : undefined);

    // 1. Candidate scoring against MoneyEvents
    const eventCandidates: Array<{
      event: MoneyEvent;
      score: number;
      method: 'reference' | 'amount-date';
      daysDiff: number;
    }> = [];

    for (const evt of existingEvents) {
      if (matchedEventIds.has(evt.id)) continue;

      // Exact transaction ID match
      if (txnId) {
        if (
          (evt.sourceRef && evt.sourceRef.toLowerCase() === txnId.toLowerCase()) ||
          evt.narration.toLowerCase().includes(txnId.toLowerCase())
        ) {
          eventCandidates.push({ event: evt, score: 1.0, method: 'reference', daysDiff: 0 });
          continue;
        }
      }

      // Amount & direction match
      if (evt.amountMinor === netAmount && evt.direction === direction) {
        const evtDays = parseDateToDays(evt.date);
        const daysDiff = Math.abs(evtDays - lineDays);
        if (daysDiff <= toleranceDays) {
          const lineTokens = line.description.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
          const evtTokens = evt.narration.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
          const hasMerchantOverlap = lineTokens.some((t) => evtTokens.includes(t));

          let score = 0.7;
          if (daysDiff === 0 && hasMerchantOverlap) score = 0.85;
          else if (hasMerchantOverlap) score = 0.8;
          else if (daysDiff === 0) score = 0.75;

          eventCandidates.push({ event: evt, score, method: 'amount-date', daysDiff });
        }
      }
    }

    eventCandidates.sort((a, b) => b.score - a.score || a.daysDiff - b.daysDiff);

    let matchedEvent: MoneyEvent | undefined;
    let matchedScore = 0;
    let matchedMethod: 'reference' | 'amount-date' = 'amount-date';

    if (eventCandidates.length > 0) {
      const topScore = eventCandidates[0]!.score;
      const topCandidates = eventCandidates.filter((c) => c.score === topScore);

      // Ambiguity check: multiple non-exact candidates with identical score
      if (topCandidates.length > 1 && topScore < 1.0) {
        await db.statementLines.update(line.id, {
          matchStatus: 'suggested',
          matchConfidence: 0.5,
          updatedAt: now,
        });
        details.push({
          lineNo: line.lineNo,
          statementLineId: line.id,
          date: line.date,
          description: line.description,
          ...(txnId ? { transactionId: txnId } : {}),
          matchedType: 'money_event',
          matchedId: topCandidates[0]!.event.id,
          actionTaken: 'ambiguous_candidate',
        });
        continue;
      }

      matchedEvent = eventCandidates[0]!.event;
      matchedScore = eventCandidates[0]!.score;
      matchedMethod = eventCandidates[0]!.method;
    }

    // Process matched MoneyEvent
    if (matchedEvent) {
      matchedEventIds.add(matchedEvent.id);

      // A. If MoneyEvent is already posted to a Voucher: auto-reconcile with Voucher!
      if (matchedEvent.postedVoucherId) {
        const voucherId = matchedEvent.postedVoucherId;
        matchedVoucherIds.add(voucherId);

        // Check if reconciliation already exists
        const exists = existingReconciliations.some(
          (r) => r.statementLineId === line.id && r.voucherId === voucherId,
        );
        if (!exists) {
          const rec: Reconciliation = ReconciliationSchema.parse(
            compact({
              id: newId('rec'),
              workspaceId,
              statementLineId: line.id,
              voucherId,
              amountMinor: netAmount,
              method: matchedMethod,
              status: 'confirmed',
              confidence: matchedScore,
              note: `Auto-reconciled via statement transaction match (${txnId ?? line.date})`,
              createdAt: now,
              updatedAt: now,
            }),
          );
          await db.reconciliations.add(rec);
        }

        // Update statement line
        await db.statementLines.update(line.id, {
          matchStatus: 'matched',
          matchedVoucherId: voucherId,
          matchConfidence: matchedScore,
          updatedAt: now,
        });

        reconciledVouchers += 1;
        details.push({
          lineNo: line.lineNo,
          statementLineId: line.id,
          date: line.date,
          description: line.description,
          ...(txnId ? { transactionId: txnId } : {}),
          matchedType: 'voucher',
          matchedId: voucherId,
          actionTaken: 'reconciled_voucher',
        });
        continue;
      }

      // B. If MoneyEvent is unposted: enrich narration, valueDate, reference, and link
      const enrichedNarration =
        line.description.length > matchedEvent.narration.length
          ? line.description
          : `${matchedEvent.narration} (${line.description})`;

      await db.moneyEvents.update(matchedEvent.id, {
        statementLineId: line.id,
        narration: enrichedNarration.slice(0, 1024),
        ...(txnId && !matchedEvent.sourceRef ? { sourceRef: txnId } : {}),
        confidence: Math.max(matchedEvent.confidence, matchedScore),
        status: matchedEvent.status === 'captured' ? 'suggested' : matchedEvent.status,
        updatedAt: now,
      });

      await db.statementLines.update(line.id, {
        matchStatus: 'matched',
        matchConfidence: matchedScore,
        updatedAt: now,
      });

      enrichedMoneyEvents += 1;
      details.push({
        lineNo: line.lineNo,
        statementLineId: line.id,
        date: line.date,
        description: line.description,
        ...(txnId ? { transactionId: txnId } : {}),
        matchedType: 'money_event',
        matchedId: matchedEvent.id,
        actionTaken: 'enriched_event',
      });
      continue;
    }

    // 3. If no MoneyEvent matched, check posted Vouchers directly
    let matchedVoucher: Voucher | undefined;
    const voucherCandidates: Array<{
      voucher: Voucher;
      score: number;
      method: 'reference' | 'amount-date';
      daysDiff: number;
    }> = [];

    for (const v of existingVouchers) {
      if (matchedVoucherIds.has(v.id)) continue;

      if (txnId) {
        if (
          (v.reference && v.reference.toLowerCase().includes(txnId.toLowerCase())) ||
          (v.narration && v.narration.toLowerCase().includes(txnId.toLowerCase()))
        ) {
          voucherCandidates.push({ voucher: v, score: 1.0, method: 'reference', daysDiff: 0 });
          continue;
        }
      }

      const vDays = parseDateToDays(v.date);
      const daysDiff = Math.abs(vDays - lineDays);
      if (daysDiff <= toleranceDays) {
        const lines = voucherLinesByVoucherId.get(v.id) ?? [];
        const hasMatchingLine = lines.some((l) => Math.abs(l.amountMinor) === netAmount);
        if (hasMatchingLine) {
          voucherCandidates.push({
            voucher: v,
            score: daysDiff === 0 ? 0.8 : 0.7,
            method: 'amount-date',
            daysDiff,
          });
        }
      }
    }

    voucherCandidates.sort((a, b) => b.score - a.score || a.daysDiff - b.daysDiff);

    if (voucherCandidates.length > 0) {
      const topVScore = voucherCandidates[0]!.score;
      const topVCandidates = voucherCandidates.filter((c) => c.score === topVScore);

      if (topVCandidates.length > 1 && topVScore < 1.0) {
        await db.statementLines.update(line.id, {
          matchStatus: 'suggested',
          matchConfidence: 0.5,
          updatedAt: now,
        });
        details.push({
          lineNo: line.lineNo,
          statementLineId: line.id,
          date: line.date,
          description: line.description,
          ...(txnId ? { transactionId: txnId } : {}),
          matchedType: 'voucher',
          matchedId: topVCandidates[0]!.voucher.id,
          actionTaken: 'ambiguous_candidate',
        });
        continue;
      }

      matchedVoucher = voucherCandidates[0]!.voucher;
      const vScore = voucherCandidates[0]!.score;
      const vMethod = voucherCandidates[0]!.method;

      matchedVoucherIds.add(matchedVoucher.id);

      const exists = existingReconciliations.some(
        (r) => r.statementLineId === line.id && r.voucherId === matchedVoucher!.id,
      );
      if (!exists) {
        const rec: Reconciliation = ReconciliationSchema.parse(
          compact({
            id: newId('rec'),
            workspaceId,
            statementLineId: line.id,
            voucherId: matchedVoucher.id,
            amountMinor: netAmount,
            method: vMethod,
            status: 'confirmed',
            confidence: vScore,
            note: `Auto-reconciled via direct voucher search (${txnId ?? line.date})`,
            createdAt: now,
            updatedAt: now,
          }),
        );
        await db.reconciliations.add(rec);
      }

      await db.statementLines.update(line.id, {
        matchStatus: 'matched',
        matchedVoucherId: matchedVoucher.id,
        matchConfidence: vScore,
        updatedAt: now,
      });

      reconciledVouchers += 1;
      details.push({
        lineNo: line.lineNo,
        statementLineId: line.id,
        date: line.date,
        description: line.description,
        ...(txnId ? { transactionId: txnId } : {}),
        matchedType: 'voucher',
        matchedId: matchedVoucher.id,
        actionTaken: 'reconciled_voucher',
      });
      continue;
    }

    // 4. No match found
    unmatchedLines += 1;
    details.push({
      lineNo: line.lineNo,
      statementLineId: line.id,
      date: line.date,
      description: line.description,
      ...(txnId ? { transactionId: txnId } : {}),
      matchedType: 'none',
      actionTaken: 'none',
    });
  }

  // 5. Run closed-loop balance verification invariant
  const balanceAssertion = verifyStatementBalance(lines);

  return {
    totalStatementLines: lines.length,
    enrichedMoneyEvents,
    reconciledVouchers,
    unmatchedLines,
    balanceAssertion,
    details,
  };
}
