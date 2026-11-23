import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { LedgerDatabase } from '@/core/db/db';
import { parseEmailStatements, parseAlertText } from '@/core/ingest/email';
import { stageImport } from '@/core/ingest';
import { captureStatementLines } from '@/core/autopilot';
import type { ImportSource } from '@/core/model';
import { AttachmentSchema, type Attachment } from '@/core/model';
import { newId, nowIso } from '@/core/ids';
import { sha256Hex } from '@/core/util/hash';
import { storeRawArtifact, processFinancialObservation } from '@/core/canonical/engine';
import { getDefaultFolders } from './folder-watcher';
import { archiveEmail, bytesToBase64, type StoredEmailFile } from './email-archive';
import { generatePasswordCandidates } from '@/core/ingest/passwords';
import { getServerTenantId, serverHeaders } from '@/core/server/server-client';

export type MailboxProvider = 'gmail' | 'outlook' | 'zoho' | 'yahoo' | 'custom';

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox?: string;
  tls?: boolean;
}

export interface MailFilter {
  id: string;
  name: string;
  query: string;
  days: number;
  limit: number;
}

export interface MailboxAccount {
  id: string;
  label: string;
  provider: MailboxProvider;
  host: string;
  port: number;
  username: string;
  passwordCipher?: string; // legacy migration only; never written for new accounts
  mailbox?: string;
  tls?: boolean;
  isDefault?: boolean;
  defaultPreset?: MailPreset;
  defaultDays?: number;
  defaultLimit?: number;
  defaultBankLedgerId?: string;
  filters?: MailFilter[];
  lastSyncedAt?: string;
  createdAt?: string;
}

export type MailPreset = 'fastag' | 'bank' | 'shopping' | 'all' | 'custom';

export interface ImapQuery {
  preset?: MailPreset;
  custom_search?: string;
  limit?: number;
  days?: number;
  cursor?: number;
}

export interface ImapMessageResult {
  uid: number;
  uid_validity?: number;
  mailbox?: string;
  subject: string;
  from: string;
  date: string;
  raw_base64: string;
}

export interface ImapConnectionTestResult {
  ok: boolean;
  mailbox: string;
  exists?: number;
  folders: string[];
}

export interface MailProgressPayload {
  stage: string; // "connecting" | "authenticating" | "searching" | "filtering" | "fetching" | "extracting" | "complete"
  current: number;
  total: number;
  percent: number;
  message: string;
}

export interface SyncedTransactionItem {
  uid: number;
  subject: string;
  sender: string;
  date: string;
  occurredAt?: string | undefined;
  amountMinor: number;
  direction: 'in' | 'out';
  transactionId?: string | undefined;
  attachmentId?: string | undefined;
  attachmentPath?: string | undefined;
  emailArchiveId?: string | undefined;
  canonicalTxnId?: string | undefined;
  observationId?: string | undefined;
  idBasis?: string | undefined;
  isTransfer?: boolean | undefined;
  status: 'captured' | 'duplicate' | 'skipped';
}

export interface MailSyncReport {
  fetched: number;
  newMessages: number;
  transactionsCreated: number;
  attachmentsCreated: number;
  enhanced?: number;
  items: SyncedTransactionItem[];
  skipped: Array<{ uid: number; subject: string; reason: string }>;
  errors: string[];
}

export interface MailSyncOptions {
  accountId?: string;
  statementPassword?: string;
}

export interface MailSyncHistoryEntry {
  key: string;
  uid: number;
  subject: string;
  date: string;
  txns: number;
  skipped?: boolean;
  syncedAt: string;
}

export interface SaveEmailRequest {
  archive_root: string;
  company_name: string;
  financial_year: string;
  period_month: string;
  subject: string;
  uid: number;
  date: string;
  raw_base64: string;
}

export interface SavedEmailResult {
  file_path: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
}

export const MAIL_PROVIDER_PRESETS: Record<
  MailboxProvider,
  { label: string; host: string; port: number; tls: boolean; helpUrl?: string }
> = {
  gmail: {
    label: 'Gmail / Google Workspace',
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    host: 'outlook.office365.com',
    port: 993,
    tls: true,
  },
  zoho: {
    label: 'Zoho Mail',
    host: 'imap.zoho.in',
    port: 993,
    tls: true,
  },
  yahoo: {
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    tls: true,
  },
  custom: {
    label: 'Custom IMAP',
    host: '',
    port: 993,
    tls: true,
  },
};

const IMAP_CONFIG_KEY = '0ledger.mail_sync.config';
const MAILBOXES_KEY = '0ledger.mailboxes';
const memoryStore = new Map<string, string>();
const sessionPasswords = new Map<string, string>();
const sessionStatementPasswords = new Map<string, string>();

function getStorageItem(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
}

function setStorageItem(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

function removeStorageItem(key: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(key);
  }
  memoryStore.delete(key);
}

function credentialKey(workspaceId: string, accountId: string): string {
  return `${getServerTenantId()}:${workspaceId}:${accountId}`;
}

function legacyCredentialKey(workspaceId: string, accountId: string): string {
  return `${workspaceId}:${accountId}`;
}

