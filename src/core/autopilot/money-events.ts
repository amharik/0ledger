import { monthKey, newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import { compact } from '../util/objects';
import { sha256Hex } from '../util/hash';
import {
  AuditEventSchema,
  ClassificationSuggestionSchema,
  MoneyEventSchema,
  type ClassificationSuggestion,
  type ImportBatch,
  type MoneyEvent,
  type NewVoucher,
  type StatementLine,
} from '../model';
import type { LedgerDatabase } from '../db/db';
import { postVoucher } from '../ledger/post-voucher';
import { reverseVoucher } from '../ledger/voucher-service';
import {
  classifyEvent,
  ensureSeedClassificationRules,
  listClassificationRules,
} from './rules';
import { getAutoPostSettings, isCategoryEnabled } from './settings';
import { classifyMoneyEventRisk, type MoneyEventRisk } from './risk';

export interface CaptureEventsResult {
  created: MoneyEvent[];
  duplicates: number;
}

export interface MoneyEventQueueItem {
  event: MoneyEvent;
  suggestion?: ClassificationSuggestion;
  risk: MoneyEventRisk;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function moneyEventContentHash(input: {
  sourceRef?: string | undefined;
  date: string;
  amountMinor: number;
  direction: string;
  narration: string;
}): Promise<string> {
  return sha256Hex(
    [
      input.sourceRef?.trim().toLowerCase() ?? '',
      input.date,
      input.amountMinor,
      input.direction,
      normalize(input.narration),
    ].join('|'),
  );
}

async function latestSuggestion(
  db: LedgerDatabase,
  moneyEventId: string,
): Promise<ClassificationSuggestion | undefined> {
  const rows = await db.classificationSuggestions.where('moneyEventId').equals(moneyEventId).toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function classifyAndSave(db: LedgerDatabase, event: MoneyEvent): Promise<MoneyEvent> {
  const rules = await listClassificationRules(db, event.workspaceId);
  const classification = classifyEvent(event, rules);
  const now = nowIso();
  const existing = await db.classificationSuggestions.where('moneyEventId').equals(event.id).toArray();
  const status = classification.ledgerId ? 'suggested' : 'needs_review';

  const suggestion = classification.ledgerId
    ? ClassificationSuggestionSchema.parse(
        compact({
          id: existing[0]?.id ?? newId('sug'),
          workspaceId: event.workspaceId,
          moneyEventId: event.id,
          ledgerId: classification.ledgerId,
          partyId: classification.partyId,
          taxHint: classification.taxHint,
          confidence: classification.confidence,
          reasons: classification.reasons,
          ruleId: classification.ruleId,
          createdAt: existing[0]?.createdAt ?? now,
          updatedAt: now,
        }),
      )
    : undefined;

  await db.transaction(
    'rw',
    [db.moneyEvents, db.classificationSuggestions],
    async () => {
      for (const row of existing) await db.classificationSuggestions.delete(row.id);
      if (suggestion) await db.classificationSuggestions.add(suggestion);
      await db.moneyEvents.update(event.id, {
        confidence: classification.confidence,
        status,
        updatedAt: now,
      });
    },
  );

  return { ...event, confidence: classification.confidence, status, updatedAt: now };
}

export async function captureStatementLines(
  db: LedgerDatabase,
  workspaceId: string,
  batch: ImportBatch,
  lines: StatementLine[],
  options?: { attachmentId?: string },
): Promise<CaptureEventsResult> {
  await ensureSeedClassificationRules(db, workspaceId);
  const now = nowIso();
  const created: MoneyEvent[] = [];
  let duplicates = 0;

  for (const line of lines) {
    if (line.workspaceId !== workspaceId) throw new Error('Statement line belongs to another workspace');
    const direction = line.creditMinor > line.debitMinor ? 'in' : 'out';
    const amountMinor = Math.abs(line.creditMinor - line.debitMinor);
    if (amountMinor === 0) continue;
    const sourceRef = (
      line.reference?.trim() ||
      `${batch.fileName ?? batch.adapterId ?? 'statement'}:${line.date}:${line.lineNo}`
    ).slice(0, 512);
    const contentHash = await moneyEventContentHash({
      sourceRef,
      date: line.date,
      amountMinor,
      direction,
      narration: line.description,
    });
    // Deduplication check 1: by exact contentHash
    let duplicate = await db.moneyEvents
      .where('contentHash')
      .equals(contentHash)
      .and((event) => event.workspaceId === workspaceId)
      .first();

    // Deduplication check 2: by canonical transaction reference (UTR, RRN, Order ID)
    if (!duplicate && line.reference?.trim()) {
      const cleanRef = line.reference.trim();
      duplicate = await db.moneyEvents
        .where('workspaceId')
        .equals(workspaceId)
        .and(
          (event) =>
            Boolean(event.sourceRef && (event.sourceRef === cleanRef || event.sourceRef.includes(cleanRef))) &&
            event.amountMinor === amountMinor &&
            event.direction === direction,
        )
        .first();
    }

    if (duplicate) {
      duplicates += 1;
      continue;
    }

    const event = MoneyEventSchema.parse(
      compact({
        id: newId('mev'),
        workspaceId,
        source:
          batch.source === 'email'
            ? 'email'
            : batch.source === 'fastag'
              ? 'fastag'
              : batch.source === 'manual'
                ? 'manual'
                : 'statement',
        sourceRef,
        contentHash,
        statementLineId: line.id,
        importBatchId: batch.id,
        bankLedgerId: line.accountId,
        date: line.date,
        amountMinor,
        direction,
        partyHint: undefined,
        narration: line.description.slice(0, 1024),
        attachmentId: options?.attachmentId,
        confidence: 0,
        status: 'captured',
        createdAt: now,
        updatedAt: now,
      }),
    );
    await db.moneyEvents.add(event);
    created.push(await classifyAndSave(db, event));
  }

  if (created.length > 0) {
    await markDriveDirty(db, workspaceId);
    await autoPostEligibleEvents(db, workspaceId, { eventIds: created.map((event) => event.id) });
    const refreshed = await db.moneyEvents.bulkGet(created.map((event) => event.id));
    return {
      created: refreshed.filter((event): event is MoneyEvent => Boolean(event)),
      duplicates,
    };
  }
  return { created, duplicates };
}

export async function listMoneyEvents(
  db: LedgerDatabase,
  workspaceId: string,
  options: { period?: string; includeResolved?: boolean; limit?: number } = {},
): Promise<MoneyEvent[]> {
  const events = await db.moneyEvents.where('workspaceId').equals(workspaceId).toArray();
  return events
    .filter((event) => !options.period || monthKey(event.date) === options.period)
    .filter(
      (event) =>
        options.includeResolved ||
        !['ignored', 'duplicate'].includes(event.status),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, options.limit ?? 200);
}

export async function listExceptionQueue(
  db: LedgerDatabase,
  workspaceId: string,
  options: { period?: string } = {},
): Promise<MoneyEventQueueItem[]> {
  const events = await listMoneyEvents(db, workspaceId, { ...options, includeResolved: false });
  const active = events.filter((event) => event.status !== 'posted');
  const suggestions = await db.classificationSuggestions
    .where('workspaceId')
    .equals(workspaceId)
    .toArray();
  const suggestionByEvent = new Map<string, ClassificationSuggestion>();
  for (const suggestion of suggestions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    suggestionByEvent.set(suggestion.moneyEventId, suggestion);
  }
  const amounts = active.map((event) => event.amountMinor).sort((a, b) => a - b);
  const items = active.map((event) => {
    const suggestion = suggestionByEvent.get(event.id);
    return {
      event,
      ...(suggestion ? { suggestion } : {}),
      risk: classifyMoneyEventRisk({
        event,
        suggestion,
        amountPercentile: amountPercentile(event.amountMinor, amounts),
      }),
    };
  });
  return items.sort((a, b) => b.risk.score - a.risk.score || b.event.date.localeCompare(a.event.date));
}

function amountPercentile(amount: number, sorted: number[]): number {
  if (sorted.length <= 1) return 0;
  const index = sorted.findIndex((value) => value >= amount);
  return Math.max(0, Math.min(1, index / (sorted.length - 1)));
}

export interface ApproveMoneyEventInput {
  ledgerId?: string;
  bankLedgerId?: string;
  partyId?: string;
  actor?: string;
}

export async function approveMoneyEvent(
  db: LedgerDatabase,
  workspaceId: string,
  eventId: string,
  input: ApproveMoneyEventInput = {},
): Promise<MoneyEvent> {
  const event = await db.moneyEvents.get(eventId);
  if (!event || event.workspaceId !== workspaceId) throw new Error('Money event not found');
  if (event.status === 'posted') throw new Error('Money event is already posted');
  if (event.status === 'ignored' || event.status === 'duplicate') {
    throw new Error('Money event is no longer in the exception queue');
  }
  const actor = input.actor ?? 'owner';
  const suggestion = await latestSuggestion(db, eventId);
  const ledgerId = input.ledgerId ?? suggestion?.ledgerId;
  if (!ledgerId) throw new Error('Choose a category ledger before posting');
  const bankLedgerId = input.bankLedgerId ?? event.bankLedgerId;
  if (!bankLedgerId) throw new Error('Choose the bank ledger for this event');
  const ledger = await db.ledgers.get(ledgerId);
  if (!ledger || ledger.workspaceId !== workspaceId) throw new Error('Category ledger not found');
  const bankLedger = await db.ledgers.get(bankLedgerId);
  if (!bankLedger || bankLedger.workspaceId !== workspaceId) throw new Error('Bank ledger not found');
  if (!bankLedger.isBank) throw new Error('Selected bank ledger is not marked as a bank');

  const amount = event.amountMinor;
  const lines =
    event.direction === 'out'
      ? [
          {
            ledgerId,
            amountMinor: amount,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          },
          {
            ledgerId: bankLedgerId,
            amountMinor: -amount,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          },
        ]
      : [
          {
            ledgerId: bankLedgerId,
            amountMinor: amount,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          },
          {
            ledgerId,
            amountMinor: -amount,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          },
        ];
  const voucherInput = compact({
    workspaceId,
    voucherType: event.direction === 'out' ? 'Payment' : 'Receipt',
    date: event.date,
    narration: event.narration,
    reference: event.sourceRef,
    partyLedgerId: input.partyId ?? suggestion?.partyId,
    reverseCharge: false,
    status: 'regular',
    currency: 'INR',
    source: event.source,
    sourceRef: event.sourceRef,
    lines,
    items: [],
    groupIds: [],
    tags: [],
  }) as NewVoucher;
  const posted = await postVoucher(db, voucherInput, { actor });
  const now = nowIso();
  const approvedByOwner = actor !== 'autopilot';
  const approvedSuggestion = ClassificationSuggestionSchema.parse(
    compact({
      id: suggestion?.id ?? newId('sug'),
      workspaceId,
      moneyEventId: eventId,
      ledgerId,
      partyId: input.partyId ?? suggestion?.partyId,
      taxHint: suggestion?.taxHint,
      confidence: approvedByOwner ? 1 : (suggestion?.confidence ?? 0),
      reasons: approvedByOwner
        ? ['Owner approved this category']
        : (suggestion?.reasons ?? ['Posted by autopilot']),
      ruleId: suggestion?.ruleId,
      createdAt: suggestion?.createdAt ?? now,
      updatedAt: now,
    }),
  );
  await db.classificationSuggestions.put(approvedSuggestion);
  await db.moneyEvents.update(eventId, {
    status: 'posted',
    postedVoucherId: posted.voucher.id,
    bankLedgerId,
    confidence: Math.max(event.confidence, suggestion?.confidence ?? 0),
    updatedAt: now,
  });
  if (event.attachmentId) {
    await db.attachments.update(event.attachmentId, {
      voucherId: posted.voucher.id,
      updatedAt: now,
    });
  }
  await db.auditEvents.add(
    AuditEventSchema.parse(
      compact({
        id: newId('aud'),
        workspaceId,
        entityType: 'money_event',
        entityId: eventId,
        action: 'create',
        at: now,
        actor,
        meta: { voucherId: posted.voucher.id, ledgerId },
      }),
    ),
  );
  return {
    ...event,
    status: 'posted',
    postedVoucherId: posted.voucher.id,
    bankLedgerId,
    updatedAt: now,
  };
}

export async function ignoreMoneyEvent(
  db: LedgerDatabase,
  workspaceId: string,
  eventId: string,
  actor = 'owner',
): Promise<MoneyEvent> {
  const event = await db.moneyEvents.get(eventId);
  if (!event || event.workspaceId !== workspaceId) throw new Error('Money event not found');
  if (event.status === 'posted') throw new Error('Posted events cannot be ignored');
  const now = nowIso();
  await db.moneyEvents.update(eventId, { status: 'ignored', updatedAt: now });
  await db.auditEvents.add(
    AuditEventSchema.parse(
      compact({
        id: newId('aud'),
        workspaceId,
        entityType: 'money_event',
        entityId: eventId,
        action: 'update',
        at: now,
        actor,
      }),
    ),
  );
  return { ...event, status: 'ignored', updatedAt: now };
}

export async function reverseMoneyEvent(
  db: LedgerDatabase,
  workspaceId: string,
  eventId: string,
  actor = 'owner',
): Promise<MoneyEvent> {
  const event = await db.moneyEvents.get(eventId);
  if (!event || event.workspaceId !== workspaceId) throw new Error('Money event not found');
  if (!event.postedVoucherId) throw new Error('Money event has not been posted');
  await reverseVoucher(db, event.postedVoucherId, { actor });
  const now = nowIso();
  await db.moneyEvents.update(eventId, {
    status: 'needs_review',
    postedVoucherId: undefined,
    updatedAt: now,
  });
  return { ...event, status: 'needs_review', postedVoucherId: undefined, updatedAt: now };
}

export async function autoPostEligibleEvents(
  db: LedgerDatabase,
  workspaceId: string,
  options: { eventIds?: string[] } = {},
): Promise<{ posted: number }> {
  const settings = await getAutoPostSettings(db, workspaceId);
  if (!settings.enabled) return { posted: 0 };
  const events = options.eventIds
    ? (await db.moneyEvents.bulkGet(options.eventIds)).filter(
        (event): event is MoneyEvent => Boolean(event && event.workspaceId === workspaceId),
      )
    : await db.moneyEvents.where('[workspaceId+status]').equals([workspaceId, 'suggested']).toArray();
  let posted = 0;
  for (const event of events) {
    if (event.status !== 'suggested' || event.confidence < 0.95) continue;
    const suggestion = await latestSuggestion(db, event.id);
    if (!suggestion?.ledgerId) continue;
    if (suggestion.taxHint) continue;
    if (event.direction === 'out' && !event.attachmentId) continue;
    if (!isCategoryEnabled(settings, suggestion.ledgerId)) continue;
    if (!event.bankLedgerId) continue;
    try {
      await approveMoneyEvent(db, workspaceId, event.id, { actor: 'autopilot' });
      posted += 1;
    } catch {
      // Leave the event in the queue; the close cockpit surfaces the reason.
    }
  }
  return { posted };
}
