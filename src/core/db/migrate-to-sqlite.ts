import type { LedgerDatabase } from './db';
import { isNativeStoreAvailable, nativeStore, type ImportBundle, type ImportSummary } from './native-store';

/**
 * One-way migration from the legacy Dexie/IndexedDB cache into the
 * authoritative SQLite store. Safe to re-run: every entity is upserted by id.
 */
export async function migrateWorkspaceToSqlite(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ImportSummary> {
  if (!isNativeStoreAvailable()) {
    throw new Error('Run this migration inside the native desktop app.');
  }

  const [workspace, company, ledgers, parties, vouchers, lines] = await Promise.all([
    db.workspaces.get(workspaceId),
    db.companies.where('workspaceId').equals(workspaceId).first(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
    db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
  ]);

  const linesByVoucher = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByVoucher.get(line.voucherId) ?? [];
    list.push(line);
    linesByVoucher.set(line.voucherId, list);
  }

  const bundle: ImportBundle = {
    workspaces: workspace ? [workspace] : [],
    companies: company ? [company] : [],
    ledgers,
    parties,
    vouchers: vouchers.map((voucher) => ({
      voucher,
      lines: linesByVoucher.get(voucher.id) ?? [],
    })),
  };

  return nativeStore.importBundle(bundle);
}

export async function migrateAllWorkspacesToSqlite(
  db: LedgerDatabase,
): Promise<ImportSummary> {
  const workspaces = await db.workspaces.toArray();
  const total: ImportSummary = {
    workspaces: 0,
    companies: 0,
    ledgers: 0,
    parties: 0,
    vouchers: 0,
  };
  for (const workspace of workspaces) {
    const summary = await migrateWorkspaceToSqlite(db, workspace.id);
    total.workspaces += summary.workspaces;
    total.companies += summary.companies;
    total.ledgers += summary.ledgers;
    total.parties += summary.parties;
    total.vouchers += summary.vouchers;
  }
  return total;
}
