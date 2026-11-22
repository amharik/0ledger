import { monthKey, newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import { compact } from '../util/objects';
import {
  CloseItemSchema,
  type ClassificationSuggestion,
  type CloseItem,
  type MoneyEvent,
  type ReadinessStatus,
} from '../model';
import type { LedgerDatabase } from '../db/db';
import { loadWorkbookData } from '../template/data';
import { checkTallyReadiness } from '../ledger/validation';

export interface ClosePeriodBounds {
  period: string;
  from: string;
  to: string;
}

export interface CloseTaxEntry {
  taxType: string;
  ledgerName: string;
  amountMinor: number;
  taxableValueMinor: number;
}

export interface CloseReadiness {
  score: number;
  status: ReadinessStatus;
  blockers: string[];
  components: {
    reconciled: number;
    missingDocuments: number;
    taxCaptured: number;
    tallyReady: number;
  };
}

export interface CloseCashSummary {
  bankLedgerCount: number;
  totalLines: number;
  reconciledLines: number;
  unreconciledLines: number;
  statementNetMinor: number;
  ledgerNetMinor: number;
  differenceMinor: number;
}

export interface CloseCockpitData {
  period: string;
  cash: CloseCashSummary;
  tax: { entries: CloseTaxEntry[]; totalMinor: number };
  items: CloseItem[];
  openItems: CloseItem[];
  readiness: CloseReadiness;
}

export function periodBounds(period: string): ClosePeriodBounds {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Period must be YYYY-MM');
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (month < 1 || month > 12) throw new Error('Period month must be 01-12');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    period,
    from: `${period}-01`,
    to: `${period}-${String(lastDay).padStart(2, '0')}`,
  };
}

function inPeriod(date: string, period: string): boolean {
  return monthKey(date) === period;
}

function fingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

interface CloseItemDraft {
  dedupeKey: string;
  type: CloseItem['type'];
  status?: CloseItem['status'];
  owner?: CloseItem['owner'];
  title: string;
  evidence?: string | undefined;
  amountMinor?: number | undefined;
  sourceEntityId?: string | undefined;
}

