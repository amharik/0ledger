import { newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import { compact } from '../util/objects';
import {
  ClassificationRuleSchema,
  type ClassificationRule,
  type MoneyEvent,
} from '../model';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_LEDGERS } from '../db/defaults';
import { createLedger } from '../db/ledger-service';
import type { LedgerDatabase } from '../db/db';

export interface RuleClassification {
  ledgerId?: string;
  partyId?: string;
  taxHint?: string;
  confidence: number;
  reasons: string[];
  ruleId?: string;
}

export interface NewClassificationRuleInput {
  name: string;
  matchType: ClassificationRule['matchType'];
  pattern: string;
  ledgerId: string;
  partyId?: string;
  taxHint?: string;
  confidence?: number;
  priority?: number;
  enabled?: boolean;
}

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeCompact(value: string | undefined): string {
  return normalize(value).replace(/\s+/g, '');
}

function matchAmountDateParty(event: MoneyEvent, pattern: string): boolean {
  const terms = Object.fromEntries(
    pattern
      .split(';')
      .map((term) => term.split('=').map((part) => part.trim()))
      .filter((parts) => parts.length === 2) as Array<[string, string]>,
  );
  if (Object.keys(terms).length === 0) return false;
  if (terms.amount && Number(terms.amount) !== event.amountMinor / 100) return false;
  if (terms.date && terms.date !== event.date) return false;
  if (terms.party && !normalize(`${event.partyHint ?? ''} ${event.narration}`).includes(normalize(terms.party))) {
    return false;
  }
  if (terms.reference && !normalizeCompact(event.sourceRef).includes(normalizeCompact(terms.reference))) {
    return false;
  }
  return true;
}

export function ruleMatchesEvent(rule: ClassificationRule, event: MoneyEvent): boolean {
  const pattern = normalize(rule.pattern);
  if (!pattern) return false;
  const narration = normalize(event.narration);
  const party = normalize(event.partyHint);
  const reference = normalize(event.sourceRef);

  switch (rule.matchType) {
    case 'narration-keyword':
      return narration.includes(pattern);
    case 'party':
      return party.includes(pattern);
    case 'reference':
      return reference.includes(pattern);
    case 'tax-hint':
      return narration.includes(pattern) || party.includes(pattern) || reference.includes(pattern);
    case 'amount-date-party':
      return matchAmountDateParty(event, rule.pattern);
  }
}

export function classifyEvent(
  event: MoneyEvent,
  rules: ClassificationRule[],
): RuleClassification {
  const matches = rules
    .filter((rule) => rule.enabled && rule.workspaceId === event.workspaceId && ruleMatchesEvent(rule, event))
    .sort((a, b) => b.confidence - a.confidence || a.priority - b.priority);
  const top = matches[0];
  if (!top) {
    return { confidence: 0, reasons: ['No classification rule matched'] };
  }
  return {
    ledgerId: top.ledgerId,
    ...(top.partyId ? { partyId: top.partyId } : {}),
    ...(top.taxHint ? { taxHint: top.taxHint } : {}),
    confidence: top.confidence,
    reasons: [`Matched rule "${top.name}" (${top.matchType}: ${top.pattern})`],
    ruleId: top.id,
  };
}

export async function ensureSeedClassificationRules(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ClassificationRule[]> {
  const existing = await db.classificationRules.where('workspaceId').equals(workspaceId).count();
  if (existing > 0) return listClassificationRules(db, workspaceId);

  let ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
  const existingNames = new Set(ledgers.map((ledger) => ledger.name.trim().toLowerCase()));
  for (const spec of DEFAULT_LEDGERS) {
    if (existingNames.has(spec.name.trim().toLowerCase())) continue;
    await createLedger(db, {
      workspaceId,
      name: spec.name,
      tallyParent: spec.tallyParent,
      ...(spec.code ? { code: spec.code } : {}),
    });
    existingNames.add(spec.name.trim().toLowerCase());
  }
  ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
  const byName = new Map(ledgers.map((ledger) => [ledger.name, ledger]));
  const now = nowIso();
  const rules: ClassificationRule[] = [];
  for (const [index, spec] of DEFAULT_CLASSIFICATION_RULES.entries()) {
    const ledger = byName.get(spec.ledgerName);
    if (!ledger) continue;
    rules.push(
      ClassificationRuleSchema.parse(
        compact({
          id: newId('rul'),
          workspaceId,
          name: spec.name,
          priority: index + 1,
          enabled: true,
          matchType: spec.matchType,
          pattern: spec.pattern,
          ledgerId: ledger.id,
          taxHint: spec.taxHint,
          confidence: spec.confidence,
          source: 'seed',
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  }
  if (rules.length > 0) {
    await db.classificationRules.bulkAdd(rules);
    await markDriveDirty(db, workspaceId);
  }
  return rules;
}

export async function listClassificationRules(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ClassificationRule[]> {
  const rules = await db.classificationRules.where('workspaceId').equals(workspaceId).toArray();
  return rules.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

export async function createClassificationRule(
  db: LedgerDatabase,
  workspaceId: string,
  input: NewClassificationRuleInput,
): Promise<ClassificationRule> {
  const ledger = await db.ledgers.get(input.ledgerId);
  if (!ledger || ledger.workspaceId !== workspaceId) throw new Error('Ledger not found for this workspace');
  const now = nowIso();
  const rule = ClassificationRuleSchema.parse(
    compact({
      id: newId('rul'),
      workspaceId,
      name: input.name,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      matchType: input.matchType,
      pattern: input.pattern,
      ledgerId: input.ledgerId,
      partyId: input.partyId,
      taxHint: input.taxHint,
      confidence: input.confidence ?? 0.8,
      source: 'owner',
      createdAt: now,
      updatedAt: now,
    }),
  );
  await db.classificationRules.add(rule);
  await markDriveDirty(db, workspaceId);
  return rule;
}

export async function updateClassificationRule(
  db: LedgerDatabase,
  workspaceId: string,
  ruleId: string,
  patch: Partial<NewClassificationRuleInput>,
): Promise<ClassificationRule> {
  const existing = await db.classificationRules.get(ruleId);
  if (!existing || existing.workspaceId !== workspaceId) throw new Error('Classification rule not found');
  if (patch.ledgerId) {
    const ledger = await db.ledgers.get(patch.ledgerId);
    if (!ledger || ledger.workspaceId !== workspaceId) throw new Error('Ledger not found for this workspace');
  }
  const next = ClassificationRuleSchema.parse(
    compact({
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: existing.workspaceId,
      source: existing.source,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    }),
  );
  await db.classificationRules.put(next);
  await markDriveDirty(db, workspaceId);
  return next;
}

export async function deleteClassificationRule(
  db: LedgerDatabase,
  workspaceId: string,
  ruleId: string,
): Promise<void> {
  const existing = await db.classificationRules.get(ruleId);
  if (!existing || existing.workspaceId !== workspaceId) throw new Error('Classification rule not found');
  await db.classificationRules.delete(ruleId);
  await markDriveDirty(db, workspaceId);
}
