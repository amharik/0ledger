import Dexie, { type Table } from 'dexie';
import type {
  Attachment,
  AuditEvent,
  Batch,
  BillAllocation,
  CaPack,
  ClassificationRule,
  ClassificationSuggestion,
  CloseItem,
  CompanyProfile,
  CostCenter,
  CostCenterAllocation,
  DriveLink,
  EmailArchive,
  EmailArchiveFile,
  Godown,
  ImportBatch,
  ItemLine,
  Ledger,
  LedgerGroup,
  MoneyEvent,
  NumberingScheme,
  OwnAccount,
  Party,
  RawArtifact,
  Reconciliation,
  StatementLine,
  StockItem,
  TaxAllocation,
  Voucher,
  VoucherLine,
  Workspace,
  CanonicalTxn,
  FinancialObservation,
} from '../model';

export const DB_NAME = '0ledger';
export const DB_VERSION = 6;

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
  emailArchives!: Table<EmailArchive, string>;
  emailArchiveFiles!: Table<EmailArchiveFile, string>;
  importBatches!: Table<ImportBatch, string>;
  statementLines!: Table<StatementLine, string>;
  reconciliations!: Table<Reconciliation, string>;
  moneyEvents!: Table<MoneyEvent, string>;
  classificationRules!: Table<ClassificationRule, string>;
  classificationSuggestions!: Table<ClassificationSuggestion, string>;
  closeItems!: Table<CloseItem, string>;
  caPacks!: Table<CaPack, string>;
  auditEvents!: Table<AuditEvent, string>;
  driveLinks!: Table<DriveLink, string>;
  syncState!: Table<KeyValue, string>;
  settings!: Table<KeyValue, string>;
  rawArtifacts!: Table<RawArtifact, string>;
  observations!: Table<FinancialObservation, string>;
  canonicalTxns!: Table<CanonicalTxn, string>;
  ownAccounts!: Table<OwnAccount, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(2).stores({
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
      reconciliations:
        'id, workspaceId, statementLineId, voucherId, [workspaceId+status], [statementLineId+status]',
      auditEvents: 'id, workspaceId, entityType, [workspaceId+entityId], at',
      driveLinks: 'id, workspaceId, fileId',
      syncState: 'key',
      settings: 'key',
    });

    this.version(3).stores({
      moneyEvents:
        'id, workspaceId, [workspaceId+date], [workspaceId+status], contentHash, statementLineId, importBatchId, postedVoucherId',
      classificationRules:
        'id, workspaceId, [workspaceId+enabled], [workspaceId+priority], matchType',
      classificationSuggestions: 'id, workspaceId, moneyEventId, ruleId',
      closeItems:
        'id, workspaceId, [workspaceId+period], [workspaceId+status], [workspaceId+type], dedupeKey, sourceEntityId',
      caPacks: 'id, workspaceId, [workspaceId+period], generatedAt',
    });

    this.version(4).stores({
      moneyEvents:
        'id, workspaceId, sourceRef, [workspaceId+date], [workspaceId+status], contentHash, statementLineId, importBatchId, postedVoucherId',
      rawArtifacts: 'id, workspaceId, sha256, [workspaceId+source], messageId',
      observations:
        'id, workspaceId, artifactId, canonicalTxnId, [workspaceId+date], referenceId, rail',
      canonicalTxns:
        'id, workspaceId, txnUid, reference, [workspaceId+date], [workspaceId+status], linkGroupId, postedVoucherId',
      ownAccounts: 'id, workspaceId, [workspaceId+institution], [workspaceId+accountTail]',
    });

    this.version(5).stores({
      emailArchives:
        'id, workspaceId, messageId, [workspaceId+uid], [workspaceId+date], sha256, receivedAt',
      emailArchiveFiles: 'id, workspaceId, emailArchiveId, sha256',
    });

    this.version(6).stores({
      emailArchives:
        'id, workspaceId, messageId, [workspaceId+mailbox+uid], [workspaceId+uid], [workspaceId+date], sha256, receivedAt',
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
