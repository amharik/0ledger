import { getDb } from '@/core/db/db';
import { archiveMonthToDrive, flushDirtyWorkspaces } from '@/core/drive/sync';
import { getDriveAccessToken } from '@/core/drive/token-store';

const FLUSH_ALARM = 'drive-flush';

function previousMonthKey(date = new Date()): string {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
}

async function archivePreviousMonth(): Promise<void> {
  const now = new Date();
  if (now.getDate() > 3) return;
  const token = await getDriveAccessToken();
  if (!token) return;
  const db = getDb();
  const period = previousMonthKey(now);
  const links = (await db.driveLinks.toArray()).filter((link) => link.kind === 'sheets');
  for (const link of links) {
    const marker = `drive.archive:${link.workspaceId}:${period}`;
    if (await db.syncState.get(marker)) continue;
    try {
      await archiveMonthToDrive(db, link.workspaceId, period, { token });
      await db.syncState.put({ key: marker, value: new Date().toISOString() });
    } catch (error) {
      console.warn('0ledger: monthly Drive archive failed', error);
    }
  }
}

async function flushDrive(): Promise<void> {
  const token = await getDriveAccessToken();
  if (!token) return;
  const db = getDb();
  const result = await flushDirtyWorkspaces(db, token);
  if (result.failed.length > 0) {
    console.warn('0ledger: Drive sync failed for some workspaces', result.failed);
  }
  await archivePreviousMonth();
}

export default defineBackground(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FLUSH_ALARM) void flushDrive();
  });
  void flushDrive();
});
