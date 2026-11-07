import type { LedgerDatabase } from '../db/db';
import {
  balanceSheet,
  profitAndLoss,
  trialBalance,
  type BalanceSheet,
  type ProfitAndLoss,
  type TrialBalance,
} from '../ledger/reports';
import type {
  Batch,
  BillAllocation,
  CompanyProfile,
  CostCenter,
  CostCenterAllocation,
  Godown,
  ItemLine,
  Ledger,
  LedgerGroup,
  NumberingScheme,
  Party,
  Reconciliation,
  AuditEvent,
  StatementLine,
  StockItem,
  TaxAllocation,
  Voucher,
  VoucherLine,
  Workspace,
} from '../model';

export interface WorkbookData {
  workspace: Workspace;
  company: CompanyProfile;
  groups: LedgerGroup[];
  ledgers: Ledger[];
  parties: Party[];
  stockItems: StockItem[];
  godowns: Godown[];
  batches: Batch[];
  costCenters: CostCenter[];
  numberingSchemes: NumberingScheme[];
  vouchers: Voucher[];
  voucherLines: VoucherLine[];
  itemLines: ItemLine[];
  billAllocations: BillAllocation[];
  costCenterAllocations: CostCenterAllocation[];
  taxAllocations: TaxAllocation[];
  statementLines: StatementLine[];
  reconciliations: Reconciliation[];
  auditEvents: AuditEvent[];
  trialBalance: TrialBalance;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
}

export async function loadWorkbookData(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<WorkbookData> {
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const company = await db.companies.get(workspace.companyId);
  if (!company) throw new Error(`Company not found for workspace: ${workspaceId}`);

  const [
    groups,
    ledgers,
    parties,
    stockItems,
    godowns,
    batches,
    costCenters,
    numberingSchemes,
    vouchers,
    voucherLines,
    itemLines,
    billAllocations,
    costCenterAllocations,
    taxAllocations,
    statementLines,
    reconciliations,
    auditEvents,
    trialBalanceReport,
    profitAndLossReport,
    balanceSheetReport,
  ] = await Promise.all([
    db.ledgerGroups.where('workspaceId').equals(workspaceId).toArray(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
    db.stockItems.where('workspaceId').equals(workspaceId).toArray(),
    db.godowns.where('workspaceId').equals(workspaceId).toArray(),
    db.batches.where('workspaceId').equals(workspaceId).toArray(),
    db.costCenters.where('workspaceId').equals(workspaceId).toArray(),
    db.numberingSchemes.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
    db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
    db.itemLines.where('workspaceId').equals(workspaceId).toArray(),
    db.billAllocations.where('workspaceId').equals(workspaceId).toArray(),
    db.costCenterAllocations.where('workspaceId').equals(workspaceId).toArray(),
    db.taxAllocations.where('workspaceId').equals(workspaceId).toArray(),
    db.statementLines.where('workspaceId').equals(workspaceId).toArray(),
    db.reconciliations.where('workspaceId').equals(workspaceId).toArray(),
    db.auditEvents.where('workspaceId').equals(workspaceId).toArray(),
    trialBalance(db, workspaceId),
    profitAndLoss(db, workspaceId),
    balanceSheet(db, workspaceId),
  ]);

  return {
    workspace,
    company,
    groups,
    ledgers,
    parties,
    stockItems,
    godowns,
    batches,
    costCenters,
    numberingSchemes,
    vouchers,
    voucherLines,
    itemLines,
    billAllocations,
    costCenterAllocations,
    taxAllocations,
    statementLines,
    reconciliations,
    auditEvents,
    trialBalance: trialBalanceReport,
    profitAndLoss: profitAndLossReport,
    balanceSheet: balanceSheetReport,
  };
}
