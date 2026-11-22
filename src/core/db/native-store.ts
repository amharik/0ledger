import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  LedgerNature,
  TallyPrimaryGroup,
  VoucherSource,
  VoucherStatus,
  VoucherType,
} from '@/core/model';
import type { RoundingMode } from '@/core/money/money';
import type { ProfitAndLoss, TrialBalance } from '@/core/ledger/reports';

/**
 * Typed bridge to the authoritative SQLite store inside the Tauri shell.
 *
 * The shapes below mirror the Rust engine's serde contract, not the richer
 * Dexie records. `sqlite-mirror.ts` performs the conversion. All financial
 * rules live in the Rust engine; this module only marshals data.
 */

export interface RustWorkspace {
  id: string;
  slug: string;
  name: string;
  readableName: string;
  companyId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RustCompanySettings {
  fyStartMonth: number;
  roundToMinor: number;
  roundingMode: RoundingMode;
  decimalPlaces: number;
  defaultCurrency: string;
}

export interface RustCompany {
  id: string;
  workspaceId: string;
  legalName: string;
  tradeName?: string;
  gstin?: string;
  pan?: string;
  state?: string;
  currency: string;
  booksBegin: string;
  settings: RustCompanySettings;
  createdAt: string;
  updatedAt: string;
}

export interface RustLedger {
  id: string;
  workspaceId: string;
  name: string;
  tallyParent: TallyPrimaryGroup;
  nature: LedgerNature;
  openingBalanceMinor: number;
  isParty: boolean;
  isBank: boolean;
  isTax: boolean;
  billwise: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RustParty {
  id: string;
  workspaceId: string;
  ledgerId: string;
  name: string;
  gstin?: string;
  partyType: 'debtor' | 'creditor' | 'both';
  createdAt: string;
  updatedAt: string;
}

export interface RustVoucher {
  id: string;
  workspaceId: string;
  voucherType: VoucherType;
  number: string;
  date: string;
  status: VoucherStatus;
  currency: string;
  partyLedgerId?: string;
  invoiceNumber?: string;
  narration?: string;
  roundOffAmountMinor: number;
  roundOffLedgerId?: string;
  source: VoucherSource;
  createdAt: string;
  updatedAt: string;
}

export interface RustVoucherLine {
  id: string;
  voucherId: string;
  workspaceId: string;
  lineNo: number;
  ledgerId: string;
  amountMinor: number;
  currency: string;
  narration?: string;
}

export interface RustNewVoucher {
  voucher: RustVoucher;
  lines: RustVoucherLine[];
}

export interface ImportBundle {
  workspaces: RustWorkspace[];
  companies: RustCompany[];
  ledgers: RustLedger[];
  parties: RustParty[];
  vouchers: RustNewVoucher[];
}

export interface ImportSummary {
  workspaces: number;
  companies: number;
  ledgers: number;
  parties: number;
  vouchers: number;
}

export interface ApplySummary {
  applied: number;
  ignored: number;
  skipped: number;
}

export interface IntegrityIssue {
  code: string;
  message: string;
  entityId?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedVouchers: number;
  checkedAuditEvents: number;
  issues: IntegrityIssue[];
}

export type MirrorEntityType = 'voucher' | 'ledger' | 'party';

export function isNativeStoreAvailable(): boolean {
  return isTauri();
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('The SQLite engine is only available in the native desktop app.');
  }
  return invoke<T>(command, args);
}

export const nativeStore = {
  engineVersion: () => call<string>('engine_version'),
  deviceId: () => call<string>('store_device_id'),
  schemaVersion: () => call<number>('store_schema_version'),

  listLedgers: (workspaceId: string) =>
    call<RustLedger[]>('store_list_ledgers', { workspaceId }),
  listVouchers: (workspaceId: string) =>
    call<RustVoucher[]>('store_list_vouchers', { workspaceId }),
  trialBalance: (workspaceId: string) =>
    call<TrialBalance>('store_trial_balance', { workspaceId }),
  profitAndLoss: (workspaceId: string) =>
    call<ProfitAndLoss>('store_profit_and_loss', { workspaceId }),
  integrityCheck: (workspaceId: string) =>
    call<IntegrityReport>('store_integrity_check', { workspaceId }),

  postVoucher: (input: RustNewVoucher) =>
    call<void>('store_post_voucher', { voucherJson: JSON.stringify(input) }),
  importBundle: (bundle: ImportBundle) =>
    call<ImportSummary>('store_import_bundle', { bundleJson: JSON.stringify(bundle) }),
  deleteEntity: (entityType: MirrorEntityType, entityId: string) =>
    call<void>('store_delete_entity', { entityType, entityId }),
  backupTo: (path: string) => call<void>('store_backup', { path }),

  generateSyncKey: () => call<string>('sync_generate_key'),
  exportSyncEnvelope: (key: string, sinceLamport = 0) =>
    call<string>('sync_export_envelope', { key, sinceLamport }),
  importSyncEnvelope: (key: string, envelopeJson: string) =>
    call<ApplySummary>('sync_import_envelope', { key, envelopeJson }),
};
