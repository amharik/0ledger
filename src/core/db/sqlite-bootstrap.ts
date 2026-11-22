import { getDb } from './db';
import { isNativeStoreAvailable } from './native-store';
import { mirrorAllWorkspaces } from './sqlite-mirror';

let bootstrapped = false;

/**
 * Ensure the authoritative SQLite store has a copy of every workspace in the
 * Dexie cache. Idempotent: repeated imports skip unchanged payloads, so this
 * can run on every desktop launch.
 */
export async function bootstrapSqlite(): Promise<void> {
  if (bootstrapped || !isNativeStoreAvailable()) return;
  bootstrapped = true;
  try {
    await mirrorAllWorkspaces(getDb());
  } catch (error) {
    // Keep the UI usable; the engine panel can retry the mirror explicitly.
    console.warn('SQLite mirror bootstrap failed', error);
  }
}
