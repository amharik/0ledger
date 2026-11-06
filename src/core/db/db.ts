import Dexie, { type Table } from 'dexie';
import type {
  Attachment,
  AuditEvent,
  Batch,
  BillAllocation,
  CompanyProfile,
  CostCenter,
  CostCenterAllocation,
  DriveLink,
  Godown,
  ImportBatch,
  ItemLine,
  Ledger,
  LedgerGroup,
  NumberingScheme,
  Party,
  StatementLine,
  StockItem,
  TaxAllocation,
  Voucher,
  VoucherLine,
  Workspace,
} from '../model';

export const DB_NAME = '0ledger';
export const DB_VERSION = 1;

export interface KeyValue {
  key: string;
  value: unknown;
}

export class LedgerDatabase extends Dexie {
  workspaces!: Table<Workspace, string>;
  companies!: Table<CompanyProfile, string>;
  ledgerGroups!: Table<LedgerGroup, string>;
  ledgers!: Table<Ledger, string>;
  parties!: Table<Party, string>;
  stockItems!: Table<StockItem, string>;
  godowns!: Table<Godown, string>;
  batches!: Table<Batch, string>;
  costCenters!: Table<CostCenter, string>;
  numberingSchemes!: Table<NumberingScheme, string>;
  vouchers!: Table<Voucher, string>;
  voucherLines!: Table<VoucherLine, string>;
  itemLines!: Table<ItemLine, string>;
  billAllocations!: Table<BillAllocation, string>;
  costCenterAllocations!: Table<CostCenterAllocation, string>;
  taxAllocations!: Table<TaxAllocation, string>;
  attachments!: Table<Attachment, string>;
  importBatches!: Table<ImportBatch, string>;
  statementLines!: Table<StatementLine, string>;
  auditEvents!: Table<AuditEvent, string>;
  driveLinks!: Table<DriveLink, string>;
  syncState!: Table<KeyValue, string>;
  settings!: Table<KeyValue, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(DB_VERSION).stores({
      workspaces: 'id, slug, companyId, archived',
      companies: 'id, workspaceId',
      ledgerGroups: 'id, workspaceId, [workspaceId+name]',
      ledgers:
        'id, workspaceId, [workspaceId+name], [workspaceId+tallyParent], isParty, isBank, isTax, archived',
      parties: 'id, workspaceId, ledgerId, [workspaceId+type]',
      stockItems: 'id, workspaceId, [workspaceId+name]',
      godowns: 'id, workspaceId, [workspaceId+name]',
      batches: 'id, workspaceId, stockItemId',
      costCenters: 'id, workspaceId, [workspaceId+name]',
      numberingSchemes: 'id, workspaceId, [workspaceId+voucherType]',
      vouchers:
        'id, workspaceId, date, [workspaceId+date], [workspaceId+voucherType], [workspaceId+number], status, source, createdAt',
      voucherLines:
        'id, voucherId, workspaceId, ledgerId, [voucherId+lineNo], [workspaceId+ledgerId]',
      itemLines: 'id, voucherId, workspaceId, stockItemId',
      billAllocations: 'id, voucherId, workspaceId, ledgerId, billRef',
      costCenterAllocations: 'id, voucherId, workspaceId, costCenterId',
      taxAllocations: 'id, voucherId, workspaceId, ledgerId',
      attachments: 'id, workspaceId, voucherId',
      importBatches: 'id, workspaceId, status',
      statementLines: 'id, workspaceId, importBatchId, [workspaceId+matchStatus]',
      auditEvents: 'id, workspaceId, entityType, [workspaceId+entityId], at',
      driveLinks: 'id, workspaceId, fileId',
      syncState: 'key',
      settings: 'key',
    });
  }
}

let singleton: LedgerDatabase | undefined;

export function getDb(): LedgerDatabase {
  if (!singleton) singleton = new LedgerDatabase();
  return singleton;
}

export function resetDbSingleton(): void {
  singleton = undefined;
}

export function createTestDb(name = `0ledger-test-${crypto.randomUUID()}`): LedgerDatabase {
  return new LedgerDatabase(name);
}
