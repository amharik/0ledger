import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createLedger } from '@/core/db/ledger-service';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import {
  exportBeancount,
  exportOfx,
  exportTallyMasters,
  exportTallyVouchers,
  exportTallyXml,
  importBeancount,
  importTallyXml,
  trialBalanceCsv,
  voucherLinesCsv,
} from '@/core/interchange';
import { loadWorkbookData } from '@/core/template';
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
  const bundle = await createWorkspace(db, {
    name: 'Interchange Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
  const bank = bundle.ledgers.find((ledger) => ledger.name === 'Bank Account')!;
  const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
  const sales = bundle.ledgers.find((ledger) => ledger.name === 'Sales')!;
  const debtors = bundle.groups.find((group) => group.name === 'Sundry Debtors')!;
  const customer = await createLedger(db, {
    workspaceId: bundle.workspace.id,
    name: 'Customer One',
    groupId: debtors.id,
  });

  await postVoucher(
    db,
    makeNewVoucher({
      workspaceId: bundle.workspace.id,
      date: '2026-04-01',
      lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
    }),
  );
  await postVoucher(
    db,
    makeNewVoucher({
      workspaceId: bundle.workspace.id,
      voucherType: 'Sales',
      date: '2026-04-02',
      partyLedgerId: customer.ledger.id,
      invoiceNumber: 'INV-1',
      lines: [
        {
          ...makeLineInput(customer.ledger.id, 100_000),
          billAllocations: [
            { billRef: 'INV-1', billType: 'New Ref', amountMinor: 100_000, dueDate: '2026-05-01' },
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
      date: '2026-04-03',
      lines: [makeLineInput(bank.id, 75_000), makeLineInput(customer.ledger.id, -75_000)],
    }),
  );

  return { db, bundle, data: await loadWorkbookData(db, bundle.workspace.id), bank };
}

describe('CSV export', () => {
  it('writes voucher lines and a trial balance', async () => {
    const { data } = await seeded();
    const csv = voucherLinesCsv(data);
    expect(csv).toContain('Date,Voucher Type,Number');
    expect(csv).toContain('Customer One');
    expect(csv).toContain('500.00');
    const tb = trialBalanceCsv(data);
    expect(tb).toContain('Ledger,Opening,Debit,Credit,Closing');
    expect(tb).toContain('Total');
  });
});

describe('OFX export', () => {
  it('writes bank statement transactions', async () => {
    const { data, bank } = await seeded();
    const ofx = exportOfx(data, { bankLedgerId: bank.id });
    expect(ofx).toContain('OFXHEADER:100');
    expect(ofx).toContain('<ACCTID>');
    expect(ofx).toContain('<STMTTRN>');
    expect(ofx).toContain('<TRNAMT>750.00</TRNAMT>');
  });
});

describe('Beancount export/import', () => {
  it('round-trips vouchers into a fresh workspace', async () => {
    const { data } = await seeded();
    const text = exportBeancount(data);
    expect(text).toContain('option "operating_currency" "INR"');
    expect(text).toContain('Assets:Bank:Bank-Account');
    expect(text).toContain('Income:Sales');

    const db = newDb();
    const targetBundle = await createWorkspace(db, {
      name: 'Beancount Target 2',
      state: 'Karnataka',
      booksBegin: '2026-04-01',
    });
    const result = await importBeancount(db, targetBundle.workspace.id, text);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(3);
    const imported = await db.vouchers.where('workspaceId').equals(targetBundle.workspace.id).toArray();
    expect(imported).toHaveLength(3);
    expect(imported.some((voucher) => voucher.voucherType === 'Sales')).toBe(true);
  });

  it('skips duplicate imports using source references', async () => {
    const { data } = await seeded();
    const text = exportBeancount(data);
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Dedupe Co' });
    const first = await importBeancount(db, bundle.workspace.id, text);
    const second = await importBeancount(db, bundle.workspace.id, text);
    expect(first.imported).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(first.imported);
  });
});

describe('Tally export/import', () => {
  it('exports masters and vouchers', async () => {
    const { data } = await seeded();
    const masters = exportTallyMasters(data);
    const vouchers = exportTallyVouchers(data);
    expect(masters).toContain('<REPORTNAME>All Masters</REPORTNAME>');
    expect(masters).toContain('<LEDGER NAME="Cash" ACTION="Create">');
    expect(vouchers).toContain('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>');
    expect(vouchers).toContain('<BILLALLOCATIONS.LIST>');
  });

  it('round-trips vouchers into a fresh workspace', async () => {
    const { data } = await seeded();
    const xml = exportTallyXml(data);
    const db = newDb();
    const target = await createWorkspace(db, {
      name: 'Tally Target',
      state: 'Karnataka',
      booksBegin: '2026-04-01',
    });
    const result = await importTallyXml(db, target.workspace.id, xml);
    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(3);
    const vouchers = await db.vouchers.where('workspaceId').equals(target.workspace.id).toArray();
    expect(vouchers).toHaveLength(3);
    const sales = vouchers.find((voucher) => voucher.voucherType === 'Sales')!;
    expect(sales.invoiceNumber).toBe('INV-1');
    const allocations = await db.billAllocations.where('voucherId').equals(sales.id).toArray();
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.billRef).toBe('INV-1');

    const second = await importTallyXml(db, target.workspace.id, xml);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });
});
