import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createLedger } from '@/core/db/ledger-service';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import {
  buildWorkbookSpec,
  isFormulaCell,
  loadWorkbookData,
  renderSheetsValues,
  renderWorkbookXlsx,
  type WorkbookSpec,
} from '@/core/template';
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
    name: 'Template Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
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
      lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
    }),
  );

  await postVoucher(
    db,
    makeNewVoucher({
      workspaceId: bundle.workspace.id,
      voucherType: 'Sales',
      partyLedgerId: customer.ledger.id,
      invoiceNumber: 'INV-1',
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

  const data = await loadWorkbookData(db, bundle.workspace.id);
  return { db, bundle, data, customer };
}

function sheetNamed(spec: WorkbookSpec, name: string) {
  const sheet = spec.sheets.find((item) => item.name === name);
  if (!sheet) throw new Error(`Missing sheet ${name}`);
  return sheet;
}

describe('workbook template spec', () => {
  it('loads data and builds every required tab', async () => {
    const { data } = await seeded();
    const spec = buildWorkbookSpec(data, {
      generatedAt: '2026-11-06T12:00:00.000Z',
      today: '2026-11-06',
    });

    const names = spec.sheets.map((sheet) => sheet.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '_meta',
        '_sync',
        'CoA',
        'Parties',
        'Items',
        'Godowns',
        'Vouchers',
        'VoucherLines',
        'ItemLines',
        'BillAllocations',
        'CostCenters',
        'TaxAllocations',
        'TallyFields',
        'TrialBalance',
        'ProfitAndLoss',
        'BalanceSheet',
        'PartyOutstanding',
        'BillAging',
        'Reconcile',
        'Dashboard',
        'ReadMe',
      ]),
    );
    expect(names.some((name) => name.includes('Ledger'))).toBe(true);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(31);
    expect(new Set(names).size).toBe(names.length);
  });

  it('renders vouchers, lines, balances and bill aging', async () => {
    const { data, bundle } = await seeded();
    const spec = buildWorkbookSpec(data, {
      generatedAt: '2026-11-06T12:00:00.000Z',
      today: '2026-11-06',
    });

    expect(sheetNamed(spec, 'CoA').rows).toHaveLength(bundle.ledgers.length + 1);
    expect(sheetNamed(spec, 'Vouchers').rows).toHaveLength(2);
    expect(sheetNamed(spec, 'VoucherLines').rows).toHaveLength(4);

    const tb = sheetNamed(spec, 'TrialBalance');
    const totalRow = tb.rows.at(-1)!;
    expect(totalRow[1]).toBe('Total');
    expect(isFormulaCell(totalRow[3]!)).toBe(true);

    const pnl = sheetNamed(spec, 'ProfitAndLoss');
    const netProfit = pnl.rows.at(-1)!;
    expect(netProfit[0]).toBe('Net Profit');
    expect(isFormulaCell(netProfit[2]!)).toBe(true);
    if (isFormulaCell(netProfit[2]!)) expect(netProfit[2].result).toBe(500);

    const outstanding = sheetNamed(spec, 'PartyOutstanding');
    expect(outstanding.rows[0]?.[0]).toBe('Customer One');
    expect(outstanding.rows[0]?.[1]).toBe('Debtor');
    expect(outstanding.rows[0]?.[3]).toBe(1_000);

    const aging = sheetNamed(spec, 'BillAging');
    expect(aging.rows[0]?.[0]).toBe('INV/2026-27/0001');
    expect(aging.rows[0]?.[7]).toBe('31-60');
  });

  it('puts cached formulas on summary tabs', async () => {
    const { data } = await seeded();
    const spec = buildWorkbookSpec(data, {
      generatedAt: '2026-11-06T12:00:00.000Z',
      today: '2026-11-06',
    });
    const dashboard = sheetNamed(spec, 'Dashboard');
    const trial = dashboard.rows.find((row) => row[0] === 'Trial balance')!;
    expect(isFormulaCell(trial[1]!)).toBe(true);
    if (isFormulaCell(trial[1]!)) {
      expect(trial[1].formula).toContain('TrialBalance!D2');
      expect(trial[1].result).toBe('Balanced');
    }

    const netProfit = dashboard.rows.find((row) => row[0] === 'Net profit')!;
    expect(isFormulaCell(netProfit[1]!)).toBe(true);
    expect(netProfit[1]).toMatchObject({ result: 500 });
  });

  it('renders Google Sheets values with formula strings', async () => {
    const { data } = await seeded();
    const spec = buildWorkbookSpec(data, {
      generatedAt: '2026-11-06T12:00:00.000Z',
      today: '2026-11-06',
    });
    const sheets = renderSheetsValues(spec);
    const trial = sheets.find((sheet) => sheet.title === 'TrialBalance')!;
    expect(trial.values[0]).toEqual(['Group', 'Ledger', 'Opening', 'Debit', 'Credit', 'Closing']);
    const total = trial.values.at(-1)!;
    expect(total[3]).toMatch(/^=SUM\(D2:D\d+\)$/);
  });

  it('renders a real xlsx workbook', async () => {
    const { data } = await seeded();
    const spec = buildWorkbookSpec(data, {
      generatedAt: '2026-11-06T12:00:00.000Z',
      today: '2026-11-06',
    });
    const buffer = await renderWorkbookXlsx(spec);
    expect(buffer.byteLength).toBeGreaterThan(1_000);

    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(
      spec.sheets.map((sheet) => sheet.name),
    );
    const coa = workbook.getWorksheet('CoA')!;
    expect(coa.getRow(1).getCell(1).value).toBe('Id');
    expect(coa.getRow(1).font?.bold).toBe(true);
    expect(coa.views[0]?.state).toBe('frozen');

    const trial = workbook.getWorksheet('TrialBalance')!;
    let totalRowNumber = 0;
    trial.eachRow((row, rowNumber) => {
      if (row.getCell(2).value === 'Total') totalRowNumber = rowNumber;
    });
    expect(totalRowNumber).toBeGreaterThan(1);
    const formulaCell = trial.getRow(totalRowNumber).getCell(4).value;
    expect(
      typeof formulaCell === 'object' && formulaCell !== null && 'formula' in formulaCell,
    ).toBe(true);
  });
});
