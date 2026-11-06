import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import {
  createStockItem,
  listParties,
  listStockItems,
  updateParty,
  updateStockItem,
} from '@/core/db/master-service';
import { createLedger } from '@/core/db/ledger-service';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import { agingBucket, billAging, partyOutstanding } from '@/core/ledger/reports';
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

describe('bill-wise and party reports', () => {
  it('computes party outstanding and ages a settled bill', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Bills Co', state: 'Karnataka' });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const sales = bundle.ledgers.find((ledger) => ledger.name === 'Sales')!;
    const debtors = bundle.groups.find((group) => group.name === 'Sundry Debtors')!;
    const customer = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Customer One',
      groupId: debtors.id,
      createPartyMaster: true,
    });

    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Sales',
        partyLedgerId: customer.ledger.id,
        invoiceNumber: 'INV-1',
        dueDate: '2026-10-01',
        date: '2026-09-01',
        lines: [
          {
            ...makeLineInput(customer.ledger.id, 100_000),
            billAllocations: [
              {
                billRef: 'INV-1',
                billType: 'New Ref',
                amountMinor: 100_000,
                dueDate: '2026-10-01',
              },
            ],
          },
          makeLineInput(sales.id, -100_000),
        ],
      }),
    );

    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Receipt',
        date: '2026-11-01',
        lines: [
          makeLineInput(cash.id, 40_000),
          {
            ...makeLineInput(customer.ledger.id, -40_000),
            billAllocations: [
              { billRef: 'INV-1', billType: 'Against Ref', amountMinor: 40_000 },
            ],
          },
        ],
      }),
    );

    const parties = await partyOutstanding(db, bundle.workspace.id);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      partyName: 'Customer One',
      type: 'debtor',
      balanceMinor: 60_000,
      outstandingMinor: 60_000,
      billCount: 2,
    });

    const aging = await billAging(db, bundle.workspace.id, '2026-11-06');
    expect(aging).toHaveLength(1);
    expect(aging[0]).toMatchObject({
      billRef: 'INV-1',
      originalMinor: 100_000,
      settledMinor: 40_000,
      outstandingMinor: 60_000,
      dueDate: '2026-10-01',
      daysOverdue: 36,
      bucket: '31-60',
    });

    const early = await billAging(db, bundle.workspace.id, '2026-09-15');
    expect(early[0]).toMatchObject({ daysOverdue: 0, bucket: 'current' });
    expect(agingBucket(0)).toBe('current');
    expect(agingBucket(10)).toBe('1-15');
    expect(agingBucket(120)).toBe('90+');
  });

  it('shows creditor outstanding from party master and ledger balance', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Creditor Co' });
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    const creditors = bundle.groups.find((group) => group.name === 'Sundry Creditors')!;
    const supplier = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Supplier One',
      groupId: creditors.id,
    });

    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Purchase',
        partyLedgerId: supplier.ledger.id,
        invoiceNumber: 'P-1',
        lines: [
          makeLineInput(purchases.id, 80_000),
          makeLineInput(supplier.ledger.id, -80_000),
        ],
      }),
    );

    const parties = await partyOutstanding(db, bundle.workspace.id);
    expect(parties[0]).toMatchObject({
      partyName: 'Supplier One',
      type: 'creditor',
      balanceMinor: -80_000,
      outstandingMinor: 80_000,
    });
  });
});

describe('party and stock item masters', () => {
  it('lists and updates party details', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Master Co' });
    const debtors = bundle.groups.find((group) => group.name === 'Sundry Debtors')!;
    const customer = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Customer One',
      groupId: debtors.id,
    });

    const views = await listParties(db, bundle.workspace.id);
    expect(views).toHaveLength(1);
    const updated = await updateParty(db, views[0]!.party.id, {
      gstin: '29abcde1234f1z5',
      email: 'customer@example.com',
      creditPeriodDays: 30,
      creditLimitMinor: 5_000_000,
    });
    expect(updated).toMatchObject({
      gstin: '29ABCDE1234F1Z5',
      email: 'customer@example.com',
      creditPeriodDays: 30,
      creditLimitMinor: 5_000_000,
    });
    expect(customer.party?.ledgerId).toBe(views[0]!.ledger.id);
  });

  it('creates, lists and updates stock items with unique names', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Stock Co' });
    const item = await createStockItem(db, {
      workspaceId: bundle.workspace.id,
      name: 'Masala Chai',
      hsnSac: '0902',
      rateMinor: 25_000,
      taxRate: '5',
    });
    expect(item.name).toBe('Masala Chai');
    expect(await listStockItems(db, bundle.workspace.id)).toHaveLength(1);
    await expect(
      createStockItem(db, { workspaceId: bundle.workspace.id, name: 'masala chai' }),
    ).rejects.toThrow(/already exists/i);

    const updated = await updateStockItem(db, item.id, {
      name: 'Masala Chai Premium',
      rateMinor: 30_000,
    });
    expect(updated).toMatchObject({ name: 'Masala Chai Premium', rateMinor: 30_000 });
  });
});
