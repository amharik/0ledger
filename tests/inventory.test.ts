import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createLedger } from '@/core/db/ledger-service';
import { createStockItem } from '@/core/db/master-service';
import { createWorkspace } from '@/core/db/workspace-service';
import { stockReport } from '@/core/inventory';
import { postVoucher } from '@/core/ledger/post-voucher';
import type { ItemLineInput, NewVoucherInput } from '@/core/model';
import { makeLineInput } from './fixtures';

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

async function setup(method: 'fifo' | 'weighted-average' | 'standard-cost') {
  const db = newDb();
  const bundle = await createWorkspace(db, {
    name: 'Stock Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
  const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
  const sales = bundle.ledgers.find((ledger) => ledger.name === 'Sales')!;
  const debtors = bundle.groups.find((group) => group.name === 'Sundry Debtors')!;
  const creditors = bundle.groups.find((group) => group.name === 'Sundry Creditors')!;
  const customer = await createLedger(db, {
    workspaceId: bundle.workspace.id,
    name: 'Customer One',
    groupId: debtors.id,
  });
  const supplier = await createLedger(db, {
    workspaceId: bundle.workspace.id,
    name: 'Supplier One',
    groupId: creditors.id,
  });
  const widget = await createStockItem(db, {
    workspaceId: bundle.workspace.id,
    name: 'Widget',
    uom: 'PCS',
    rateMinor: 10_000,
    openingQuantity: '10',
    openingValueMinor: 100_000,
    valuationMethod: method,
  });
  return { db, bundle, cash, purchases, sales, customer, supplier, widget };
}

function item(widgetId: string, quantity: string, rateMinor: number): ItemLineInput {
  return {
    stockItemId: widgetId,
    description: 'Widget',
    quantity,
    uom: 'PCS',
    rateMinor,
    amountMinor: Math.round(Number(quantity) * rateMinor),
    discountMinor: 0,
  };
}

async function post(
  db: LedgerDatabase,
  workspaceId: string,
  input: NewVoucherInput,
): Promise<void> {
  await postVoucher(db, input);
}

describe('stock valuation', () => {
  it('values FIFO sales against the oldest lots', async () => {
    const { db, bundle, cash, purchases, sales, customer, supplier, widget } = await setup('fifo');
    await post(db, bundle.workspace.id, {
      workspaceId: bundle.workspace.id,
      voucherType: 'Purchase',
      date: '2026-04-02',
      partyLedgerId: supplier.ledger.id,
      currency: 'INR',
      reverseCharge: false,
      status: 'regular',
      source: 'manual',
      groupIds: [],
      tags: [],
      lines: [makeLineInput(purchases.id, 120_000), makeLineInput(cash.id, -120_000)],
      items: [item(widget.id, '10', 12_000)],
    });
    await post(db, bundle.workspace.id, {
      workspaceId: bundle.workspace.id,
      voucherType: 'Sales',
      date: '2026-04-03',
      invoiceNumber: 'INV-1',
      partyLedgerId: customer.ledger.id,
      currency: 'INR',
      reverseCharge: false,
      status: 'regular',
      source: 'manual',
      groupIds: [],
      tags: [],
      lines: [makeLineInput(customer.ledger.id, 300_000), makeLineInput(sales.id, -300_000)],
      items: [item(widget.id, '15', 20_000)],
    });

    const report = await stockReport(db, bundle.workspace.id, { asOf: '2026-04-30' });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.openingQuantity).toBe(10);
    expect(row.inwardQuantity).toBe(10);
    expect(row.outwardQuantity).toBe(15);
    expect(row.outwardCostMinor).toBe(160_000);
    expect(row.closingQuantity).toBe(5);
    expect(row.closingValueMinor).toBe(60_000);
    expect(report.totalClosingValueMinor).toBe(60_000);
  });

  it('values weighted-average sales at the running average', async () => {
    const { db, bundle, cash, purchases, sales, customer, supplier, widget } = await setup('weighted-average');
    await post(db, bundle.workspace.id, {
      workspaceId: bundle.workspace.id,
      voucherType: 'Purchase',
      date: '2026-04-02',
      partyLedgerId: supplier.ledger.id,
      currency: 'INR',
      reverseCharge: false,
      status: 'regular',
      source: 'manual',
      groupIds: [],
      tags: [],
      lines: [makeLineInput(purchases.id, 200_000), makeLineInput(cash.id, -200_000)],
      items: [item(widget.id, '10', 20_000)],
    });
    await post(db, bundle.workspace.id, {
      workspaceId: bundle.workspace.id,
      voucherType: 'Sales',
      date: '2026-04-03',
      invoiceNumber: 'INV-2',
      partyLedgerId: customer.ledger.id,
      currency: 'INR',
      reverseCharge: false,
      status: 'regular',
      source: 'manual',
      groupIds: [],
      tags: [],
      lines: [makeLineInput(customer.ledger.id, 150_000), makeLineInput(sales.id, -150_000)],
      items: [item(widget.id, '5', 30_000)],
    });

    const report = await stockReport(db, bundle.workspace.id, { asOf: '2026-04-30' });
    const row = report.rows[0]!;
    expect(row.outwardCostMinor).toBe(75_000);
    expect(row.closingQuantity).toBe(15);
    expect(row.closingValueMinor).toBe(225_000);
  });

  it('uses as-of dates and reports unlinked items', async () => {
    const { db, bundle, cash, purchases, supplier } = await setup('fifo');
    await post(db, bundle.workspace.id, {
      workspaceId: bundle.workspace.id,
      voucherType: 'Purchase',
      date: '2026-04-10',
      partyLedgerId: supplier.ledger.id,
      currency: 'INR',
      reverseCharge: false,
      status: 'regular',
      source: 'manual',
      groupIds: [],
      tags: [],
      lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
      items: [
        {
          description: 'Freight service',
          quantity: '1',
          uom: 'NOS',
          rateMinor: 50_000,
          amountMinor: 50_000,
          discountMinor: 0,
        },
      ],
    });

    const early = await stockReport(db, bundle.workspace.id, { asOf: '2026-04-05' });
    expect(early.movements).toHaveLength(0);
    const later = await stockReport(db, bundle.workspace.id, { asOf: '2026-04-30' });
    expect(later.rows.some((row) => row.name === 'Freight service')).toBe(true);
    expect(later.movements).toHaveLength(1);
  });
});
