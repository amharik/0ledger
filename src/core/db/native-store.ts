import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  CompanyProfile,
  Ledger,
  Party,
  Voucher,
  VoucherLine,
  Workspace,
} from '@/core/model';
import type { ProfitAndLoss, TrialBalance } from '@/core/ledger/reports';

/**
 * Typed bridge to the authoritative SQLite store inside the Tauri shell.
 *
 * All financial rules live in the Rust engine; this module only marshals data.
 * Calls throw outside Tauri so callers can fall back to the Dexie cache.
 */

export interface ImportBundle {
  workspaces: Workspace[];
  companies: CompanyProfile[];
  ledgers: Ledger[];
  parties: Party[];
  vouchers: Array<{ voucher: Voucher; lines: VoucherLine[] }>;
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
    call<Ledger[]>('store_list_ledgers', { workspaceId }),
  listVouchers: (workspaceId: string) =>
    call<Voucher[]>('store_list_vouchers', { workspaceId }),
  trialBalance: (workspaceId: string) =>
    call<TrialBalance>('store_trial_balance', { workspaceId }),
  profitAndLoss: (workspaceId: string) =>
    call<ProfitAndLoss>('store_profit_and_loss', { workspaceId }),
  integrityCheck: (workspaceId: string) =>
    call<IntegrityReport>('store_integrity_check', { workspaceId }),

  postVoucher: (input: { voucher: Voucher; lines: VoucherLine[] }) =>
    call<void>('store_post_voucher', { voucherJson: JSON.stringify(input) }),
  importBundle: (bundle: ImportBundle) =>
    call<ImportSummary>('store_import_bundle', { bundleJson: JSON.stringify(bundle) }),
  backupTo: (path: string) => call<void>('store_backup', { path }),

  generateSyncKey: () => call<string>('sync_generate_key'),
  exportSyncEnvelope: (key: string, sinceLamport = 0) =>
    call<string>('sync_export_envelope', { key, sinceLamport }),
  importSyncEnvelope: (key: string, envelopeJson: string) =>
    call<ApplySummary>('sync_import_envelope', { key, envelopeJson }),
};
