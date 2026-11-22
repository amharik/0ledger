import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { stageImport } from '@/core/ingest';
import {
  approveMoneyEvent,
  askCaForItem,
  autoPostEligibleEvents,
  buildCloseCockpit,
  captureStatementLines,
  createClassificationRule,
  generateCaPack,
  getAutoPostSettings,
  listClassificationRules,
  listExceptionQueue,
  reverseMoneyEvent,
  setAutoPostSettings,
} from '@/core/autopilot';
import { trialBalance } from '@/core/ledger/reports';

const databases: LedgerDatabase[] = [];

function newDb() {
  const db = createTestDb();
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

async function seeded() {
  const db = newDb();
  const bundle = await createWorkspace(db, {
    name: 'Autopilot Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  return { db, bundle };
}

function statement(description: string, debitMinor: number, creditMinor: number) {
  return {
    adapterId: 'test-bank',
    adapterName: 'Test Bank',
    kind: 'bank' as const,
    currency: 'INR',
    rows: [
      {
        date: '2026-11-05',
        description,
        reference: `REF-${debitMinor}-${creditMinor}`,
        debitMinor,
        creditMinor,
        currency: 'INR',
        raw: {},
      },
    ],
  };
}

describe('autopilot books', () => {
  it('seeds owner-safe classification rules in a new workspace', async () => {
    const { db, bundle } = await seeded();
    const rules = await listClassificationRules(db, bundle.workspace.id);
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.find((rule) => rule.name === 'Bank charges')?.confidence).toBeGreaterThan(0.9);
    expect(await getAutoPostSettings(db, bundle.workspace.id)).toEqual({
      enabled: false,
      categories: {},
    });
  });

  it('turns statement lines into deduplicated money events with suggestions', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('BANK CHARGE SMS ALERT', 500, 0),
      accountId: bank.id,
    });

    const first = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.direction).toBe('out');
    expect(first.created[0]!.amountMinor).toBe(500);
    expect(first.created[0]!.status).toBe('suggested');
    expect(first.created[0]!.confidence).toBeGreaterThan(0.9);

    const second = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    expect(second.created).toHaveLength(0);
    expect(second.duplicates).toBe(1);

    const queue = await listExceptionQueue(db, bundle.workspace.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.suggestion?.ledgerId).toBe(
      bundle.ledgers.find((ledger) => ledger.name === 'Bank Charges')!.id,
    );
  });

  it('posts and reverses an event through normal vouchers', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('BANK CHARGE', 12_500, 0),
      accountId: bank.id,
    });
    const captured = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    const event = captured.created[0]!;

    const posted = await approveMoneyEvent(db, bundle.workspace.id, event.id);
    expect(posted.status).toBe('posted');
    expect(posted.postedVoucherId).toBeTruthy();

    const voucher = await db.vouchers.get(posted.postedVoucherId!);
    expect(voucher?.voucherType).toBe('Payment');
    expect(voucher?.totalDebitMinor).toBe(12_500);

    const reversed = await reverseMoneyEvent(db, bundle.workspace.id, event.id);
    expect(reversed.status).toBe('needs_review');
    expect(reversed.postedVoucherId).toBeUndefined();

    const tb = await trialBalance(db, bundle.workspace.id);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((row) => row.name === 'Bank Charges')?.closingMinor).toBe(0);
    expect(await db.vouchers.count()).toBe(2);
  });

  it('does not auto-post a high-confidence expense without a document', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const bankCharges = bundle.ledgers.find((ledger) => ledger.name === 'Bank Charges')!;
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('BANK CHARGE', 2_500, 0),
      accountId: bank.id,
    });
    await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    await setAutoPostSettings(db, bundle.workspace.id, {
      enabled: true,
      categories: { [bankCharges.id]: true },
    });

    const result = await autoPostEligibleEvents(db, bundle.workspace.id);
    expect(result.posted).toBe(0);
    expect(await db.vouchers.count()).toBe(0);
    const queue = await listExceptionQueue(db, bundle.workspace.id);
    expect(queue[0]!.event.status).toBe('suggested');
  });


  it('auto-posts a high-confidence receipt when the category is enabled', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const interest = bundle.ledgers.find((ledger) => ledger.name === 'Interest Received')!;
    await createClassificationRule(db, bundle.workspace.id, {
      name: 'Interest credit',
      matchType: 'narration-keyword',
      pattern: 'interest credit',
      ledgerId: interest.id,
      confidence: 0.96,
    });
    await setAutoPostSettings(db, bundle.workspace.id, {
      enabled: true,
      categories: { [interest.id]: true },
    });
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('INTEREST CREDIT', 0, 500),
      accountId: bank.id,
    });
    const captured = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);

    expect(captured.created[0]!.status).toBe('posted');
    expect(captured.created[0]!.postedVoucherId).toBeTruthy();
    expect(await db.vouchers.count()).toBe(1);
  });


  it('surfaces close items and carries CA questions into the pack', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('BANK CHARGE', 2_500, 0),
      accountId: bank.id,
    });
    await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);

    const cockpit = await buildCloseCockpit(db, bundle.workspace.id, '2026-11');
    expect(cockpit.openItems.map((item) => item.type)).toContain('unreconciled_bank');
    expect(cockpit.openItems.map((item) => item.type)).toContain('missing_document');
    expect(cockpit.readiness.score).toBeLessThan(60);

    const missing = cockpit.openItems.find((item) => item.type === 'missing_document')!;
    await askCaForItem(db, bundle.workspace.id, missing.id, 'Need the bank charge advice');
    const pack = await generateCaPack(db, bundle.workspace.id, '2026-11');
    const questions = pack.files.find((file) => file.name === 'questions-for-ca.csv')!;

    expect(pack.pack.questionsForCa).toHaveLength(1);
    expect(questions.content).toContain('Need the bank charge advice');
  });

  it('builds a CA pack with Tally XML and close evidence', async () => {
    const { db, bundle } = await seeded();
    const bank = bundle.ledgers.find((ledger) => ledger.isBank)!;
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: statement('BANK CHARGE', 3_000, 0),
      accountId: bank.id,
    });
    const captured = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    await approveMoneyEvent(db, bundle.workspace.id, captured.created[0]!.id);

    const result = await generateCaPack(db, bundle.workspace.id, '2026-11');
    expect(result.files.map((file) => file.name)).toContain('tally.xml');
    expect(result.files.map((file) => file.name)).toContain('ca-pack.json');
    expect(result.files.find((file) => file.name === 'tally.xml')?.content).toContain('<ENVELOPE>');
    expect(result.pack.period).toBe('2026-11');
    expect(result.pack.voucherIds).toHaveLength(1);
    expect(await db.caPacks.count()).toBe(1);
  });
});
