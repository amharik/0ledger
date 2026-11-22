import type { LedgerDatabase } from './db';
import { isNativeStoreAvailable, nativeStore, type ImportSummary } from './native-store';
import { buildImportBundle, mirrorAllWorkspaces } from './sqlite-mirror';

/**
 * One-way migration from the legacy Dexie/IndexedDB cache into the
 * authoritative SQLite store. Safe to re-run: every entity is upserted by id
 * and the SQLite change log skips unchanged payloads.
 */
export async function migrateWorkspaceToSqlite(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ImportSummary> {
  if (!isNativeStoreAvailable()) {
    throw new Error('Run this migration inside the native desktop app.');
  }
  return nativeStore.importBundle(await buildImportBundle(db, workspaceId));
}

export async function migrateAllWorkspacesToSqlite(
  db: LedgerDatabase,
): Promise<ImportSummary> {
  if (!isNativeStoreAvailable()) {
    throw new Error('Run this migration inside the native desktop app.');
  }
  return (
    (await mirrorAllWorkspaces(db)) ?? {
      workspaces: 0,
      companies: 0,
      ledgers: 0,
      parties: 0,
      vouchers: 0,
    }
  );
}
