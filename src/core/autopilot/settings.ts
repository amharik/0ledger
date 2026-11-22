import type { LedgerDatabase } from '../db/db';
import { markDriveDirty } from '../db/sync-state';

export interface AutoPostSettings {
  enabled: boolean;
  categories: Record<string, boolean>;
}

const DEFAULT_SETTINGS: AutoPostSettings = { enabled: false, categories: {} };

export function autoPostSettingsKey(workspaceId: string): string {
  return `autopilot:${workspaceId}`;
}

function parseSettings(value: unknown): AutoPostSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS, categories: {} };
  const record = value as Record<string, unknown>;
  const categories: Record<string, boolean> = {};
  if (record.categories && typeof record.categories === 'object') {
    for (const [key, enabled] of Object.entries(record.categories as Record<string, unknown>)) {
      if (typeof enabled === 'boolean') categories[key] = enabled;
    }
  }
  return { enabled: record.enabled === true, categories };
}

export async function getAutoPostSettings(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<AutoPostSettings> {
  const row = await db.settings.get(autoPostSettingsKey(workspaceId));
  return parseSettings(row?.value);
}

export async function setAutoPostSettings(
  db: LedgerDatabase,
  workspaceId: string,
  settings: AutoPostSettings,
): Promise<AutoPostSettings> {
  const parsed: AutoPostSettings = {
    enabled: settings.enabled === true,
    categories: Object.fromEntries(
      Object.entries(settings.categories).filter(([, enabled]) => typeof enabled === 'boolean'),
    ),
  };
  await db.settings.put({ key: autoPostSettingsKey(workspaceId), value: parsed });
  await markDriveDirty(db, workspaceId);
  return parsed;
}

export function isCategoryEnabled(settings: AutoPostSettings, ledgerId: string): boolean {
  return settings.enabled && settings.categories[ledgerId] === true;
}
