import { sumMinor } from '../money/money';
import type { Ledger, LedgerNature, Voucher, VoucherLine } from '../model';
import type { LedgerDatabase } from '../db/db';

export interface TrialBalanceRow {
  ledgerId: string;
  name: string;
  tallyParent: string;
  nature: LedgerNature;
  openingMinor: number;
  debitMinor: number;
  creditMinor: number;
  closingMinor: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalOpeningMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
}

export async function trialBalance(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<TrialBalance> {
  const [ledgers, vouchers, lines] = await Promise.all([
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
    db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  const postedVoucherIds = new Set(
    vouchers.filter((voucher) => voucher.status === 'regular').map((voucher) => voucher.id),
  );
  const sums = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    if (!postedVoucherIds.has(line.voucherId)) continue;
    const entry = sums.get(line.ledgerId) ?? { debit: 0, credit: 0 };
    if (line.amountMinor >= 0) entry.debit += line.amountMinor;
    else entry.credit += -line.amountMinor;
    sums.set(line.ledgerId, entry);
  }

  const rows: TrialBalanceRow[] = ledgers
    .map((ledger) => {
      const entry = sums.get(ledger.id) ?? { debit: 0, credit: 0 };
      return {
        ledgerId: ledger.id,
        name: ledger.name,
        tallyParent: ledger.tallyParent,
        nature: ledger.nature,
        openingMinor: ledger.openingBalanceMinor,
        debitMinor: entry.debit,
        creditMinor: entry.credit,
        closingMinor: ledger.openingBalanceMinor + entry.debit - entry.credit,
      };
    })
    .sort((a, b) => a.tallyParent.localeCompare(b.tallyParent) || a.name.localeCompare(b.name));

  const totalOpeningMinor = sumMinor(rows.map((row) => row.openingMinor));
  const totalDebitMinor = sumMinor(rows.map((row) => (row.closingMinor > 0 ? row.closingMinor : 0)));
  const totalCreditMinor = sumMinor(
    rows.map((row) => (row.closingMinor < 0 ? -row.closingMinor : 0)),
  );

  return {
    rows,
    totalOpeningMinor,
    totalDebitMinor,
    totalCreditMinor,
    balanced: totalDebitMinor === totalCreditMinor,
  };
}

export interface ProfitAndLossRow {
  ledgerId: string;
  name: string;
  nature: 'income' | 'expense';
  amountMinor: number;
}

export interface ProfitAndLoss {
  income: ProfitAndLossRow[];
  expenses: ProfitAndLossRow[];
  totalIncomeMinor: number;
  totalExpenseMinor: number;
  netProfitMinor: number;
}

export async function profitAndLoss(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ProfitAndLoss> {
  const tb = await trialBalance(db, workspaceId);
  const income: ProfitAndLossRow[] = [];
  const expenses: ProfitAndLossRow[] = [];

  for (const row of tb.rows) {
    if (row.nature === 'income') {
      const amount = -row.closingMinor;
      if (amount !== 0) {
        income.push({ ledgerId: row.ledgerId, name: row.name, nature: 'income', amountMinor: amount });
      }
    } else if (row.nature === 'expense') {
      const amount = row.closingMinor;
      if (amount !== 0) {
        expenses.push({
          ledgerId: row.ledgerId,
          name: row.name,
          nature: 'expense',
          amountMinor: amount,
        });
      }
    }
  }

  const totalIncomeMinor = sumMinor(income.map((row) => row.amountMinor));
  const totalExpenseMinor = sumMinor(expenses.map((row) => row.amountMinor));
  return {
    income,
    expenses,
    totalIncomeMinor,
    totalExpenseMinor,
    netProfitMinor: totalIncomeMinor - totalExpenseMinor,
  };
}

export interface BalanceSheetRow {
  ledgerId: string;
  name: string;
  nature: 'asset' | 'liability' | 'equity';
  amountMinor: number;
}

export interface BalanceSheetSide {
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
}

export interface BalanceSheet extends BalanceSheetSide {
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  netProfitMinor: number;
  balanced: boolean;
}

export async function balanceSheet(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<BalanceSheet> {
  const [tb, pnl] = await Promise.all([
    trialBalance(db, workspaceId),
    profitAndLoss(db, workspaceId),
  ]);
  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];

  for (const row of tb.rows) {
    if (row.closingMinor === 0) continue;
    if (row.nature === 'asset') {
      assets.push({
        ledgerId: row.ledgerId,
        name: row.name,
        nature: 'asset',
        amountMinor: row.closingMinor,
      });
    } else if (row.nature === 'liability') {
      liabilities.push({
        ledgerId: row.ledgerId,
        name: row.name,
        nature: 'liability',
        amountMinor: -row.closingMinor,
      });
    } else if (row.nature === 'equity') {
      equity.push({
        ledgerId: row.ledgerId,
        name: row.name,
        nature: 'equity',
        amountMinor: -row.closingMinor,
      });
    }
  }

  const totalAssetsMinor = sumMinor(assets.map((row) => row.amountMinor));
  const totalLiabilitiesMinor = sumMinor(liabilities.map((row) => row.amountMinor));
  const totalEquityMinor = sumMinor(equity.map((row) => row.amountMinor));
  const netProfitMinor = pnl.netProfitMinor;

  return {
    assets,
    liabilities,
    equity,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor,
    netProfitMinor,
    balanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor + netProfitMinor,
  };
}

export interface LedgerStatementRow {
  voucherId: string;
  date: string;
  voucherType: string;
  number: string;
  narration: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export async function ledgerStatement(
  db: LedgerDatabase,
  workspaceId: string,
  ledgerId: string,
): Promise<LedgerStatementRow[]> {
  const [ledger, lines, vouchers] = await Promise.all([
    db.ledgers.get(ledgerId),
    db.voucherLines.where('[workspaceId+ledgerId]').equals([workspaceId, ledgerId]).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  if (!ledger) throw new Error(`Ledger not found: ${ledgerId}`);
  const postedVouchers = vouchers.filter((voucher) => voucher.status === 'regular');
  const voucherById = new Map(postedVouchers.map((voucher) => [voucher.id, voucher]));

  const rows = lines
    .filter((line: VoucherLine) => voucherById.has(line.voucherId))
    .map((line: VoucherLine) => {
      const voucher = voucherById.get(line.voucherId);
      return {
        voucherId: line.voucherId,
        date: voucher?.date ?? '',
        voucherType: voucher?.voucherType ?? '',
        number: voucher?.number ?? '',
        narration: line.narration ?? voucher?.narration ?? '',
        debitMinor: line.amountMinor > 0 ? line.amountMinor : 0,
        creditMinor: line.amountMinor < 0 ? -line.amountMinor : 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));

  let running = ledger.openingBalanceMinor;
  return rows.map((row) => {
    running += row.debitMinor - row.creditMinor;
    return { ...row, balanceMinor: running };
  });
}

export async function vouchersInPeriod(
  db: LedgerDatabase,
  workspaceId: string,
  from: string,
  to: string,
): Promise<Voucher[]> {
  return db.vouchers
    .where('[workspaceId+date]')
    .between([workspaceId, from], [workspaceId, to], true, true)
    .toArray();
}

export function ledgerDisplay(ledger: Ledger): string {
  return ledger.readableName || ledger.name;
}

export interface PartyOutstandingRow {
  partyLedgerId: string;
  ledgerId: string;
  partyName: string;
  type: 'debtor' | 'creditor' | 'both';
  balanceMinor: number;
  outstandingMinor: number;
  billCount: number;
}

export async function partyOutstanding(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<PartyOutstandingRow[]> {
  const [tb, ledgers, parties, bills, vouchers] = await Promise.all([
    trialBalance(db, workspaceId),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
    db.billAllocations.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  const ledgerById = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
  const partyByLedger = new Map(parties.map((party) => [party.ledgerId, party]));
  const regularVoucherIds = new Set(
    vouchers.filter((voucher) => voucher.status === 'regular').map((voucher) => voucher.id),
  );
  const billCounts = new Map<string, number>();
  for (const bill of bills) {
    if (!regularVoucherIds.has(bill.voucherId)) continue;
    billCounts.set(bill.ledgerId, (billCounts.get(bill.ledgerId) ?? 0) + 1);
  }

  return tb.rows
    .map((row): PartyOutstandingRow | undefined => {
      const ledger = ledgerById.get(row.ledgerId);
      if (!ledger || (!ledger.isParty && !partyByLedger.has(ledger.id))) return undefined;
      const party = partyByLedger.get(ledger.id);
      const type = party?.type ?? (ledger.nature === 'asset' ? 'debtor' : 'creditor');
      const outstanding =
        type === 'creditor' ? Math.max(0, -row.closingMinor) : Math.max(0, row.closingMinor);
      return {
        partyLedgerId: ledger.id,
        ledgerId: ledger.id,
        partyName: ledger.name,
        type,
        balanceMinor: row.closingMinor,
        outstandingMinor: outstanding,
        billCount: billCounts.get(ledger.id) ?? 0,
      };
    })
    .filter((row): row is PartyOutstandingRow => row !== undefined)
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor || a.partyName.localeCompare(b.partyName));
}

export type AgingBucket = 'current' | '1-15' | '16-30' | '31-60' | '61-90' | '90+';

export interface BillAgingRow {
  ledgerId: string;
  partyName: string;
  billRef: string;
  invoiceVoucherId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  originalMinor: number;
  settledMinor: number;
  outstandingMinor: number;
  daysOverdue: number;
  bucket: AgingBucket;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000);
}

export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 15) return '1-15';
  if (daysOverdue <= 30) return '16-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

export async function billAging(
  db: LedgerDatabase,
  workspaceId: string,
  asOf = new Date().toISOString().slice(0, 10),
): Promise<BillAgingRow[]> {
  const [bills, vouchers, ledgers] = await Promise.all([
    db.billAllocations.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  const voucherById = new Map(
    vouchers.filter((voucher) => voucher.status === 'regular').map((voucher) => [voucher.id, voucher]),
  );
  const ledgerById = new Map(ledgers.map((ledger) => [ledger.id, ledger]));

  interface BucketState {
    ledgerId: string;
    billRef: string;
    invoice?: Voucher;
    originalMinor: number;
    settledMinor: number;
    dueDate?: string;
  }
  const groups = new Map<string, BucketState>();

  for (const allocation of bills) {
    const voucher = voucherById.get(allocation.voucherId);
    if (!voucher) continue;
    const key = `${allocation.ledgerId}\u0000${allocation.billRef}`;
    const state =
      groups.get(key) ??
      ({
        ledgerId: allocation.ledgerId,
        billRef: allocation.billRef,
        originalMinor: 0,
        settledMinor: 0,
      } satisfies BucketState);

    if (allocation.billType === 'Against Ref') {
      state.settledMinor += Math.abs(allocation.amountMinor);
    } else if (allocation.billType === 'New Ref' || allocation.billType === 'Advance') {
      state.originalMinor += Math.abs(allocation.amountMinor);
      if (!state.invoice) state.invoice = voucher;
      const due =
        allocation.dueDate ??
        (allocation.creditDays != null
          ? addDays(voucher.date, allocation.creditDays)
          : voucher.dueDate);
      if (due) state.dueDate = due;
    }
    groups.set(key, state);
  }

  return [...groups.values()]
    .map((state): BillAgingRow | undefined => {
      const outstanding = Math.max(0, state.originalMinor - state.settledMinor);
      if (outstanding === 0) return undefined;
      const ledger = ledgerById.get(state.ledgerId);
      const invoice = state.invoice;
      const dueDate = state.dueDate ?? invoice?.dueDate ?? invoice?.date ?? asOf;
      const daysOverdue = Math.max(0, daysBetween(dueDate, asOf));
      return {
        ledgerId: state.ledgerId,
        partyName: ledger?.name ?? state.ledgerId,
        billRef: state.billRef,
        invoiceVoucherId: invoice?.id ?? '',
        invoiceNumber: invoice?.number ?? '',
        invoiceDate: invoice?.date ?? '',
        dueDate,
        originalMinor: state.originalMinor,
        settledMinor: state.settledMinor,
        outstandingMinor: outstanding,
        daysOverdue,
        bucket: agingBucket(daysOverdue),
      };
    })
    .filter((row): row is BillAgingRow => row !== undefined)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.partyName.localeCompare(b.partyName));
}