function mailboxStoreKey(workspaceId: string): string {
  return `${MAILBOXES_KEY}:${getServerTenantId()}:${workspaceId}`;
}

function legacyMailboxStoreKey(workspaceId: string): string {
  return `${MAILBOXES_KEY}:${workspaceId}`;
}

function scopedLegacyConfigKey(workspaceId: string): string {
  return `${IMAP_CONFIG_KEY}:${getServerTenantId()}:${workspaceId}`;
}

function unscopedLegacyConfigKey(workspaceId: string): string {
  return `${IMAP_CONFIG_KEY}:${workspaceId}`;
}

function withoutPasswordCipher(account: MailboxAccount): MailboxAccount {
  const { passwordCipher: _legacy, ...safe } = account;
  return safe;
}

function decodeLegacyPassword(cipher: string, salt: string): string | undefined {
  if (!cipher) return undefined;
  try {
    const decoded = atob(cipher);
    const raw = Array.from(decoded)
      .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ salt.charCodeAt(i % salt.length)))
      .join('');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
}

export function clearMailSyncStorage(workspaceId?: string): void {
  const tenant = getServerTenantId();
  if (workspaceId) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(mailboxStoreKey(workspaceId));
      localStorage.removeItem(legacyMailboxStoreKey(workspaceId));
      localStorage.removeItem(scopedLegacyConfigKey(workspaceId));
      localStorage.removeItem(unscopedLegacyConfigKey(workspaceId));
    }
    memoryStore.delete(mailboxStoreKey(workspaceId));
    memoryStore.delete(legacyMailboxStoreKey(workspaceId));
    memoryStore.delete(scopedLegacyConfigKey(workspaceId));
    memoryStore.delete(unscopedLegacyConfigKey(workspaceId));
    const prefix = `${tenant}:${workspaceId}:`;
    for (const key of [...sessionPasswords.keys()]) {
      if (key.startsWith(prefix)) sessionPasswords.delete(key);
    }
    for (const key of [...sessionStatementPasswords.keys()]) {
      if (key.startsWith(prefix)) sessionStatementPasswords.delete(key);
    }
  } else {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    memoryStore.clear();
    sessionPasswords.clear();
    sessionStatementPasswords.clear();
  }
}

export async function storeMailboxPassword(
  workspaceId: string,
  accountId: string,
  password: string,
): Promise<boolean> {
  const key = credentialKey(workspaceId, accountId);
  if (!password) {
    sessionPasswords.delete(key);
    await deleteNativePassword(key);
    return false;
  }
  sessionPasswords.set(key, password);
  return storeNativePassword(key, password);
}

export async function getMailboxPassword(
  workspaceId: string,
  accountId: string,
): Promise<string | undefined> {
  const key = credentialKey(workspaceId, accountId);
  const native = await getNativePassword(key);
  if (native) return native;

  const legacyNative = await getNativePassword(legacyCredentialKey(workspaceId, accountId));
  if (legacyNative) {
    await storeMailboxPassword(workspaceId, accountId, legacyNative);
    return legacyNative;
  }

  const session = sessionPasswords.get(key);
  if (session) return session;

  const account = listMailboxes(workspaceId).find((item) => item.id === accountId);
  if (!account?.passwordCipher) return undefined;

  const legacy = decodeLegacyPassword(account.passwordCipher, workspaceId);
  if (!legacy) return undefined;
  sessionPasswords.set(key, legacy);
  await storeNativePassword(key, legacy);
  await migrateMailboxCredentials(workspaceId);
  return legacy;
}

export async function deleteMailboxPassword(
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const key = credentialKey(workspaceId, accountId);
  sessionPasswords.delete(key);
  await deleteNativePassword(key);
  await deleteNativePassword(legacyCredentialKey(workspaceId, accountId));
}

export async function migrateMailboxCredentials(
  workspaceId: string,
  db?: LedgerDatabase,
): Promise<MailboxAccount[]> {
  const list = listMailboxes(workspaceId);
  let changed = false;

  for (const account of list) {
    if (!account.passwordCipher) continue;
    const legacy = decodeLegacyPassword(account.passwordCipher, workspaceId);
    if (legacy) {
      await storeMailboxPassword(workspaceId, account.id, legacy);
    }
    changed = true;
  }

  const sanitized = list.map(withoutPasswordCipher);
  if (changed) {
    setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(sanitized));
    if (db) await persistMailboxesToDb(db, workspaceId, sanitized);
  }
  return sanitized;
}

// Native Keyring integration for desktop OS (Keychain / Secret Service / DPAPI)
export async function storeNativePassword(
  accountKey: string,
  secret: string,
  service = '0ledger.mail',
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('keyring_store_credential', {
        service,
        account: accountKey,
        secret,
      });
      return true;
    } catch {
      // Fallback gracefully if native keyring is unavailable
    }
  }
  return false;
}

export async function getNativePassword(
  accountKey: string,
  service = '0ledger.mail',
): Promise<string | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const pass = await invoke<string>('keyring_get_credential', {
        service,
        account: accountKey,
      });
      if (pass) return pass;
    } catch {}
  }
  return undefined;
}

