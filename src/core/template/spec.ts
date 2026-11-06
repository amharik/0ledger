import { nowIso } from '../ids';
import type { Ledger, Voucher, VoucherLine } from '../model';
import type { WorkbookData } from './data';
import {
  formula,
  type Cell,
  type SheetColumn,
  type SheetSpec,
  type WorkbookSpec,
} from './types';

export interface WorkbookBuildOptions {
  /** Maximum number of per-ledger sheets to include. */
  accountSheetLimit?: number;
  /** Used for bill-aging day counts; defaults to today (ISO date). */
  today?: string;
  generatedAt?: string;
}

function amountColumn(header: string, width = 14): SheetColumn {
  return { header, width, align: 'right', format: 'amount' };
}

function amount(minor: number): number {
  return Number((minor / 100).toFixed(2));
}

function text(value: string | undefined | null): string {
  return value ?? '';
}

function yesNo(value: boolean | undefined): string {
  return value ? 'Yes' : 'No';
}

function hashJson(value: unknown): string {
  const serialized = JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function recordId(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const id = record.id ?? record.key;
    if (typeof id === 'string') return id;
  }
  return '';
}

function recordUpdatedAt(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const updatedAt = (value as Record<string, unknown>).updatedAt;
    if (typeof updatedAt === 'string') return updatedAt;
    const at = (value as Record<string, unknown>).at;
    if (typeof at === 'string') return at;
  }
  return '';
}

function uniqueSheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[\\/?*[\]:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet';
  let candidate = base;
  let counter = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const suffix = ` (${counter})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 86_400_000);
}

function agingBucket(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'Current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

function ledgerStatementRows(
  ledger: Ledger,
  lines: VoucherLine[],
  vouchersById: Map<string, Voucher>,
): Cell[][] {
  const rows: Cell[][] = [
    [
      'Opening',
      '',
      '',
      'Opening balance',
      null,
      null,
      amount(ledger.openingBalanceMinor),
    ],
  ];
  let running = ledger.openingBalanceMinor;
  const ordered = [...lines].sort((a, b) => {
    const voucherA = vouchersById.get(a.voucherId);
    const voucherB = vouchersById.get(b.voucherId);
    return (
      (voucherA?.date ?? '').localeCompare(voucherB?.date ?? '') ||
      (voucherA?.number ?? '').localeCompare(voucherB?.number ?? '') ||
      a.lineNo - b.lineNo
    );
  });
  for (const line of ordered) {
    const voucher = vouchersById.get(line.voucherId);
    if (!voucher) continue;
    const debit = line.amountMinor > 0 ? line.amountMinor : 0;
    const credit = line.amountMinor < 0 ? -line.amountMinor : 0;
    running += line.amountMinor;
    rows.push([
      voucher.date,
      voucher.number,
      voucher.voucherType,
      line.narration ?? voucher.narration ?? '',
      amount(debit),
      amount(credit),
      amount(running),
    ]);
  }
  return rows;
}

export function buildWorkbookSpec(
  data: WorkbookData,
  options: WorkbookBuildOptions = {},
): WorkbookSpec {
  const generatedAt = options.generatedAt ?? nowIso();
  const today = options.today ?? generatedAt.slice(0, 10);
  const usedNames = new Set<string>();
  const sheets: SheetSpec[] = [];

  const ledgerById = new Map(data.ledgers.map((ledger) => [ledger.id, ledger]));
  const partyByLedger = new Map(data.parties.map((party) => [party.ledgerId, party]));
  const vouchersById = new Map(data.vouchers.map((voucher) => [voucher.id, voucher]));
  const regularVouchers = data.vouchers.filter((voucher) => voucher.status === 'regular');
  const regularVoucherIds = new Set(regularVouchers.map((voucher) => voucher.id));

  function addSheet(
    name: string,
    columns: SheetColumn[],
    rows: Cell[][],
    freezeHeader = true,
  ): SheetSpec {
    const sheet: SheetSpec = {
      name: uniqueSheetName(name, usedNames),
      columns,
      rows,
      freezeHeader,
    };
    sheets.push(sheet);
    return sheet;
  }

  addSheet(
    '_meta',
    [
      { header: 'Key', width: 28 },
      { header: 'Value', width: 90 },
    ],
    [
      ['app', '0ledger'],
      ['schemaVersion', 1],
      ['generatedAt', generatedAt],
      ['workspaceId', data.workspace.id],
      ['workspaceSlug', data.workspace.slug],
      ['workspaceName', data.workspace.name],
      ['companyId', data.company.id],
      ['companyLegalName', data.company.legalName],
      ['gstin', text(data.company.gstin)],
      ['state', text(data.company.state)],
      ['currency', data.company.currency],
      ['booksBegin', data.company.booksBegin],
      [
        'manifest',
        JSON.stringify(
          {
            workspaceId: data.workspace.id,
            companyId: data.company.id,
            generatedAt,
            source: '0ledger IndexedDB',
          },
          null,
          2,
        ),
      ],
    ],
  );

  const syncGroups: Array<[string, unknown[]]> = [
    ['workspaces', [data.workspace]],
    ['companies', [data.company]],
    ['ledgerGroups', data.groups],
    ['ledgers', data.ledgers],
    ['parties', data.parties],
    ['stockItems', data.stockItems],
    ['godowns', data.godowns],
    ['batches', data.batches],
    ['costCenters', data.costCenters],
    ['numberingSchemes', data.numberingSchemes],
    ['vouchers', data.vouchers],
    ['voucherLines', data.voucherLines],
    ['itemLines', data.itemLines],
    ['billAllocations', data.billAllocations],
    ['costCenterAllocations', data.costCenterAllocations],
    ['taxAllocations', data.taxAllocations],
    ['statementLines', data.statementLines],
  ];
  const syncRows: Cell[][] = [];
  for (const [table, records] of syncGroups) {
    for (const record of records) {
      syncRows.push([table, recordId(record), hashJson(record), recordUpdatedAt(record)]);
    }
  }
  addSheet(
    '_sync',
    [
      { header: 'Table', width: 24 },
      { header: 'Id', width: 42 },
      { header: 'ContentHash', width: 14 },
      { header: 'UpdatedAt', width: 26 },
    ],
    syncRows,
  );

  addSheet(
    'CoA',
    [
      { header: 'Id', width: 42 },
      { header: 'Code', width: 10 },
      { header: 'Name', width: 30 },
      { header: 'Tally Parent', width: 28 },
      { header: 'Nature', width: 12 },
      { header: 'Party', width: 8 },
      { header: 'Bank', width: 8 },
      { header: 'Tax', width: 8 },
      amountColumn('Opening'),
      { header: 'Opening Date', width: 14 },
      { header: 'Currency', width: 10 },
      { header: 'Bill-wise', width: 10 },
      { header: 'Archived', width: 10 },
    ],
    data.ledgers.map((ledger) => [
      ledger.id,
      text(ledger.code),
      ledger.name,
      ledger.tallyParent,
      ledger.nature,
      yesNo(ledger.isParty),
      yesNo(ledger.isBank),
      yesNo(ledger.isTax),
      amount(ledger.openingBalanceMinor),
      text(ledger.openingBalanceDate),
      ledger.currency,
      yesNo(ledger.billwise),
      yesNo(ledger.archived),
    ]),
  );

  addSheet(
    'Parties',
    [
      { header: 'Id', width: 42 },
      { header: 'Ledger Id', width: 42 },
      { header: 'Ledger', width: 28 },
      { header: 'Type', width: 10 },
      { header: 'Legal Name', width: 30 },
      { header: 'GSTIN', width: 18 },
      { header: 'State', width: 18 },
      { header: 'Email', width: 26 },
      { header: 'Phone', width: 18 },
      { header: 'Credit Days', width: 12 },
      amountColumn('Credit Limit'),
    ],
    data.parties.map((party) => [
      party.id,
      party.ledgerId,
      ledgerById.get(party.ledgerId)?.name ?? '',
      party.type,
      party.legalName,
      text(party.gstin),
      text(party.state),
      text(party.email),
      text(party.phone),
      party.creditPeriodDays ?? null,
      party.creditLimitMinor == null ? null : amount(party.creditLimitMinor),
    ]),
  );

  addSheet(
    'Items',
    [
      { header: 'Id', width: 42 },
      { header: 'Name', width: 28 },
      { header: 'HSN/SAC', width: 12 },
      { header: 'UOM', width: 8 },
      amountColumn('Rate'),
      { header: 'Tax Rate', width: 10 },
      { header: 'Opening Qty', width: 12 },
      amountColumn('Opening Value'),
      { header: 'Valuation', width: 16 },
      { header: 'Archived', width: 10 },
    ],
    data.stockItems.map((item) => [
      item.id,
      item.name,
      text(item.hsnSac),
      item.uom,
      amount(item.rateMinor),
      text(item.taxRate),
      text(item.openingQuantity),
      item.openingValueMinor == null ? null : amount(item.openingValueMinor),
      text(item.valuationMethod),
      yesNo(item.archived),
    ]),
  );

  addSheet(
    'Godowns',
    [
      { header: 'Id', width: 42 },
      { header: 'Name', width: 28 },
      { header: 'Parent Id', width: 42 },
      { header: 'Archived', width: 10 },
    ],
    data.godowns.map((godown) => [
      godown.id,
      godown.name,
      text(godown.parentId),
      yesNo(godown.archived),
    ]),
  );

  addSheet(
    'Vouchers',
    [
      { header: 'Id', width: 42 },
      { header: 'Number', width: 22 },
      { header: 'Type', width: 16 },
      { header: 'Date', width: 12 },
      { header: 'Status', width: 10 },
      { header: 'Source', width: 12 },
      { header: 'Narration', width: 36 },
      { header: 'Party Ledger Id', width: 42 },
      { header: 'Invoice No', width: 18 },
      { header: 'Place Of Supply', width: 16 },
      { header: 'Reverse Charge', width: 14 },
      { header: 'Currency', width: 10 },
      amountColumn('Debit Total'),
      amountColumn('Credit Total'),
      amountColumn('Round Off'),
      { header: 'Round Off Ledger Id', width: 42 },
      { header: 'Created At', width: 26 },
      { header: 'Updated At', width: 26 },
    ],
    data.vouchers.map((voucher) => [
      voucher.id,
      voucher.number,
      voucher.voucherType,
      voucher.date,
      voucher.status,
      voucher.source,
      text(voucher.narration),
      text(voucher.partyLedgerId),
      text(voucher.invoiceNumber),
      text(voucher.placeOfSupply),
      yesNo(voucher.reverseCharge),
      voucher.currency,
      amount(voucher.totalDebitMinor),
      amount(voucher.totalCreditMinor),
      amount(voucher.roundOffAmountMinor),
      text(voucher.roundOffLedgerId),
      voucher.createdAt,
      voucher.updatedAt,
    ]),
  );

  addSheet(
    'VoucherLines',
    [
      { header: 'Id', width: 42 },
      { header: 'Voucher Id', width: 42 },
      { header: 'Line', width: 6 },
      { header: 'Ledger Id', width: 42 },
      { header: 'Ledger', width: 28 },
      amountColumn('Amount'),
      { header: 'Currency', width: 10 },
      { header: 'Narration', width: 36 },
      { header: 'HSN/SAC', width: 12 },
    ],
    data.voucherLines.map((line) => [
      line.id,
      line.voucherId,
      line.lineNo,
      line.ledgerId,
      ledgerById.get(line.ledgerId)?.name ?? '',
      amount(line.amountMinor),
      line.currency,
      text(line.narration),
      text(line.hsnSac),
    ]),
  );

  addSheet(
    'ItemLines',
    [
      { header: 'Id', width: 42 },
      { header: 'Voucher Id', width: 42 },
      { header: 'Line', width: 6 },
      { header: 'Stock Item Id', width: 42 },
      { header: 'Description', width: 30 },
      { header: 'HSN/SAC', width: 12 },
      { header: 'Qty', width: 10 },
      { header: 'UOM', width: 8 },
      amountColumn('Rate'),
      amountColumn('Amount'),
      amountColumn('Discount'),
      { header: 'Godown Id', width: 42 },
      { header: 'Batch Id', width: 42 },
      { header: 'Direction', width: 10 },
    ],
    data.itemLines.map((item) => [
      item.id,
      item.voucherId,
      item.lineNo,
      text(item.stockItemId),
      item.description,
      text(item.hsnSac),
      text(item.quantity),
      text(item.uom),
      item.rateMinor == null ? null : amount(item.rateMinor),
      amount(item.amountMinor),
      amount(item.discountMinor),
      text(item.godownId),
      text(item.batchId),
      text(item.direction),
    ]),
  );

  addSheet(
    'BillAllocations',
    [
      { header: 'Id', width: 42 },
      { header: 'Voucher Id', width: 42 },
      { header: 'Voucher Line Id', width: 42 },
      { header: 'Ledger Id', width: 42 },
      { header: 'Bill Ref', width: 24 },
      { header: 'Bill Type', width: 12 },
      amountColumn('Amount'),
      { header: 'Due Date', width: 12 },
      { header: 'Credit Days', width: 12 },
    ],
    data.billAllocations.map((bill) => [
      bill.id,
      bill.voucherId,
      bill.voucherLineId,
      bill.ledgerId,
      bill.billRef,
      bill.billType,
      amount(bill.amountMinor),
      text(bill.dueDate),
      bill.creditDays ?? null,
    ]),
  );

  addSheet(
    'CostCenters',
    [
      { header: 'Id', width: 42 },
      { header: 'Name', width: 28 },
      { header: 'Category', width: 16 },
      { header: 'Parent Id', width: 42 },
      { header: 'Revenue', width: 10 },
      { header: 'Archived', width: 10 },
    ],
    data.costCenters.map((costCenter) => [
      costCenter.id,
      costCenter.name,
      costCenter.category,
      text(costCenter.parentId),
      yesNo(costCenter.revenue),
      yesNo(costCenter.archived),
    ]),
  );

  addSheet(
    'TaxAllocations',
    [
      { header: 'Id', width: 42 },
      { header: 'Voucher Id', width: 42 },
      { header: 'Voucher Line Id', width: 42 },
      { header: 'Ledger Id', width: 42 },
      { header: 'Tax Type', width: 12 },
      amountColumn('Amount'),
      amountColumn('Taxable Value'),
      { header: 'Rate', width: 8 },
      { header: 'HSN/SAC', width: 12 },
      { header: 'TDS Section', width: 12 },
    ],
    data.taxAllocations.map((tax) => [
      tax.id,
      tax.voucherId,
      text(tax.voucherLineId),
      text(tax.ledgerId),
      tax.taxType,
      amount(tax.amountMinor),
      tax.taxableValueMinor == null ? null : amount(tax.taxableValueMinor),
      text(tax.rate),
      text(tax.hsnSac),
      text(tax.tdsSection),
    ]),
  );

  addSheet(
    'TallyFields',
    [
      { header: 'Voucher Id', width: 42 },
      { header: 'Number', width: 22 },
      { header: 'Type', width: 16 },
      { header: 'Tally JSON', width: 100 },
    ],
    data.vouchers
      .filter((voucher) => voucher.tally)
      .map((voucher) => [
        voucher.id,
        voucher.number,
        voucher.voucherType,
        JSON.stringify(voucher.tally),
      ]),
  );

  const tbRows: Cell[][] = data.trialBalance.rows.map((row) => [
    row.tallyParent,
    row.name,
    amount(row.openingMinor),
    amount(row.debitMinor),
    amount(row.creditMinor),
    amount(row.closingMinor),
  ]);
  const tbEnd = tbRows.length + 1;
  addSheet(
    'TrialBalance',
    [
      { header: 'Group', width: 28 },
      { header: 'Ledger', width: 30 },
      amountColumn('Opening'),
      amountColumn('Debit'),
      amountColumn('Credit'),
      amountColumn('Closing'),
    ],
    [
      ...tbRows,
      [
        '',
        'Total',
        formula(`=SUM(C2:C${tbEnd})`, amount(data.trialBalance.totalOpeningMinor)),
        formula(`=SUM(D2:D${tbEnd})`, amount(data.trialBalance.totalDebitMinor)),
        formula(`=SUM(E2:E${tbEnd})`, amount(data.trialBalance.totalCreditMinor)),
        formula(`=SUM(F2:F${tbEnd})`, 0),
      ],
    ],
  );

  const pnlRows: Cell[][] = [
    ...data.profitAndLoss.income.map((row) => [
      'Income',
      row.name,
      amount(row.amountMinor),
    ] as Cell[]),
    ...data.profitAndLoss.expenses.map((row) => [
      'Expense',
      row.name,
      amount(row.amountMinor),
    ] as Cell[]),
  ];
  const pnlEnd = pnlRows.length + 1;
  const totalIncomeRow = pnlEnd + 1;
  const totalExpenseRow = pnlEnd + 2;
  const netProfitRow = pnlEnd + 3;
  addSheet(
    'ProfitAndLoss',
    [
      { header: 'Type', width: 14 },
      { header: 'Ledger', width: 30 },
      amountColumn('Amount'),
    ],
    [
      ...pnlRows,
      [
        'Total Income',
        '',
        formula(
          `=SUMIF(A2:A${pnlEnd},"Income",C2:C${pnlEnd})`,
          amount(data.profitAndLoss.totalIncomeMinor),
        ),
      ],
      [
        'Total Expense',
        '',
        formula(
          `=SUMIF(A2:A${pnlEnd},"Expense",C2:C${pnlEnd})`,
          amount(data.profitAndLoss.totalExpenseMinor),
        ),
      ],
      [
        'Net Profit',
        '',
        formula(`=C${totalIncomeRow}-C${totalExpenseRow}`, amount(data.profitAndLoss.netProfitMinor)),
      ],
    ],
  );

  const bsRows: Cell[][] = [
    ...data.balanceSheet.assets.map((row) => ['Asset', row.name, amount(row.amountMinor)] as Cell[]),
    ...data.balanceSheet.liabilities.map((row) => [
      'Liability',
      row.name,
      amount(row.amountMinor),
    ] as Cell[]),
    ...data.balanceSheet.equity.map((row) => ['Equity', row.name, amount(row.amountMinor)] as Cell[]),
  ];
  if (data.balanceSheet.netProfitMinor !== 0) {
    bsRows.push(['Equity', 'Current Period Profit', amount(data.balanceSheet.netProfitMinor)]);
  }
  const bsEnd = bsRows.length + 1;
  const totalAssetsRow = bsEnd + 1;
  const totalLiabilitiesRow = bsEnd + 2;
  const totalEquityRow = bsEnd + 3;
  addSheet(
    'BalanceSheet',
    [
      { header: 'Side', width: 12 },
      { header: 'Ledger', width: 30 },
      amountColumn('Amount'),
    ],
    [
      ...bsRows,
      [
        'Asset Total',
        '',
        formula(
          `=SUMIF(A2:A${bsEnd},"Asset",C2:C${bsEnd})`,
          amount(data.balanceSheet.totalAssetsMinor),
        ),
      ],
      [
        'Liability Total',
        '',
        formula(
          `=SUMIF(A2:A${bsEnd},"Liability",C2:C${bsEnd})`,
          amount(data.balanceSheet.totalLiabilitiesMinor),
        ),
      ],
      [
        'Equity Total',
        '',
        formula(
          `=SUMIF(A2:A${bsEnd},"Equity",C2:C${bsEnd})`,
          amount(data.balanceSheet.totalEquityMinor + data.balanceSheet.netProfitMinor),
        ),
      ],
      [
        'Check',
        '',
        formula(
          `=IF(ROUND(C${totalAssetsRow}-C${totalLiabilitiesRow}-C${totalEquityRow},2)=0,"Balanced","Check")`,
          data.balanceSheet.balanced ? 'Balanced' : 'Check',
        ),
      ],
    ],
  );

  const outstandingRows: Cell[][] = data.ledgers
    .filter((ledger) => ledger.isParty || partyByLedger.has(ledger.id))
    .map((ledger) => {
      const party = partyByLedger.get(ledger.id);
      const tbRow = data.trialBalance.rows.find((row) => row.ledgerId === ledger.id);
      const closing = tbRow?.closingMinor ?? 0;
      const type = party?.type === 'creditor' ? 'Creditor' : 'Debtor';
      return [
        party?.legalName ?? ledger.name,
        type,
        ledger.name,
        amount(Math.abs(closing)),
        closing === 0 ? 'Settled' : 'Open',
      ] satisfies Cell[];
    });
  const poEnd = outstandingRows.length + 1;
  addSheet(
    'PartyOutstanding',
    [
      { header: 'Party', width: 30 },
      { header: 'Type', width: 10 },
      { header: 'Ledger', width: 28 },
      amountColumn('Outstanding'),
      { header: 'Status', width: 10 },
    ],
    outstandingRows,
  );

  const billRows: Cell[][] = data.billAllocations.map((bill) => {
    const voucher = vouchersById.get(bill.voucherId);
    const party = voucher?.partyLedgerId
      ? ledgerById.get(voucher.partyLedgerId)?.name ?? ''
      : '';
    const daysOverdue = bill.dueDate ? daysBetween(bill.dueDate, today) : null;
    return [
      voucher?.number ?? '',
      party,
      bill.billRef,
      bill.billType,
      text(bill.dueDate),
      amount(bill.amountMinor),
      daysOverdue,
      daysOverdue == null ? 'No due date' : agingBucket(daysOverdue),
    ] satisfies Cell[];
  });
  addSheet(
    'BillAging',
    [
      { header: 'Voucher', width: 22 },
      { header: 'Party', width: 28 },
      { header: 'Bill Ref', width: 22 },
      { header: 'Type', width: 10 },
      { header: 'Due Date', width: 12 },
      amountColumn('Amount'),
      { header: 'Days Overdue', width: 12, align: 'right' },
      { header: 'Bucket', width: 12 },
    ],
    billRows,
  );

  addSheet(
    'Reconcile',
    [
      { header: 'Statement Line Id', width: 42 },
      { header: 'Date', width: 12 },
      { header: 'Description', width: 36 },
      { header: 'Reference', width: 20 },
      amountColumn('Debit'),
      amountColumn('Credit'),
      { header: 'Match Status', width: 14 },
      { header: 'Voucher Id', width: 42 },
      { header: 'Confidence', width: 10 },
    ],
    data.statementLines.map((line) => [
      line.id,
      line.date,
      line.description,
      text(line.reference),
      amount(line.debitMinor),
      amount(line.creditMinor),
      line.matchStatus,
      text(line.matchedVoucherId),
      line.matchConfidence ?? null,
    ]),
  );

  const linesByLedger = new Map<string, VoucherLine[]>();
  for (const line of data.voucherLines) {
    if (!regularVoucherIds.has(line.voucherId)) continue;
    const list = linesByLedger.get(line.ledgerId) ?? [];
    list.push(line);
    linesByLedger.set(line.ledgerId, list);
  }
  const accountLedgers = data.ledgers
    .filter((ledger) => ledger.openingBalanceMinor !== 0 || linesByLedger.has(ledger.id))
    .sort((a, b) => {
      const aCount = linesByLedger.get(a.id)?.length ?? 0;
      const bCount = linesByLedger.get(b.id)?.length ?? 0;
      return bCount - aCount || a.name.localeCompare(b.name);
    })
    .slice(0, options.accountSheetLimit ?? 12);

  for (const ledger of accountLedgers) {
    addSheet(`${ledger.name} — Ledger`, [
      { header: 'Date', width: 12 },
      { header: 'Voucher', width: 22 },
      { header: 'Type', width: 14 },
      { header: 'Narration', width: 36 },
      amountColumn('Debit'),
      amountColumn('Credit'),
      amountColumn('Balance'),
    ], ledgerStatementRows(ledger, linesByLedger.get(ledger.id) ?? [], vouchersById));
  }

  addSheet(
    'Dashboard',
    [
      { header: 'Metric', width: 28 },
      { header: 'Value', width: 22, align: 'right' },
      { header: 'Notes', width: 50 },
    ],
    [
      ['Workspace', data.workspace.name, data.workspace.slug],
      ['Company', data.company.legalName, text(data.company.gstin)],
      ['Currency', data.company.currency, `Books begin ${data.company.booksBegin}`],
      ['Ledger accounts', data.ledgers.length, 'Chart of accounts'],
      ['Parties', data.parties.length, 'Debtor and creditor masters'],
      ['Vouchers', data.vouchers.length, 'All statuses'],
      [
        'Total debits',
        formula(
          `=SUM(TrialBalance!D2:D${tbEnd})`,
          amount(data.trialBalance.totalDebitMinor),
        ),
        'From TrialBalance',
      ],
      [
        'Total credits',
        formula(
          `=SUM(TrialBalance!E2:E${tbEnd})`,
          amount(data.trialBalance.totalCreditMinor),
        ),
        'From TrialBalance',
      ],
      [
        'Trial balance',
        formula(
          `=IF(ROUND(SUM(TrialBalance!D2:D${tbEnd})-SUM(TrialBalance!E2:E${tbEnd}),2)=0,"Balanced","Unbalanced")`,
          data.trialBalance.balanced ? 'Balanced' : 'Unbalanced',
        ),
        'Debits less credits',
      ],
      [
        'Net profit',
        formula(
          `=SUMIF(ProfitAndLoss!A2:A${pnlEnd},"Income",ProfitAndLoss!C2:C${pnlEnd})-SUMIF(ProfitAndLoss!A2:A${pnlEnd},"Expense",ProfitAndLoss!C2:C${pnlEnd})`,
          amount(data.profitAndLoss.netProfitMinor),
        ),
        'From ProfitAndLoss',
      ],
      [
        'Total assets',
        formula(
          `=SUMIF(BalanceSheet!A2:A${bsEnd},"Asset",BalanceSheet!C2:C${bsEnd})`,
          amount(data.balanceSheet.totalAssetsMinor),
        ),
        'From BalanceSheet',
      ],
      [
        'Total liabilities',
        formula(
          `=SUMIF(BalanceSheet!A2:A${bsEnd},"Liability",BalanceSheet!C2:C${bsEnd})`,
          amount(data.balanceSheet.totalLiabilitiesMinor),
        ),
        'From BalanceSheet',
      ],
      [
        'Receivables',
        formula(
          `=SUMIF(PartyOutstanding!B2:B${poEnd},"Debtor",PartyOutstanding!D2:D${poEnd})`,
          amount(
            data.trialBalance.rows
              .filter((row) => {
                const ledger = ledgerById.get(row.ledgerId);
                const party = ledger ? partyByLedger.get(ledger.id) : undefined;
                return party?.type === 'debtor' && row.closingMinor > 0;
              })
              .reduce((sum, row) => sum + row.closingMinor, 0),
          ),
        ),
        'Open debtor balances',
      ],
      [
        'Payables',
        formula(
          `=SUMIF(PartyOutstanding!B2:B${poEnd},"Creditor",PartyOutstanding!D2:D${poEnd})`,
          amount(
            data.trialBalance.rows
              .filter((row) => {
                const ledger = ledgerById.get(row.ledgerId);
                const party = ledger ? partyByLedger.get(ledger.id) : undefined;
                return party?.type === 'creditor' && row.closingMinor < 0;
              })
              .reduce((sum, row) => sum + -row.closingMinor, 0),
          ),
        ),
        'Open creditor balances',
      ],
      ['Generated at', generatedAt, 'Local time (ISO-8601 UTC)'],
    ],
  );

  addSheet(
    'ReadMe',
    [
      { header: '0ledger workbook', width: 110 },
    ],
    [
      ['This workbook is a mirror. IndexedDB on your machine is the source of truth.'],
      ['Use the 0ledger extension to post vouchers, reconcile, and export; avoid editing ids.'],
      ['_meta holds the identity manifest. _sync holds row ids and content hashes.'],
      ['Amounts are decimal INR from integer paise in the local ledger; round-off is explicit.'],
      ['Google Sheets mirrors are plaintext in Google Drive by design.'],
      ['TallyFields preserves Tally-only data for later XML export.'],
      ['BillAging lists open bill allocations; settlement matching arrives with reconciliation.'],
    ],
  );

  return {
    title: `${data.company.legalName} — Ledger`,
    generatedAt,
    sheets,
  };
}
