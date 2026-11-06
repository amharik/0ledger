import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import {
  cancelVoucher,
  deleteVoucher,
  getPostedVoucher,
  postVoucher,
  trialBalance,
  updateVoucher,
} from '@/core/ledger';
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

async function seeded() {
  const db = newDb();
  const bundle = await createWorkspace(db, { name: 'Voucher Co', state: 'Karnataka' });
  const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
  const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
  const posted = await postVoucher(
    db,
    makeNewVoucher({
      workspaceId: bundle.workspace.id,
      date: '2026-11-06',
      narration: 'Original',
      lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
    }),
  );
  return { db, bundle, cash, purchases, posted };
}

function editInput(
  bundle: Awaited<ReturnType<typeof createWorkspace>>,
  voucher: Awaited<ReturnType<typeof postVoucher>>['voucher'],
  purchasesId: string,
  cashId: string,
  amountMinor: number,
) {
  return makeNewVoucher({
    workspaceId: bundle.workspace.id,
    voucherType: voucher.voucherType,
    number: voucher.number,
    date: '2026-11-07',
    narration: 'Corrected',
    source: voucher.source,
    lines: [makeLineInput(purchasesId, amountMinor), makeLineInput(cashId, -amountMinor)],
  });
}

describe('voucher review, edit, cancel and delete', () => {
  it('loads a posted voucher with all children', async () => {
    const { db, posted } = await seeded();
    const loaded = await getPostedVoucher(db, posted.voucher.id);
    expect(loaded?.voucher.number).toBe(posted.voucher.number);
    expect(loaded?.lines).toHaveLength(2);
    expect(loaded?.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(await getPostedVoucher(db, 'missing')).toBeUndefined();
  });

  it('edits a regular voucher, preserving id/number/line ids and replacing balances', async () => {
    const { db, bundle, cash, purchases, posted } = await seeded();
    const updated = await updateVoucher(
      db,
      posted.voucher.id,
      editInput(bundle, posted.voucher, purchases.id, cash.id, 60_000),
    );

    expect(updated.voucher.id).toBe(posted.voucher.id);
    expect(updated.voucher.number).toBe(posted.voucher.number);
    expect(updated.voucher.date).toBe('2026-11-07');
    expect(updated.voucher.narration).toBe('Corrected');
    expect(updated.voucher.totalDebitMinor).toBe(60_000);
    expect(updated.voucher.totalCreditMinor).toBe(60_000);
    expect(updated.voucher.createdAt).toBe(posted.voucher.createdAt);
    expect(updated.lines.map((line) => line.id)).toEqual(posted.lines.map((line) => line.id));

    const reloaded = await getPostedVoucher(db, posted.voucher.id);
    expect(reloaded?.lines.map((line) => line.amountMinor)).toEqual([60_000, -60_000]);
    expect(reloaded?.items).toHaveLength(0);

    const report = await trialBalance(db, bundle.workspace.id);
    expect(report.totalDebitMinor).toBe(60_000);
    expect(report.totalCreditMinor).toBe(60_000);

    const audits = await db.auditEvents
      .where('[workspaceId+entityId]')
      .equals([bundle.workspace.id, posted.voucher.id])
      .toArray();
    expect(audits.map((audit) => audit.action)).toEqual(['create', 'update']);
  });

  it('rejects number/type changes and editing a cancelled voucher', async () => {
    const { db, bundle, cash, purchases, posted } = await seeded();
    const input = editInput(bundle, posted.voucher, purchases.id, cash.id, 50_000);

    await expect(
      updateVoucher(db, posted.voucher.id, { ...input, number: 'PMT/2026-27/9999' }),
    ).rejects.toThrow(/number cannot be changed/i);
    await expect(
      updateVoucher(db, posted.voucher.id, { ...input, voucherType: 'Receipt' }),
    ).rejects.toThrow(/type cannot be changed/i);

    await cancelVoucher(db, posted.voucher.id);
    await expect(updateVoucher(db, posted.voucher.id, input)).rejects.toThrow(
      /only regular vouchers/i,
    );
  });

  it('cancels without deleting and excludes the voucher from reports', async () => {
    const { db, bundle, posted } = await seeded();
    const cancelled = await cancelVoucher(db, posted.voucher.id);
    expect(cancelled.status).toBe('cancelled');
    expect(await db.vouchers.get(posted.voucher.id)).toMatchObject({ status: 'cancelled' });
    expect(await getPostedVoucher(db, posted.voucher.id)).toBeDefined();

    const report = await trialBalance(db, bundle.workspace.id);
    expect(report.totalDebitMinor).toBe(0);
    expect(report.totalCreditMinor).toBe(0);

    const audits = await db.auditEvents
      .where('[workspaceId+entityId]')
      .equals([bundle.workspace.id, posted.voucher.id])
      .toArray();
    expect(audits.map((audit) => audit.action)).toEqual(['create', 'void']);
    expect((await cancelVoucher(db, posted.voucher.id)).status).toBe('cancelled');
  });

  it('deletes only after cancellation and removes all child rows', async () => {
    const { db, bundle, posted } = await seeded();
    await expect(deleteVoucher(db, posted.voucher.id)).rejects.toThrow(/cancel the voucher/i);

    await cancelVoucher(db, posted.voucher.id);
    await deleteVoucher(db, posted.voucher.id);

    expect(await db.vouchers.get(posted.voucher.id)).toBeUndefined();
    expect(await db.voucherLines.where('voucherId').equals(posted.voucher.id).count()).toBe(0);
    expect(await db.itemLines.where('voucherId').equals(posted.voucher.id).count()).toBe(0);
    expect(await db.billAllocations.where('voucherId').equals(posted.voucher.id).count()).toBe(0);
    expect(
      await db.costCenterAllocations.where('voucherId').equals(posted.voucher.id).count(),
    ).toBe(0);
    expect(await db.taxAllocations.where('voucherId').equals(posted.voucher.id).count()).toBe(0);

    const audits = await db.auditEvents
      .where('[workspaceId+entityId]')
      .equals([bundle.workspace.id, posted.voucher.id])
      .toArray();
    expect(audits.map((audit) => audit.action)).toEqual(['create', 'void', 'delete']);
  });
});
