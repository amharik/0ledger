import { nowIso } from '../ids';
import type { LedgerDatabase } from './db';

const PREFIX = 'drive.pending:';

export async function markDriveDirty(db: LedgerDatabase, workspaceId: string): Promise<void> {
  await db.syncState.put({ key: `${PREFIX}${workspaceId}`, value: nowIso() });
}

export async function clearDriveDirty(db: LedgerDatabase, workspaceId: string): Promise<void> {
  await db.syncState.delete(`${PREFIX}${workspaceId}`);
}

export async function isDriveDirty(db: LedgerDatabase, workspaceId: string): Promise<boolean> {
  return (await db.syncState.get(`${PREFIX}${workspaceId}`)) !== undefined;
}

export async function listDirtyWorkspaces(db: LedgerDatabase): Promise<string[]> {
  const rows = await db.syncState.filter((row) => row.key.startsWith(PREFIX)).toArray();
  return rows.map((row) => row.key.slice(PREFIX.length));
}
