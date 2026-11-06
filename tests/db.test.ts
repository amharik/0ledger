import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace, getWorkspaceBundle } from '@/core/db/workspace-service';
import { appendRoundOff } from '@/core/ledger/round-off';
import { postVoucher } from '@/core/ledger/post-voucher';
import { balanceSheet, profitAndLoss, trialBalance } from '@/core/ledger/reports';
import { LedgerValidationError } from '@/core/ledger/validation';
import { makeLineInput, makeNewVoucher } from './fixtures';

let db: LedgerDatabase;

function freshDb() {
  db = createTestDb();
  return db;
}

afterEach(async () => {
  await db.delete();
  db.close();
});

describe('workspace and ledger core', () => {
  it('creates a workspace with a default chart of accounts and numbering', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, {
      name: 'Acme Traders',
      state: 'Karnataka',
      gstin: '29ABCDE1234F1Z5',
    });

    expect(bundle.workspace.slug).toBe('acme-traders');
    expect(bundle.company.legalName).toBe('Acme Traders');
    expect(bundle.groups).toHaveLength(20);
    expect(bundle.ledgers.length).toBeGreaterThan(10);
    expect(bundle.numberingSchemes).toHaveLength(8);

    const loaded = await getWorkspaceBundle(local, bundle.workspace.id);
    expect(loaded?.workspace.id).toBe(bundle.workspace.id);
    expect(loaded?.ledgers).toHaveLength(bundle.ledgers.length);
  });

  it('auto-numbers, advances, and resets across financial years', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Numbering Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;

    const first = await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
      }),
    );
    expect(first.voucher.number).toBe('PMT/2026-27/0001');

    const second = await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        lines: [makeLineInput(purchases.id, 25_000), makeLineInput(cash.id, -25_000)],
      }),
    );
    expect(second.voucher.number).toBe('PMT/2026-27/0002');

    const nextFy = await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        date: '2027-04-01',
        lines: [makeLineInput(purchases.id, 10_000), makeLineInput(cash.id, -10_000)],
      }),
    );
    expect(nextFy.voucher.number).toBe('PMT/2027-28/0001');
  });

  it('rejects duplicate manual numbers and allows unique overrides', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Manual Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    const lines = [makeLineInput(purchases.id, 1_000), makeLineInput(cash.id, -1_000)];

    const custom = await postVoucher(
      local,
      makeNewVoucher({ workspaceId: bundle.workspace.id, number: 'PMT/CUSTOM/1', lines }),
    );
    expect(custom.voucher.number).toBe('PMT/CUSTOM/1');

    await expect(
      postVoucher(
        local,
        makeNewVoucher({ workspaceId: bundle.workspace.id, number: 'PMT/CUSTOM/1', lines }),
      ),
    ).rejects.toBeInstanceOf(LedgerValidationError);
  });

  it('reports trial balance, P&L and balance sheet', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Reporting Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;

    await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
      }),
    );

    const tb = await trialBalance(local, bundle.workspace.id);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebitMinor).toBe(50_000);
    expect(tb.totalCreditMinor).toBe(50_000);
    expect(tb.rows.find((row) => row.ledgerId === purchases.id)?.closingMinor).toBe(50_000);
    expect(tb.rows.find((row) => row.ledgerId === cash.id)?.closingMinor).toBe(-50_000);

    const pnl = await profitAndLoss(local, bundle.workspace.id);
    expect(pnl.totalExpenseMinor).toBe(50_000);
    expect(pnl.totalIncomeMinor).toBe(0);
    expect(pnl.netProfitMinor).toBe(-50_000);

    const sheet = await balanceSheet(local, bundle.workspace.id);
    expect(sheet.balanced).toBe(true);
  });

  it('excludes optional vouchers from reports', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Optional Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;

    await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        status: 'optional',
        lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
      }),
    );

    const tb = await trialBalance(local, bundle.workspace.id);
    expect(tb.totalDebitMinor).toBe(0);
    expect(tb.totalCreditMinor).toBe(0);
    expect(tb.balanced).toBe(true);
  });

  it('posts an explicit round-off line and keeps the ledger balanced', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Rounding Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    const roundOff = bundle.ledgers.find((ledger) => ledger.name === 'Round Off')!;

    const rounded = appendRoundOff(
      [makeLineInput(purchases.id, 123_456), makeLineInput(cash.id, -123_456)],
      { ledgerId: roundOff.id, stepMinor: 100, settlementLineIndex: 1 },
    );
    expect(rounded.roundOffMinor).toBe(44);

    const posted = await postVoucher(
      local,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        roundOffLedgerId: roundOff.id,
        lines: rounded.lines,
      }),
    );
    expect(posted.voucher.roundOffAmountMinor).toBe(44);

    const tb = await trialBalance(local, bundle.workspace.id);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((row) => row.ledgerId === purchases.id)?.closingMinor).toBe(123_456);
    expect(tb.rows.find((row) => row.ledgerId === roundOff.id)?.closingMinor).toBe(44);
    expect(tb.rows.find((row) => row.ledgerId === cash.id)?.closingMinor).toBe(-123_500);
  });

  it('does not advance numbering when validation fails', async () => {
    const local = freshDb();
    const bundle = await createWorkspace(local, { name: 'Rollback Co' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    const scheme = bundle.numberingSchemes.find((item) => item.voucherType === 'Payment')!;

    await expect(
      postVoucher(
        local,
        makeNewVoucher({
          workspaceId: bundle.workspace.id,
          number: scheme.prefix + '/2026-27/0001',
          lines: [makeLineInput(purchases.id, 10_000), makeLineInput(cash.id, -9_000)],
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerValidationError);

    const after = await local.numberingSchemes.get(scheme.id);
    expect(after?.nextNumber).toBe(1);
  });
});