export async function deleteNativePassword(
  accountKey: string,
  service = '0ledger.mail',
): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('keyring_delete_credential', {
        service,
        account: accountKey,
      });
    } catch {}
  }
}

function statementCredentialKey(workspaceId: string, accountId: string): string {
  return `${credentialKey(workspaceId, accountId)}:statement`;
}

export async function storeStatementPassword(
  workspaceId: string,
  accountId: string,
  password: string,
): Promise<boolean> {
  const key = statementCredentialKey(workspaceId, accountId);
  if (!password.trim()) {
    sessionStatementPasswords.delete(key);
    await deleteNativePassword(key, '0ledger.statement');
    return false;
  }
  sessionStatementPasswords.set(key, password);
  return storeNativePassword(key, password, '0ledger.statement');
}

export async function getStatementPassword(
  workspaceId: string,
  accountId: string,
): Promise<string | undefined> {
  const key = statementCredentialKey(workspaceId, accountId);
  const native = await getNativePassword(key, '0ledger.statement');
  if (native) return native;
  return sessionStatementPasswords.get(key);
}

export async function deleteStatementPassword(
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const key = statementCredentialKey(workspaceId, accountId);
  sessionStatementPasswords.delete(key);
  await deleteNativePassword(key, '0ledger.statement');
}

export function listMailboxes(workspaceId: string): MailboxAccount[] {
  try {
    const scoped = getStorageItem(mailboxStoreKey(workspaceId));
    if (scoped) {
      const parsed = JSON.parse(scoped) as unknown;
      if (Array.isArray(parsed)) return parsed as MailboxAccount[];
    }
    const legacy = getStorageItem(legacyMailboxStoreKey(workspaceId));
    if (legacy) {
      setStorageItem(mailboxStoreKey(workspaceId), legacy);
      removeStorageItem(legacyMailboxStoreKey(workspaceId));
      const parsed = JSON.parse(legacy) as unknown;
      if (Array.isArray(parsed)) return parsed as MailboxAccount[];
    }
  } catch {}

  try {
    const legacy = getLegacyMailSyncConfig(workspaceId);
    if (legacy?.username) {
      const id = 'mbx_default';
      if (legacy.password) {
        const key = credentialKey(workspaceId, id);
        sessionPasswords.set(key, legacy.password);
        void storeNativePassword(key, legacy.password);
      }
      const initial: MailboxAccount = {
        id,
        label: `${legacy.username} (${legacy.host.includes('gmail') ? 'Gmail' : 'IMAP'})`,
        provider: legacy.host.includes('gmail')
          ? 'gmail'
          : legacy.host.includes('outlook')
            ? 'outlook'
            : legacy.host.includes('zoho')
              ? 'zoho'
              : legacy.host.includes('yahoo')
                ? 'yahoo'
                : 'custom',
        host: legacy.host,
        port: legacy.port,
        username: legacy.username,
        mailbox: legacy.mailbox || 'INBOX',
        tls: legacy.tls ?? legacy.port === 993,
        isDefault: true,
        createdAt: new Date().toISOString(),
      };
      setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify([initial]));
      removeStorageItem(scopedLegacyConfigKey(workspaceId));
      removeStorageItem(unscopedLegacyConfigKey(workspaceId));
      return [initial];
    }
  } catch {}

  return [];
}

export async function persistMailboxesToDb(
  db: LedgerDatabase,
  workspaceId: string,
  list: MailboxAccount[],
): Promise<void> {
  try {
    await db.settings.put({
      key: mailboxStoreKey(workspaceId),
      value: list.map(withoutPasswordCipher),
    });
  } catch {
    // Non-fatal if IndexedDB is unavailable in unit tests
  }
}

export async function hydrateMailboxesFromDb(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<MailboxAccount[]> {
  const local = listMailboxes(workspaceId);
  try {
    const scopedRecord = await db.settings.get(mailboxStoreKey(workspaceId));
    const legacyRecord = await db.settings.get(legacyMailboxStoreKey(workspaceId));
    const record = scopedRecord ?? legacyRecord;
    const fromDb = Array.isArray(record?.value) ? (record.value as MailboxAccount[]) : [];
    if (fromDb.length > 0 && local.length === 0) {
      setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(fromDb));
      return migrateMailboxCredentials(workspaceId, db);
    }
    if (local.length > 0 && fromDb.length === 0) {
      await persistMailboxesToDb(db, workspaceId, local);
    }
    return migrateMailboxCredentials(workspaceId, db);
  } catch {
    return local;
  }
}

