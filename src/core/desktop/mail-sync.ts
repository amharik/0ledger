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

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox?: string;
}

export interface MailboxAccount {
  id: string;
  label: string;
  provider: 'gmail' | 'outlook' | 'yahoo' | 'custom';
  host: string;
  port: number;
  username: string;
  passwordCipher: string; // obfuscated with workspace salt
  mailbox?: string;
  isDefault?: boolean;
  lastSyncedAt?: string;
  createdAt?: string;
}

export type MailPreset = 'fastag' | 'bank' | 'shopping' | 'all' | 'custom';

export interface ImapQuery {
  preset?: MailPreset;
  custom_search?: string;
  limit?: number;
  days?: number;
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
  amountMinor: number;
  direction: 'in' | 'out';
  transactionId?: string | undefined;
  attachmentId?: string | undefined;
  attachmentPath?: string | undefined;
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
  items: SyncedTransactionItem[];
  skipped: Array<{ uid: number; subject: string; reason: string }>;
  errors: string[];
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

const IMAP_CONFIG_KEY = '0ledger.mail_sync.config';
const MAILBOXES_KEY = '0ledger.mailboxes';
const memoryStore = new Map<string, string>();

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

export function clearMailSyncStorage(workspaceId?: string): void {
  if (workspaceId) {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${MAILBOXES_KEY}:${workspaceId}`);
      localStorage.removeItem(`${IMAP_CONFIG_KEY}:${workspaceId}`);
    }
    memoryStore.delete(`${MAILBOXES_KEY}:${workspaceId}`);
    memoryStore.delete(`${IMAP_CONFIG_KEY}:${workspaceId}`);
  } else {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    memoryStore.clear();
  }
}

// Native Keyring integration for desktop OS (Keychain / Secret Service / DPAPI)
export async function storeNativePassword(accountKey: string, secret: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('keyring_store_credential', {
        service: '0ledger.mail',
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

export async function getNativePassword(accountKey: string): Promise<string | undefined> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const pass = await invoke<string>('keyring_get_credential', {
        service: '0ledger.mail',
        account: accountKey,
      });
      if (pass) return pass;
    } catch {}
  }
  return undefined;
}

export async function deleteNativePassword(accountKey: string): Promise<void> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('keyring_delete_credential', {
        service: '0ledger.mail',
        account: accountKey,
      });
    } catch {}
  }
}

// Safe password obfuscation/encryption fallback using workspace-derived XOR cipher
export function encodePassword(password: string, salt = '0ledger-key'): string {
  if (!password) return '';
  try {
    const s = salt || '0ledger-key';
    const utf8 = encodeURIComponent(password);
    const chars = Array.from(utf8).map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ s.charCodeAt(i % s.length)),
    );
    return btoa(chars.join(''));
  } catch {
    return password;
  }
}

export function decodePassword(cipher: string, salt = '0ledger-key'): string {
  if (!cipher) return '';
  const s = salt || '0ledger-key';
  try {
    const decoded = atob(cipher);
    const raw = Array.from(decoded)
      .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ s.charCodeAt(i % s.length)))
      .join('');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return cipher;
  }
}

export function listMailboxes(workspaceId: string): MailboxAccount[] {
  try {
    const raw = getStorageItem(`${MAILBOXES_KEY}:${workspaceId}`);
    if (raw) return JSON.parse(raw);
  } catch {}

  // Fallback to single legacy config if present
  try {
    const legacy = getMailSyncConfig(workspaceId);
    if (legacy && legacy.username) {
      const initial: MailboxAccount = {
        id: 'mbx_default',
        label: `${legacy.username} (${legacy.host.includes('gmail') ? 'Gmail' : 'IMAP'})`,
        provider: legacy.host.includes('gmail')
          ? 'gmail'
          : legacy.host.includes('outlook')
            ? 'outlook'
            : legacy.host.includes('yahoo')
              ? 'yahoo'
              : 'custom',
        host: legacy.host,
        port: legacy.port,
        username: legacy.username,
        passwordCipher: encodePassword(legacy.password, workspaceId),
        mailbox: legacy.mailbox || 'INBOX',
        isDefault: true,
        createdAt: new Date().toISOString(),
      };
      setStorageItem(`${MAILBOXES_KEY}:${workspaceId}`, JSON.stringify([initial]));
      // Wipe legacy config to remove plaintext password from localStorage and memoryStore
      removeStorageItem(`${IMAP_CONFIG_KEY}:${workspaceId}`);
      return [initial];
    }
  } catch {}

  return [];
}

export function saveMailbox(workspaceId: string, account: MailboxAccount, rawPassword?: string): void {
  let list: MailboxAccount[] = [];
  try {
    const raw = getStorageItem(`${MAILBOXES_KEY}:${workspaceId}`);
    if (raw) list = JSON.parse(raw);
  } catch {}

  const idx = list.findIndex((m) => m.id === account.id);
  if (idx >= 0) {
    list[idx] = account;
  } else {
    if (list.length === 0 || !list.some((m) => m.isDefault)) {
      account.isDefault = true;
    }
    list.push(account);
  }
  setStorageItem(`${MAILBOXES_KEY}:${workspaceId}`, JSON.stringify(list));

  // Purge any residual legacy plaintext storage to prevent credential leaks
  removeStorageItem(`${IMAP_CONFIG_KEY}:${workspaceId}`);

  // Store in native OS keyring if provided
  if (rawPassword) {
    storeNativePassword(`${workspaceId}:${account.id}`, rawPassword).catch(() => {});
  }
}

export function deleteMailbox(workspaceId: string, id: string): void {
  let list: MailboxAccount[] = [];
  try {
    const raw = getStorageItem(`${MAILBOXES_KEY}:${workspaceId}`);
    if (raw) list = JSON.parse(raw);
  } catch {}
  list = list.filter((m) => m.id !== id);
  if (list.length > 0 && !list.some((m) => m.isDefault)) {
    list[0]!.isDefault = true;
  }
  setStorageItem(`${MAILBOXES_KEY}:${workspaceId}`, JSON.stringify(list));
  deleteNativePassword(`${workspaceId}:${id}`).catch(() => {});
}

export function getActiveMailbox(workspaceId: string, id?: string): MailboxAccount | undefined {
  const list = listMailboxes(workspaceId);
  if (id) {
    const found = list.find((m) => m.id === id);
    if (found) return found;
  }
  return list.find((m) => m.isDefault) ?? list[0];
}

export function getMailSyncConfig(workspaceId: string): ImapConfig | undefined {
  try {
    const raw = getStorageItem(`${IMAP_CONFIG_KEY}:${workspaceId}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return undefined;
}

export function saveMailSyncConfig(workspaceId: string, config: ImapConfig): void {
  setStorageItem(`${IMAP_CONFIG_KEY}:${workspaceId}`, JSON.stringify(config));
}

export async function testMailConnection(config: ImapConfig): Promise<boolean> {
  if (!isTauri()) {
    throw new Error('Mail sync is only available in the 0ledger desktop application.');
  }
  return await invoke<boolean>('imap_test_connection', { config });
}

export async function fetchMailMessages(config: ImapConfig, query: ImapQuery): Promise<ImapMessageResult[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<ImapMessageResult[]>('imap_fetch_messages', { config, query });
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

export async function syncLocalMail(
  db: LedgerDatabase,
  workspaceId: string,
  config: ImapConfig,
  query: ImapQuery,
  bankLedgerId?: string,
  onProgress?: (progress: MailProgressPayload) => void,
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
    items: [],
    skipped: [],
    errors: [],
  };

  try {
    onProgress?.({
      stage: 'connecting',
      current: 0,
      total: 100,
      percent: 5,
      message: `Connecting to ${config.host}:${config.port}...`,
    });

    const messages = await fetchMailMessages(config, query);
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
      message: `Downloaded ${messages.length} email(s). Now extracting transaction details & vouchers...`,
    });

    // Get company profile and default folders for vault archival
    const company = await db.companies.where('workspaceId').equals(workspaceId).first();
    const companyName = company?.legalName || 'General';
    const defaults = await getDefaultFolders();
    const archiveRoot = defaults.archive_folder;

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
    const fy = now.getMonth() >= 3 ? `FY${curYear}-${String(curYear + 1).slice(-2)}` : `FY${curYear - 1}-${String(curYear).slice(-2)}`;
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
        message: `Processing email ${currentIdx} of ${totalMsgs}: ${msg.subject.slice(0, 45)}...`,
      });

      try {
        const mailboxName = msg.mailbox || config.mailbox || 'INBOX';
        const uidValidity = msg.uid_validity ?? 0;
        const syncKey = `mail.uid:${config.host}:${config.username}:${mailboxName}:${uidValidity}:${msg.uid}`;
        const legacyKey = `mail.uid:${config.host}:${config.username}:${msg.uid}`;
        const existing = (await db.syncState.get(syncKey)) ?? (await db.syncState.get(legacyKey));
        if (existing) {
          report.skipped.push({ uid: msg.uid, subject: msg.subject, reason: 'Already processed' });
          continue;
        }

        const rawBytes = base64ToUint8Array(msg.raw_base64);
        let txnsForMsg = 0;
        let attached: { attachmentId: string; filePath: string } | undefined;

        // 1. Try parsing full email with attachments (PDF, CSV, XLSX) or alerts
        try {
          const parsed = await parseEmailStatements(rawBytes);
          if (parsed.statements.length > 0) {
            // Save .eml to vault as audit attachment
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
                attached?.attachmentId ? { attachmentId: attached.attachmentId } : undefined,
              );
              txnsForMsg += captured.created.length;

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
          // Fallback: decode raw text and check parseAlertText
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
              attached?.attachmentId ? { attachmentId: attached.attachmentId } : undefined,
            );
            txnsForMsg += captured.created.length;

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
          report.skipped.push({ uid: msg.uid, subject: msg.subject, reason: 'No recognized accounting/alert data' });
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
        report.errors.push(`UID ${msg.uid} (${msg.subject}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    onProgress?.({
      stage: 'complete',
      current: totalMsgs,
      total: totalMsgs,
      percent: 100,
      message: `Sync complete. ${report.transactionsCreated} transaction(s) captured, ${report.attachmentsCreated} attachment(s) archived.`,
    });
  } finally {
    if (unlistenProgress) {
      unlistenProgress();
    }
  }

  return report;
}
