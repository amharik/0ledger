import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import {
  confirmStatementMatch,
  ignoreStatementLine,
  listStatementMatchQueue,
  statementBalanceReport,
  suggestMatches,
  unmatchStatementLine,
} from '@/core/ledger/reconciliation';
import { stageImport, verifyStatementBalance } from '@/core/ingest';
import { makeLineInput, makeNewVoucher } from './fixtures';

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

async function setup() {
  const db = newDb();
  const bundle = await createWorkspace(db, { name: 'Reconcile Co', state: 'Karnataka' });
  const bank = bundle.ledgers.find((ledger) => ledger.name === 'Bank Account')!;
  const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
  return { db, bundle, bank, purchases };
}

async function postPayment(
  db: LedgerDatabase,
  workspaceId: string,
  bankId: string,
  purchasesId: string,
  amountMinor: number,
  date = '2026-11-01',
) {
  return postVoucher(
    db,
    makeNewVoucher({
      workspaceId,
      voucherType: 'Payment',
      date,
      lines: [makeLineInput(purchasesId, amountMinor), makeLineInput(bankId, -amountMinor)],
    }),
  );
}

async function stageLine(
  db: LedgerDatabase,
  workspaceId: string,
  accountId: string,
  debitMinor: number,
  date = '2026-11-01',
) {
  return stageImport(db, {
    workspaceId,
    source: 'csv',
    accountId,
    fileName: 'statement.csv',
    statement: {
      adapterId: 'hdfc',
      adapterName: 'HDFC Bank',
      kind: 'bank',
      currency: 'INR',
      rows: [
        {
          date,
          description: 'UPI PAID VENDOR REF123',
          reference: 'REF123',
          debitMinor,
          creditMinor: 0,
          balanceMinor: 98_500,
          currency: 'INR',
          raw: {},
        },
      ],
    },
  });
}

describe('reconciliation', () => {
  it('suggests, confirms, and unmatches a statement line', async () => {
    const { db, bundle, bank, purchases } = await setup();
    await postPayment(db, bundle.workspace.id, bank.id, purchases.id, 100_000);
    const staged = await stageLine(db, bundle.workspace.id, bank.id, 100_000);

    const queue = await suggestMatches(db, bundle.workspace.id, { accountId: bank.id });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.line.matchStatus).toBe('suggested');
    expect(queue[0]?.candidates).toHaveLength(1);
    expect(queue[0]?.candidates[0]?.confidence).toBeGreaterThan(0.7);

    const voucherId = queue[0]!.candidates[0]!.voucher.id;
    const matches = await confirmStatementMatch(
      db,
      bundle.workspace.id,
      staged.lines[0]!.id,
      [{ voucherId, amountMinor: -100_000 }],
    );
    expect(matches).toHaveLength(1);
    let line = await db.statementLines.get(staged.lines[0]!.id);
    expect(line?.matchStatus).toBe('matched');
    expect(line?.matchedVoucherId).toBe(voucherId);

    await unmatchStatementLine(db, bundle.workspace.id, staged.lines[0]!.id);
    line = await db.statementLines.get(staged.lines[0]!.id);
    expect(line?.matchStatus).toBe('unmatched');
    expect(line?.matchedVoucherId).toBeUndefined();
  });

  it('supports one statement line matched to multiple vouchers', async () => {
    const { db, bundle, bank, purchases } = await setup();
    const first = await postPayment(db, bundle.workspace.id, bank.id, purchases.id, 60_000);
    const second = await postPayment(db, bundle.workspace.id, bank.id, purchases.id, 40_000);
    const staged = await stageLine(db, bundle.workspace.id, bank.id, 100_000);

    const matches = await confirmStatementMatch(db, bundle.workspace.id, staged.lines[0]!.id, [
      { voucherId: first.voucher.id, amountMinor: -60_000 },
      { voucherId: second.voucher.id, amountMinor: -40_000 },
    ]);
    expect(matches).toHaveLength(2);
    const line = await db.statementLines.get(staged.lines[0]!.id);
    expect(line?.matchStatus).toBe('matched');
    expect(line?.matchedVoucherId).toBeUndefined();
  });

  it('rejects splits that do not add up', async () => {
    const { db, bundle, bank, purchases } = await setup();
    const first = await postPayment(db, bundle.workspace.id, bank.id, purchases.id, 60_000);
    const staged = await stageLine(db, bundle.workspace.id, bank.id, 100_000);
    await expect(
      confirmStatementMatch(db, bundle.workspace.id, staged.lines[0]!.id, [
        { voucherId: first.voucher.id, amountMinor: -60_000 },
      ]),
    ).rejects.toThrow(/does not equal/);
  });

  it('ignores a line and reports statement balance assertions', async () => {
    const { db, bundle, bank } = await setup();
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      accountId: bank.id,
      fileName: 'balances.csv',
      statement: {
        adapterId: 'hdfc',
        adapterName: 'HDFC Bank',
        kind: 'bank',
        currency: 'INR',
        rows: [
          {
            date: '2026-11-01',
            description: 'Opening',
            debitMinor: 0,
            creditMinor: 0,
            balanceMinor: 100_000,
            currency: 'INR',
            raw: {},
          },
          {
            date: '2026-11-02',
            description: 'Payment',
            debitMinor: 10_000,
            creditMinor: 0,
            balanceMinor: 90_000,
            currency: 'INR',
            raw: {},
          },
        ],
      },
    });
    expect(verifyStatementBalance(staged.lines).mismatches).toEqual([]);
    const report = await statementBalanceReport(db, bundle.workspace.id);
    expect(report[0]).toMatchObject({ checked: 1, mismatches: 0 });

    await ignoreStatementLine(db, bundle.workspace.id, staged.lines[0]!.id);
    const queue = await listStatementMatchQueue(db, bundle.workspace.id);
    expect(queue).toHaveLength(1);
  });
});