export async function saveMailbox(
  workspaceId: string,
  account: MailboxAccount,
  rawPassword?: string,
  db?: LedgerDatabase,
): Promise<void> {
  await migrateMailboxCredentials(workspaceId, db);

  let list: MailboxAccount[] = [];
  try {
    const raw = getStorageItem(mailboxStoreKey(workspaceId));
    if (raw) list = JSON.parse(raw) as MailboxAccount[];
  } catch {}
  list = list.map(withoutPasswordCipher);

  const nextAccount = withoutPasswordCipher(account);
  if (nextAccount.isDefault) {
    list = list.map((item) => ({ ...item, isDefault: item.id === nextAccount.id }));
  }

  const idx = list.findIndex((m) => m.id === nextAccount.id);
  if (idx >= 0) {
    list[idx] = nextAccount;
  } else {
    if (list.length === 0 || !list.some((m) => m.isDefault)) {
      nextAccount.isDefault = true;
    }
    list.push(nextAccount);
  }
  setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(list));

  if (db) await persistMailboxesToDb(db, workspaceId, list);
  removeStorageItem(scopedLegacyConfigKey(workspaceId));
  removeStorageItem(unscopedLegacyConfigKey(workspaceId));

  if (rawPassword) {
    await storeMailboxPassword(workspaceId, nextAccount.id, rawPassword);
  } else if (account.passwordCipher) {
    const legacy = decodeLegacyPassword(account.passwordCipher, workspaceId);
    if (legacy) await storeMailboxPassword(workspaceId, nextAccount.id, legacy);
  }
}

export function listMailboxFilters(workspaceId: string, accountId: string): MailFilter[] {
  const account = listMailboxes(workspaceId).find((item) => item.id === accountId);
  return account?.filters ?? [];
}

export async function saveMailboxFilters(
  workspaceId: string,
  accountId: string,
  filters: MailFilter[],
  db?: LedgerDatabase,
): Promise<MailFilter[]> {
  const account = listMailboxes(workspaceId).find((item) => item.id === accountId);
  if (!account) return [];
  const clean = filters
    .map((filter) => ({
      id: filter.id,
      name: filter.name.trim().slice(0, 80),
      query: filter.query.trim().slice(0, 512),
      days: Math.max(1, Math.min(365, Math.round(filter.days) || 60)),
      limit: Math.max(1, Math.min(50, Math.round(filter.limit) || 25)),
    }))
    .filter((filter) => filter.name && filter.query);
  await saveMailbox(workspaceId, { ...account, filters: clean }, undefined, db);
  return clean;
}

export async function upsertMailboxFilter(
  workspaceId: string,
  accountId: string,
  filter: MailFilter,
  db?: LedgerDatabase,
): Promise<MailFilter[]> {
  const current = listMailboxFilters(workspaceId, accountId);
  const next = current.some((item) => item.id === filter.id)
    ? current.map((item) => (item.id === filter.id ? filter : item))
    : [...current, filter];
  return saveMailboxFilters(workspaceId, accountId, next, db);
}

export async function deleteMailboxFilter(
  workspaceId: string,
  accountId: string,
  filterId: string,
  db?: LedgerDatabase,
): Promise<MailFilter[]> {
  return saveMailboxFilters(
    workspaceId,
    accountId,
    listMailboxFilters(workspaceId, accountId).filter((item) => item.id !== filterId),
    db,
  );
}

export function setDefaultMailbox(
  workspaceId: string,
  id: string,
  db?: LedgerDatabase,
): MailboxAccount[] {
  const list = listMailboxes(workspaceId)
    .map(withoutPasswordCipher)
    .map((item) => ({
      ...item,
      isDefault: item.id === id,
    }));
  setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(list));
  if (db) {
    void persistMailboxesToDb(db, workspaceId, list);
  }
  return list;
}

export function markMailboxSynced(
  workspaceId: string,
  id: string,
  db?: LedgerDatabase,
): MailboxAccount[] {
  const now = new Date().toISOString();
  const list = listMailboxes(workspaceId)
    .map(withoutPasswordCipher)
    .map((item) => (item.id === id ? { ...item, lastSyncedAt: now } : item));
  setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(list));
  if (db) {
    void persistMailboxesToDb(db, workspaceId, list);
  }
  return list;
}

export async function deleteMailbox(
  workspaceId: string,
  id: string,
  db?: LedgerDatabase,
): Promise<void> {
  let list: MailboxAccount[] = [];
  try {
    const raw = getStorageItem(mailboxStoreKey(workspaceId));
    if (raw) list = JSON.parse(raw) as MailboxAccount[];
  } catch {}
  list = list.filter((m) => m.id !== id).map(withoutPasswordCipher);
  if (list.length > 0 && !list.some((m) => m.isDefault)) {
    list[0]!.isDefault = true;
  }
  setStorageItem(mailboxStoreKey(workspaceId), JSON.stringify(list));
  if (db) {
    await persistMailboxesToDb(db, workspaceId, list);
  }
  await deleteMailboxPassword(workspaceId, id);
  await deleteStatementPassword(workspaceId, id);
}

export function getActiveMailbox(workspaceId: string, id?: string): MailboxAccount | undefined {
  const list = listMailboxes(workspaceId);
  if (id) {
    const found = list.find((m) => m.id === id);
    if (found) return found;
  }
  return list.find((m) => m.isDefault) ?? list[0];
}

function getLegacyMailSyncConfig(workspaceId: string): ImapConfig | undefined {
  try {
    const scoped = getStorageItem(scopedLegacyConfigKey(workspaceId));
    if (scoped) return JSON.parse(scoped) as ImapConfig;
    const legacy = getStorageItem(unscopedLegacyConfigKey(workspaceId));
    if (legacy) {
      setStorageItem(scopedLegacyConfigKey(workspaceId), legacy);
      removeStorageItem(unscopedLegacyConfigKey(workspaceId));
      return JSON.parse(legacy) as ImapConfig;
    }
  } catch {}
  return undefined;
}

