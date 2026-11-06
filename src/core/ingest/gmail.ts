import type { LedgerDatabase } from '@/core/db/db';
import { parseEmailStatements } from './email';
import { stageImport, type StageImportResult } from './service';
import type { ImportSource } from '@/core/model';

export interface GmailMessageRef {
  id: string;
  threadId?: string;
}

export interface GmailSyncOptions {
  accessToken: string | (() => Promise<string>);
  query?: string;
  maxResults?: number;
  accountId?: string;
  fetchImpl?: typeof fetch;
}

export interface GmailSyncResult {
  messages: number;
  batches: StageImportResult[];
  skipped: Array<{ id: string; reason: string }>;
}

export const DEFAULT_GMAIL_QUERY =
  'has:attachment (statement OR "e-statement" OR "account statement") newer_than:90d';

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function tokenOf(token: string | (() => Promise<string>)): Promise<string> {
  return typeof token === 'function' ? token() : token;
}

async function gmailGet<T>(fetchImpl: typeof fetch, token: string, path: string): Promise<T> {
  const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gmail API ${response.status}: ${text || response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function listGmailMessages(
  options: GmailSyncOptions,
): Promise<GmailMessageRef[]> {
  const token = await tokenOf(options.accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = encodeURIComponent(options.query ?? DEFAULT_GMAIL_QUERY);
  const max = Math.min(Math.max(options.maxResults ?? 25, 1), 100);
  const data = await gmailGet<{ messages?: GmailMessageRef[] }>(
    fetchImpl,
    token,
    `messages?q=${query}&maxResults=${max}`,
  );
  return data.messages ?? [];
}

export async function getGmailRawMessage(
  options: GmailSyncOptions,
  messageId: string,
): Promise<Uint8Array> {
  const token = await tokenOf(options.accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const message = await gmailGet<{ raw?: string }>(fetchImpl, token, `messages/${messageId}?format=raw`);
  if (!message.raw) throw new Error(`Gmail message ${messageId} has no raw payload`);
  return base64UrlToBytes(message.raw);
}

export async function syncGmailStatements(
  db: LedgerDatabase,
  workspaceId: string,
  options: GmailSyncOptions,
): Promise<GmailSyncResult> {
  const refs = await listGmailMessages(options);
  const batches: StageImportResult[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const ref of refs) {
    try {
      const raw = await getGmailRawMessage(options, ref.id);
      const parsed = await parseEmailStatements(raw);
      if (parsed.statements.length === 0) {
        skipped.push({ id: ref.id, reason: 'No statement attachment or bank alert found' });
        continue;
      }
      for (const statement of parsed.statements) {
        const source: ImportSource = statement.kind === 'fastag' ? 'fastag' : 'email';
        const result = await stageImport(db, {
          workspaceId,
          source,
          statement,
          fileName: `${parsed.email.subject || ref.id}.eml`,
          ...(options.accountId ? { accountId: options.accountId } : {}),
        });
        batches.push(result);
      }
    } catch (cause) {
      skipped.push({
        id: ref.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { messages: refs.length, batches, skipped };
}