export async function refreshCloseItems(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
): Promise<CloseItem[]> {
  periodBounds(period);
  const data = await loadWorkbookData(db, workspaceId);
  const now = nowIso();
  const suggestions = await db.classificationSuggestions
    .where('workspaceId')
    .equals(workspaceId)
    .toArray();
  const suggestionByEvent = new Map<string, ClassificationSuggestion>();
  for (const suggestion of suggestions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    suggestionByEvent.set(suggestion.moneyEventId, suggestion);
  }
  const events = await db.moneyEvents.where('workspaceId').equals(workspaceId).toArray();
  const periodEvents = events.filter((event) => inPeriod(event.date, period));
  const lines = data.statementLines.filter((line) => inPeriod(line.date, period));
  const reconciliations = data.reconciliations.filter(
    (row) => row.workspaceId === workspaceId && row.status === 'confirmed',
  );
  const reconciledLineIds = new Set(reconciliations.map((row) => row.statementLineId));
  const periodVouchers = data.vouchers.filter(
    (voucher) => voucher.status === 'regular' && inPeriod(voucher.date, period),
  );
  const voucherIds = new Set(periodVouchers.map((voucher) => voucher.id));
  const taxByVoucher = new Map<string, number>();
  for (const tax of data.taxAllocations) {
    if (!voucherIds.has(tax.voucherId)) continue;
    taxByVoucher.set(tax.voucherId, (taxByVoucher.get(tax.voucherId) ?? 0) + 1);
  }

  const drafts: CloseItemDraft[] = [];
  for (const line of lines) {
    if (reconciledLineIds.has(line.id)) continue;
    drafts.push({
      dedupeKey: `unreconciled:${line.id}`,
      type: 'unreconciled_bank',
      owner: 'owner',
      title: `Unreconciled bank line: ${line.description.slice(0, 120)}`,
      evidence: `${line.date}${line.reference ? ` • ${line.reference}` : ''}`,
      amountMinor: line.creditMinor - line.debitMinor,
      sourceEntityId: line.id,
    });
  }

  const duplicateGroups = new Map<string, MoneyEvent[]>();
  for (const event of periodEvents) {
    const key = `${event.date}|${event.amountMinor}|${event.direction}|${fingerprint(event.narration)}`;
    const list = duplicateGroups.get(key) ?? [];
    list.push(event);
    duplicateGroups.set(key, list);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    for (const event of group.slice(1)) {
      drafts.push({
        dedupeKey: `duplicate:${event.id}`,
        type: 'duplicate',
        owner: 'owner',
        title: `Possible duplicate: ${event.narration.slice(0, 120)}`,
        evidence: `${event.date} • ₹${(event.amountMinor / 100).toFixed(2)}`,
        amountMinor: event.amountMinor,
        sourceEntityId: event.id,
      });
    }
  }

  for (const event of periodEvents) {
    if (['ignored', 'duplicate'].includes(event.status)) continue;
    const suggestion = suggestionByEvent.get(event.id);
    if (!['posted', 'ignored', 'duplicate'].includes(event.status) && (suggestion?.confidence ?? event.confidence) < 0.7) {
      drafts.push({
        dedupeKey: `low-confidence:${event.id}`,
        type: 'low_confidence',
        owner: 'owner',
        title: `Review category: ${event.narration.slice(0, 120)}`,
        evidence: suggestion?.reasons.join('; ') || 'No rule matched',
        amountMinor: event.amountMinor,
        sourceEntityId: event.id,
      });
    }
    if (event.direction === 'out' && !event.attachmentId) {
      drafts.push({
        dedupeKey: `missing-document:${event.id}`,
        type: 'missing_document',
        owner: 'owner',
        title: `Add bill or receipt: ${event.narration.slice(0, 120)}`,
        evidence: `${event.date} • ₹${(event.amountMinor / 100).toFixed(2)}`,
        amountMinor: event.amountMinor,
        sourceEntityId: event.id,
      });
    }
    if (suggestion?.taxHint) {
      const postedHasTax = event.postedVoucherId ? (taxByVoucher.get(event.postedVoucherId) ?? 0) > 0 : false;
      if (!postedHasTax) {
        drafts.push({
          dedupeKey: `tax:${event.id}`,
          type: 'tax_field',
          owner: 'ca',
          title: `Check ${suggestion.taxHint} treatment: ${event.narration.slice(0, 100)}`,
          evidence: suggestion.reasons.join('; '),
          amountMinor: event.amountMinor,
          sourceEntityId: event.id,
        });
      }
    }
  }

  const linesByVoucher = new Map<string, number>();
  for (const line of data.voucherLines) {
    if (!voucherIds.has(line.voucherId)) continue;
    linesByVoucher.set(line.voucherId, (linesByVoucher.get(line.voucherId) ?? 0) + line.amountMinor);
  }
  for (const voucher of periodVouchers) {
    const net = linesByVoucher.get(voucher.id) ?? 0;
    if (net !== 0) {
      drafts.push({
        dedupeKey: `unbalanced:${voucher.id}`,
        type: 'voucher_error',
        owner: 'owner',
        title: `Voucher ${voucher.number} does not balance`,
        evidence: `Net difference ₹${(Math.abs(net) / 100).toFixed(2)}`,
        sourceEntityId: voucher.id,
      });
    }
  }

  const tally = checkTallyReadiness({
    company: data.company,
    ledgers: data.ledgers,
    parties: data.parties,
    stockItems: data.stockItems,
    vouchers: periodVouchers,
    lines: data.voucherLines.filter((line) => voucherIds.has(line.voucherId)),
    itemLines: data.itemLines.filter((line) => voucherIds.has(line.voucherId)),
    billAllocations: data.billAllocations.filter((row) => voucherIds.has(row.voucherId)),
    taxAllocations: data.taxAllocations.filter((row) => voucherIds.has(row.voucherId)),
    numberingSchemes: data.numberingSchemes,
  });
  for (const issue of tally.issues.filter((issue) => issue.severity === 'error')) {
    drafts.push({
      dedupeKey: `tally:${issue.code}:${issue.entityId ?? 'workspace'}`,
      type: 'voucher_error',
      owner: 'ca',
      title: issue.message.slice(0, 240),
      evidence: issue.hint ?? 'Tally readiness check',
      sourceEntityId: issue.entityId,
    });
  }

  const existing = await db.closeItems.where('[workspaceId+period]').equals([workspaceId, period]).toArray();
  const existingByKey = new Map(existing.map((item) => [item.dedupeKey, item]));
  const activeKeys = new Set(drafts.map((draft) => draft.dedupeKey));
  const saved: CloseItem[] = [];

  for (const draft of drafts) {
    const current = existingByKey.get(draft.dedupeKey);
    const parsed = CloseItemSchema.parse(
      compact({
        id: current?.id ?? newId('cli'),
        workspaceId,
        period,
        dedupeKey: draft.dedupeKey,
        type: draft.type,
        status: current && current.status !== 'resolved' ? current.status : (draft.status ?? 'open'),
        owner: current?.owner ?? draft.owner ?? 'owner',
        title: draft.title,
        evidence: draft.evidence,
        note: current?.note,
        amountMinor: draft.amountMinor,
        sourceEntityId: draft.sourceEntityId,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      }),
    );
    if (current) await db.closeItems.put(parsed);
    else await db.closeItems.add(parsed);
    saved.push(parsed);
  }

  for (const current of existing) {
    if (activeKeys.has(current.dedupeKey)) continue;
    if (current.status !== 'open' && current.status !== 'asked_ca') continue;
    const resolved = { ...current, status: 'resolved' as const, updatedAt: now };
    await db.closeItems.put(resolved);
    saved.push(resolved);
  }

  if (drafts.length > 0 || existing.some((item) => !activeKeys.has(item.dedupeKey))) {
    await markDriveDirty(db, workspaceId);
  }
  return saved.sort((a, b) => a.status.localeCompare(b.status) || a.type.localeCompare(b.type));
}