export async function testMailConnectionDetailed(
  config: ImapConfig,
  workspaceId?: string,
): Promise<ImapConnectionTestResult> {
  if (isTauri()) {
    const ok = await invoke<boolean>('imap_test_connection', { config });
    return { ok, mailbox: config.mailbox || 'INBOX', folders: [config.mailbox || 'INBOX'] };
  }

  const response = await fetch('/api/imap/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serverHeaders(workspaceId) },
    body: JSON.stringify({ config }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    mailbox?: string;
    exists?: number;
    folders?: string[];
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `IMAP connection failed (HTTP ${response.status}).`);
  }

  return {
    ok: true,
    mailbox: payload.mailbox || config.mailbox || 'INBOX',
    ...(typeof payload.exists === 'number' ? { exists: payload.exists } : {}),
    folders: Array.isArray(payload.folders) && payload.folders.length > 0 ? payload.folders : ['INBOX'],
  };
}

export async function testMailConnection(
  config: ImapConfig,
  workspaceId?: string,
): Promise<boolean> {
  const result = await testMailConnectionDetailed(config, workspaceId);
  return result.ok;
}

export interface ImapMessagePage {
  messages: ImapMessageResult[];
  scanned: number;
  matched: number;
  nextCursor?: number;
}

export async function fetchMailPage(
  config: ImapConfig,
  query: ImapQuery,
  workspaceId?: string,
  cursor?: number,
): Promise<ImapMessagePage> {
  if (isTauri()) {
    const messages = await invoke<ImapMessageResult[]>('imap_fetch_messages', { config, query });
    return { messages, scanned: messages.length, matched: messages.length };
  }

  const response = await fetch('/api/imap/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serverHeaders(workspaceId) },
    body: JSON.stringify({ config, query: { ...query, ...(cursor ? { cursor } : {}) } }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    messages?: ImapMessageResult[];
    scanned?: number;
    matched?: number;
    nextCursor?: number;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Failed to fetch emails from IMAP (HTTP ${response.status}).`);
  }

  const page: ImapMessagePage = {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    scanned: Number(payload.scanned ?? 0),
    matched: Number(payload.matched ?? 0),
  };
  if (typeof payload.nextCursor === 'number') page.nextCursor = payload.nextCursor;
  return page;
}

export async function fetchMailMessages(
  config: ImapConfig,
  query: ImapQuery,
  workspaceId?: string,
): Promise<ImapMessageResult[]> {
  const page = await fetchMailPage(config, query, workspaceId);
  return page.messages;
}

export async function listRecentMailHistory(
  db: LedgerDatabase,
  workspaceId: string,
  limit = 20,
): Promise<MailSyncHistoryEntry[]> {
  try {
    const prefix = `mail.uid:${getServerTenantId()}:${workspaceId}:`;
    const rows = await db.syncState.where('key').startsWith(prefix).toArray();
    const parsed: MailSyncHistoryEntry[] = [];
    for (const row of rows) {
      try {
        const val = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        if (val && typeof val === 'object') {
          const item = val as Record<string, unknown>;
          parsed.push({
            key: row.key,
            uid: Number(item.uid ?? 0),
            subject: String(item.subject ?? '(No subject)'),
            date: String(item.date ?? ''),
            txns: Number(item.txns ?? 0),
            ...(item.skipped === true ? { skipped: true } : {}),
            syncedAt: String(item.syncedAt ?? ''),
          });
        }
      } catch {
        // ignore malformed entry
      }
    }
    return parsed
      .sort((a, b) => b.syncedAt.localeCompare(a.syncedAt))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function emailTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function saveEmailAttachment(
  db: LedgerDatabase,
  workspaceId: string,
  msg: ImapMessageResult,
  archiveRoot: string,
  companyName: string,
  fy: string,
  month: string,
): Promise<{ attachmentId: string; filePath: string } | undefined> {
  try {
    let filePath = '';
    let fileName = `${(msg.subject.slice(0, 40) || 'email').replace(/[^a-zA-Z0-9_-]/g, '_')}_${msg.uid}.eml`;
    let sizeBytes = 0;
    let sha256 = '';

    if (isTauri()) {
      const res = await invoke<SavedEmailResult>('save_email_eml', {
        req: {
          archive_root: archiveRoot,
          company_name: companyName,
          financial_year: fy,
          period_month: month,
          subject: msg.subject,
          uid: msg.uid,
          date: msg.date,
          raw_base64: msg.raw_base64,
        },
      });
      filePath = res.file_path;
      fileName = res.file_name;
      sizeBytes = res.size_bytes;
      sha256 = res.sha256;
    } else {
      const rawBytes = base64ToUint8Array(msg.raw_base64);
      sizeBytes = rawBytes.byteLength;
      filePath = `vault://${companyName}/${fy}/${month}/Emails/${fileName}`;
      const hashBuf = await crypto.subtle.digest('SHA-256', rawBytes.slice().buffer as ArrayBuffer);
      sha256 = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    const now = nowIso();
    const attachmentId = newId('att');
    const attachment: Attachment = AttachmentSchema.parse({
      id: attachmentId,
      workspaceId,
      fileName,
      mimeType: 'message/rfc822',
      sizeBytes,
      sha256,
      storageKey: filePath,
      createdAt: now,
      updatedAt: now,
    });
    await db.attachments.put(attachment);
    return { attachmentId, filePath };
  } catch (err) {
    console.warn('Failed to archive .eml to vault:', err);
    return undefined;
  }
}

async function saveEmailFileToVault(
  archiveRoot: string,
  companyName: string,
  fy: string,
  month: string,
  file: { fileName: string; mimeType: string; bytes: Uint8Array },
): Promise<StoredEmailFile | undefined> {
  if (!isTauri()) return undefined;
  try {
    const res = await invoke<SavedEmailResult>('save_email_file', {
      req: {
        archive_root: archiveRoot,
        company_name: companyName,
        financial_year: fy,
        period_month: month,
        subfolder: 'Attachments',
        file_name: `${crypto.randomUUID().slice(0, 8)}_${file.fileName.slice(0, 200)}`,
        bytes_base64: bytesToBase64(file.bytes),
      },
    });
    return {
      storagePath: res.file_path,
      sizeBytes: res.size_bytes,
      sha256: res.sha256,
    };
  } catch (err) {
    console.warn('Failed to archive email attachment to vault:', err);
    return undefined;
  }
}

export async function syncLocalMail(
  db: LedgerDatabase,
  workspaceId: string,
  config: ImapConfig,
  query: ImapQuery,
  bankLedgerId?: string,
  onProgress?: (progress: MailProgressPayload) => void,
  options: MailSyncOptions = {},
): Promise<MailSyncReport> {
  let unlistenProgress: UnlistenFn | undefined;
  if (isTauri() && onProgress) {
    try {
      unlistenProgress = await listen<MailProgressPayload>('mail-sync-progress', (event) => {
        onProgress(event.payload);
      });
    } catch {}
  }

  const report: MailSyncReport = {
    fetched: 0,
    newMessages: 0,
    transactionsCreated: 0,
    attachmentsCreated: 0,
    enhanced: 0,
    items: [],
    skipped: [],
    errors: [],
  };

  try {
    onProgress?.({
      stage: 'connecting',
      current: 0,
      total: 100,
      percent: 12,
      message: `Connecting to ${config.host}:${config.port}...`,
    });

    const messages = await fetchMailMessages(config, query, workspaceId);
    report.fetched = messages.length;

    if (messages.length === 0) {
      onProgress?.({
        stage: 'complete',
        current: 0,
        total: 0,
        percent: 100,
        message: 'No matching emails found for the selected lookback period and filter.',
      });
      return report;
    }

    onProgress?.({
      stage: 'filtering',
      current: 0,
      total: messages.length,
      percent: 55,
      message: `Fetched ${messages.length} email(s). Extracting transactions and receipts...`,
    });

    const company = await db.companies.where('workspaceId').equals(workspaceId).first();
    const companyName = company?.legalName || 'General';
    const storedStatementPassword = options.accountId
      ? await getStatementPassword(workspaceId, options.accountId)
      : undefined;
    const generatedPasswords = generatePasswordCandidates(
      {
        ...(company?.legalName ? { fullName: company.legalName } : {}),
        ...(company?.pan ? { pan: company.pan } : {}),
      },
      { institution: config.host },
    ).map((candidate) => candidate.password);
    const statementPasswords = [
      ...new Set(
        [options.statementPassword, storedStatementPassword, ...generatedPasswords].filter(
          (value): value is string => Boolean(value?.trim()),
        ),
      ),
    ];
    const defaults = await getDefaultFolders();
    const archiveRoot = defaults.archive_folder;

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
    const fy =
      now.getMonth() >= 3
        ? `FY${curYear}-${String(curYear + 1).slice(-2)}`
        : `FY${curYear - 1}-${String(curYear).slice(-2)}`;
    const monthStr = `${curYear}-${curMonth}`;

    const totalMsgs = messages.length;
    for (let i = 0; i < totalMsgs; i++) {
      const msg = messages[i]!;
      const currentIdx = i + 1;
      const pct = 60 + Math.round((currentIdx / Math.max(totalMsgs, 1)) * 38);

      onProgress?.({
        stage: 'extracting',
        current: currentIdx,
        total: totalMsgs,
        percent: pct,
        message: `Parsing ${currentIdx} of ${totalMsgs}: ${msg.subject.slice(0, 52)}`,
      });

      try {
        const mailboxName = msg.mailbox || config.mailbox || 'INBOX';
        const uidValidity = msg.uid_validity ?? 0;
        const syncKey = `mail.uid:${getServerTenantId()}:${workspaceId}:${config.host}:${config.username}:${mailboxName}:${uidValidity}:${msg.uid}`;
        const legacyKey = `mail.uid:${config.host}:${config.username}:${msg.uid}`;
        const existing = (await db.syncState.get(syncKey)) ?? (await db.syncState.get(legacyKey));
        if (existing) {
          report.skipped.push({ uid: msg.uid, subject: msg.subject, reason: 'Already processed' });
          continue;
        }

        const rawBytes = base64ToUint8Array(msg.raw_base64);
        let txnsForMsg = 0;
        let attached: { attachmentId: string; filePath: string } | undefined;

        try {
          const parsed = await parseEmailStatements(rawBytes, {
            ...(statementPasswords.length > 0 ? { passwords: statementPasswords } : {}),
          });
          if (parsed.statements.length > 0) {
            attached = await saveEmailAttachment(
              db,
              workspaceId,
              msg,
              archiveRoot,
              companyName,
              fy,
              monthStr,
            );
            if (attached) report.attachmentsCreated += 1;

            const archived = await archiveEmail(db, {
              workspaceId,
              ...(options.accountId ? { accountId: options.accountId } : {}),
              uid: msg.uid,
              ...(msg.uid_validity !== undefined ? { uidValidity: msg.uid_validity } : {}),
              mailbox: mailboxName,
              subject: msg.subject,
              from: msg.from,
              rawBytes,
              ...(isTauri() && attached?.filePath ? { rawStoragePath: attached.filePath } : {}),
              email: parsed.email,
              statements: parsed.statements,
              ...(attached?.attachmentId ? { emlAttachmentId: attached.attachmentId } : {}),
              ...(isTauri()
                ? {
                    storeFile: (file) =>
                      saveEmailFileToVault(archiveRoot, companyName, fy, monthStr, file),
                  }
                : {}),
            });
            const occurredAt = emailTimestamp(parsed.email.date);

            const rawHash = await sha256Hex(rawBytes);
            const artifact = await storeRawArtifact(db, workspaceId, {
              source: 'email',
              messageId: parsed.email.messageId,
              fileName: `${msg.subject.slice(0, 100) || 'email'}.eml`,
              mimeType: 'message/rfc822',
              sha256: rawHash,
              sizeBytes: rawBytes.length,
              storagePath: attached?.filePath,
              authStatus: parsed.email.auth,
              receivedAt: parsed.email.date ? new Date(parsed.email.date).toISOString() : undefined,
            });

            for (const statement of parsed.statements) {
              const source: ImportSource = statement.kind === 'fastag' ? 'fastag' : 'email';
              const staged = await stageImport(db, {
                workspaceId,
                source,
                statement,
                fileName: `${msg.subject.slice(0, 100) || 'email'}.eml`,
                ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
              });
              const captured = await captureStatementLines(
                db,
                workspaceId,
                staged.batch,
                staged.lines,
                {
                  ...(attached?.attachmentId ? { attachmentId: attached.attachmentId } : {}),
                  emailArchiveId: archived.archive.id,
                  ...(occurredAt ? { occurredAt } : {}),
                  mergeDuplicates: true,
                },
              );
              txnsForMsg += captured.created.length;
              report.enhanced = (report.enhanced ?? 0) + captured.enhanced;

              for (const row of statement.rows) {
                const isOut = row.debitMinor > row.creditMinor;
                const netMinor = Math.abs(row.creditMinor - row.debitMinor);

                const obsRes = await processFinancialObservation(db, workspaceId, artifact.id, {
                  date: row.date,
                  amountMinor: netMinor,
                  direction: isOut ? 'out' : 'in',
                  currency: row.currency,
                  merchantRaw: row.description,
                  referenceId: row.reference,
                  rail: (row.raw?.rail as string | undefined) ?? (row.reference ? 'generic' : undefined),
                  accountTail: typeof row.raw?.accountTail === 'string' ? row.raw.accountTail : undefined,
                  issuer: typeof row.raw?.institution === 'string' ? row.raw.institution : undefined,
                  rawSnippet: row.description,
                });

                report.items.push({
                  uid: msg.uid,
                  subject: msg.subject,
                  sender: msg.from,
                  date: row.date,
                  amountMinor: netMinor,
                  direction: isOut ? 'out' : 'in',
                  transactionId: row.reference,
                  attachmentId: attached?.attachmentId,
                  attachmentPath: attached?.filePath,
                  emailArchiveId: archived.archive.id,
                  ...(occurredAt ? { occurredAt } : {}),
                  canonicalTxnId: obsRes.canonicalTxn.id,
                  observationId: obsRes.observation.id,
                  idBasis: obsRes.canonicalTxn.idBasis,
                  isTransfer: obsRes.canonicalTxn.isTransfer,
                  status: 'captured',
                });
              }
            }
          }
        } catch {
          const text = new TextDecoder().decode(rawBytes.slice(0, 50_000));
          const alertStmt = parseAlertText({ text, subject: msg.subject, from: msg.from });
          if (alertStmt && alertStmt.rows.length > 0) {
            attached = await saveEmailAttachment(
              db,
              workspaceId,
              msg,
              archiveRoot,
              companyName,
              fy,
              monthStr,
            );
            if (attached) report.attachmentsCreated += 1;

            const parsedEmail = await parseEmailStatements(rawBytes, {
              ...(statementPasswords.length > 0 ? { passwords: statementPasswords } : {}),
            }).then((result) => result.email).catch(() => undefined);
            const archived = await archiveEmail(db, {
              workspaceId,
              ...(options.accountId ? { accountId: options.accountId } : {}),
              uid: msg.uid,
              ...(msg.uid_validity !== undefined ? { uidValidity: msg.uid_validity } : {}),
              mailbox: mailboxName,
              subject: msg.subject,
              from: msg.from,
              rawBytes,
              ...(isTauri() && attached?.filePath ? { rawStoragePath: attached.filePath } : {}),
              email: parsedEmail ?? {
                subject: msg.subject,
                from: msg.from,
                date: msg.date,
                text: '',
                attachments: [],
                raw: {},
              },
              statements: [alertStmt],
              ...(attached?.attachmentId ? { emlAttachmentId: attached.attachmentId } : {}),
              ...(isTauri()
                ? {
                    storeFile: (file) =>
                      saveEmailFileToVault(archiveRoot, companyName, fy, monthStr, file),
                  }
                : {}),
            });
            const occurredAt = emailTimestamp(msg.date);

            const rawHash = await sha256Hex(rawBytes);
            const artifact = await storeRawArtifact(db, workspaceId, {
              source: 'email',
              fileName: `${msg.subject.slice(0, 100) || 'alert'}.eml`,
              mimeType: 'message/rfc822',
              sha256: rawHash,
              sizeBytes: rawBytes.length,
              storagePath: attached?.filePath,
            });

            const staged = await stageImport(db, {
              workspaceId,
              source: alertStmt.kind === 'fastag' ? 'fastag' : 'email',
              statement: alertStmt,
              fileName: `${msg.subject.slice(0, 100) || 'alert'}.txt`,
              ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
            });
            const captured = await captureStatementLines(
              db,
              workspaceId,
              staged.batch,
              staged.lines,
              {
                ...(attached?.attachmentId ? { attachmentId: attached.attachmentId } : {}),
                emailArchiveId: archived.archive.id,
                ...(occurredAt ? { occurredAt } : {}),
                mergeDuplicates: true,
              },
            );
            txnsForMsg += captured.created.length;
            report.enhanced = (report.enhanced ?? 0) + captured.enhanced;

            for (const row of alertStmt.rows) {
              const isOut = row.debitMinor > row.creditMinor;
              const netMinor = Math.abs(row.creditMinor - row.debitMinor);

              const obsRes = await processFinancialObservation(db, workspaceId, artifact.id, {
                date: row.date,
                amountMinor: netMinor,
                direction: isOut ? 'out' : 'in',
                currency: row.currency,
                merchantRaw: row.description,
                referenceId: row.reference,
                rail: (row.raw?.rail as string | undefined) ?? (row.reference ? 'generic' : undefined),
                accountTail: typeof row.raw?.accountTail === 'string' ? row.raw.accountTail : undefined,
                issuer: typeof row.raw?.institution === 'string' ? row.raw.institution : undefined,
                rawSnippet: row.description,
              });

              report.items.push({
                uid: msg.uid,
                subject: msg.subject,
                sender: msg.from,
                date: row.date,
                amountMinor: netMinor,
                direction: isOut ? 'out' : 'in',
                transactionId: row.reference,
                attachmentId: attached?.attachmentId,
                attachmentPath: attached?.filePath,
                emailArchiveId: archived.archive.id,
                ...(occurredAt ? { occurredAt } : {}),
                canonicalTxnId: obsRes.canonicalTxn.id,
                observationId: obsRes.observation.id,
                idBasis: obsRes.canonicalTxn.idBasis,
                isTransfer: obsRes.canonicalTxn.isTransfer,
                status: 'captured',
              });
            }
          }
        }

        if (txnsForMsg > 0) {
          report.newMessages += 1;
          report.transactionsCreated += txnsForMsg;
          await db.syncState.put({
            key: syncKey,
            value: JSON.stringify({
              uid: msg.uid,
              subject: msg.subject,
              date: msg.date,
              txns: txnsForMsg,
              attachmentId: attached?.attachmentId,
              syncedAt: new Date().toISOString(),
            }),
          });
        } else {
          report.skipped.push({
            uid: msg.uid,
            subject: msg.subject,
            reason: 'No recognized accounting/alert data',
          });
          await db.syncState.put({
            key: syncKey,
            value: JSON.stringify({
              uid: msg.uid,
              subject: msg.subject,
              date: msg.date,
              txns: 0,
              skipped: true,
              syncedAt: new Date().toISOString(),
            }),
          });
        }
      } catch (err) {
        report.errors.push(
          `UID ${msg.uid} (${msg.subject}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    onProgress?.({
      stage: 'complete',
      current: totalMsgs,
      total: totalMsgs,
      percent: 100,
      message: `Sync complete. ${report.transactionsCreated} transaction(s) captured, ${report.attachmentsCreated} .eml proof(s) archived.`,
    });
  } finally {
    if (unlistenProgress) {
      unlistenProgress();
    }
  }

  return report;
}