function ratioResolved(items: CloseItem[]): number {
  if (items.length === 0) return 1;
  const resolved = items.filter((item) => item.status === 'resolved' || item.status === 'waived').length;
  return resolved / items.length;
}

export async function buildCloseCockpit(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
): Promise<CloseCockpitData> {
  const bounds = periodBounds(period);
  const items = await refreshCloseItems(db, workspaceId, period);
  const data = await loadWorkbookData(db, workspaceId);
  const lines = data.statementLines.filter((line) => inPeriod(line.date, period));
  const reconciledIds = new Set(
    data.reconciliations
      .filter((row) => row.status === 'confirmed')
      .map((row) => row.statementLineId),
  );
  const reconciledLines = lines.filter((line) => reconciledIds.has(line.id)).length;
  const periodVouchers = data.vouchers.filter(
    (voucher) => voucher.status === 'regular' && inPeriod(voucher.date, period),
  );
  const voucherIds = new Set(periodVouchers.map((voucher) => voucher.id));
  const bankLedgerIds = new Set(data.ledgers.filter((ledger) => ledger.isBank).map((ledger) => ledger.id));
  const ledgerNetMinor = data.voucherLines
    .filter((line) => voucherIds.has(line.voucherId) && bankLedgerIds.has(line.ledgerId))
    .reduce((sum, line) => sum + line.amountMinor, 0);
  const statementNetMinor = lines.reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);

  const ledgerById = new Map(data.ledgers.map((ledger) => [ledger.id, ledger]));
  const taxMap = new Map<string, CloseTaxEntry>();
  for (const tax of data.taxAllocations) {
    if (!voucherIds.has(tax.voucherId)) continue;
    const ledger = ledgerById.get(tax.ledgerId ?? '');
    const key = `${tax.taxType}|${tax.ledgerId ?? 'unassigned'}`;
    const entry = taxMap.get(key) ?? {
      taxType: tax.taxType,
      ledgerName: ledger?.name ?? 'Unknown ledger',
      amountMinor: 0,
      taxableValueMinor: 0,
    };
    entry.amountMinor += tax.amountMinor;
    entry.taxableValueMinor += tax.taxableValueMinor ?? 0;
    taxMap.set(key, entry);
  }
  const taxEntries = [...taxMap.values()].sort((a, b) => b.amountMinor - a.amountMinor);

  const voucherLines = data.voucherLines.filter((line) => voucherIds.has(line.voucherId));
  const tally = checkTallyReadiness({
    company: data.company,
    ledgers: data.ledgers,
    parties: data.parties,
    stockItems: data.stockItems,
    vouchers: periodVouchers,
    lines: voucherLines,
    itemLines: data.itemLines.filter((line) => voucherIds.has(line.voucherId)),
    billAllocations: data.billAllocations.filter((row) => voucherIds.has(row.voucherId)),
    taxAllocations: data.taxAllocations.filter((row) => voucherIds.has(row.voucherId)),
    numberingSchemes: data.numberingSchemes,
  });
  const tallyErrors = tally.issues.filter((issue) => issue.severity === 'error');
  const missingItems = items.filter((item) => item.type === 'missing_document');
  const taxItems = items.filter((item) => item.type === 'tax_field');
  const unbalanced = items.filter((item) => item.dedupeKey.startsWith('unbalanced:'));
  const components = {
    reconciled: lines.length === 0 ? 1 : reconciledLines / lines.length,
    missingDocuments: ratioResolved(missingItems),
    taxCaptured: ratioResolved(taxItems),
    tallyReady: tallyErrors.length === 0 ? 1 : 0,
  };
  let score = Math.round(
    components.reconciled * 40 +
      components.missingDocuments * 20 +
      components.taxCaptured * 20 +
      components.tallyReady * 20,
  );
  const blockers = [
    ...tallyErrors.slice(0, 10).map((issue) => issue.message),
    ...unbalanced.map((item) => item.title),
  ];
  if (blockers.length > 0) score = Math.min(score, 60);
  const status: ReadinessStatus =
    blockers.length > 0 ? 'not_ready' : score >= 90 ? 'ready' : score >= 60 ? 'needs_review' : 'not_ready';

  return {
    period,
    cash: {
      bankLedgerCount: bankLedgerIds.size,
      totalLines: lines.length,
      reconciledLines,
      unreconciledLines: lines.length - reconciledLines,
      statementNetMinor,
      ledgerNetMinor,
      differenceMinor: ledgerNetMinor - statementNetMinor,
    },
    tax: {
      entries: taxEntries,
      totalMinor: taxEntries.reduce((sum, entry) => sum + entry.amountMinor, 0),
    },
    items,
    openItems: items.filter((item) => item.status === 'open' || item.status === 'asked_ca'),
    readiness: { score, status, blockers, components },
  };
}

export async function updateCloseItem(
  db: LedgerDatabase,
  workspaceId: string,
  itemId: string,
  patch: { status?: CloseItem['status']; note?: string; owner?: CloseItem['owner'] },
): Promise<CloseItem> {
  const item = await db.closeItems.get(itemId);
  if (!item || item.workspaceId !== workspaceId) throw new Error('Close item not found');
  const next = CloseItemSchema.parse(
    compact({
      ...item,
      status: patch.status ?? item.status,
      note: patch.note ?? item.note,
      owner: patch.owner ?? item.owner,
      updatedAt: nowIso(),
    }),
  );
  await db.closeItems.put(next);
  await markDriveDirty(db, workspaceId);
  return next;
}

export async function askCaForItem(
  db: LedgerDatabase,
  workspaceId: string,
  itemId: string,
  note?: string,
): Promise<CloseItem> {
  return updateCloseItem(db, workspaceId, itemId, {
    status: 'asked_ca',
    note: note ?? 'Question queued for CA pack',
  });
}

export { periodBounds as closePeriodBounds };
