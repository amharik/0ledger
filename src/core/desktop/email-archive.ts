import type { LedgerDatabase } from '@/core/db/db';
import {
  EmailArchiveFileSchema,
  EmailArchiveSchema,
  type Attachment,
  type EmailArchive,
  type EmailArchiveFile,
  type Voucher,
} from '@/core/model';
import type { ParsedEmail } from '@/core/ingest/email';
import type { ParsedStatement } from '@/core/ingest/types';
import { newId, nowIso } from '@/core/ids';
import { sha256Hex } from '@/core/util/hash';

export interface StoredEmailFile {
  storagePath?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ArchiveEmailInput {
  workspaceId: string;
  accountId?: string;
  uid: number;
  uidValidity?: number;
  mailbox?: string;
  subject: string;
  from: string;
  rawBytes: Uint8Array;
  rawStoragePath?: string;
  email: ParsedEmail;
  statements: ParsedStatement[];
  emlAttachmentId?: string;
  storeFile?: (file: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }) => Promise<StoredEmailFile | undefined>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function detectStatementPeriod(statements: ParsedStatement[]): {
  isMonthlyStatement: boolean;
  statementPeriod?: string;
} {
  const months = new Set<string>();
  let rows = 0;
  for (const statement of statements) {
    for (const row of statement.rows) {
      rows += 1;
      if (row.date.length >= 7) months.add(row.date.slice(0, 7));
    }
  }
  const isMonthlyStatement = rows >= 3 && months.size === 1;
  return {
    isMonthlyStatement,
    ...(isMonthlyStatement ? { statementPeriod: [...months][0] } : {}),
  };
}

export async function archiveEmail(
  db: LedgerDatabase,
  input: ArchiveEmailInput,
): Promise<{ archive: EmailArchive; files: EmailArchiveFile[] }> {
  const now = nowIso();
  const rawBase64 = input.rawStoragePath ? undefined : bytesToBase64(input.rawBytes);
  const rawSha = await sha256Hex(input.rawBytes);
  const date = normalizeTimestamp(input.email.date);

  let existing: EmailArchive | undefined;
  if (input.email.messageId) {
    existing = await db.emailArchives
      .where('workspaceId')
      .equals(input.workspaceId)
      .and((row) => row.messageId === input.email.messageId)
      .first();
  }
  if (!existing) {
    const mailbox = input.mailbox ?? '';
    existing = await db.emailArchives
      .where('[workspaceId+mailbox+uid]')
      .equals([input.workspaceId, mailbox, input.uid])
      .and((row) => !input.accountId || !row.accountId || row.accountId === input.accountId)
      .first();
  }

  const period = detectStatementPeriod(input.statements);
  const fileInputs: EmailArchiveFile[] = [];
  for (const attachment of input.email.attachments) {
    const bytes = new Uint8Array(attachment.bytes);
    const sha = await sha256Hex(bytes);
    const fileName = attachment.fileName.slice(0, 512);
    const stored = input.storeFile
      ? await input.storeFile({ fileName, mimeType: attachment.mimeType, bytes })
      : undefined;
    fileInputs.push(
      EmailArchiveFileSchema.parse({
        id: newId('eaf'),
        workspaceId: input.workspaceId,
        emailArchiveId: existing?.id ?? newId('eml'),
        fileName,
        mimeType: attachment.mimeType.slice(0, 128),
        sizeBytes: stored?.sizeBytes ?? bytes.byteLength,
        sha256: stored?.sha256 ?? sha,
        ...(stored?.storagePath
          ? { storagePath: stored.storagePath }
          : { contentBase64: bytesToBase64(bytes) }),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  const archiveId = existing?.id ?? newId('eml');
  for (const file of fileInputs) file.emailArchiveId = archiveId;

  const archive = EmailArchiveSchema.parse({
    id: archiveId,
    workspaceId: input.workspaceId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    mailbox: (input.mailbox ?? '').slice(0, 256),
    uid: input.uid,
    ...(input.uidValidity !== undefined ? { uidValidity: input.uidValidity } : {}),
    ...(input.email.messageId ? { messageId: input.email.messageId.slice(0, 512) } : {}),
    subject: input.subject.slice(0, 1024),
    from: input.from.slice(0, 512),
    ...(date ? { date } : {}),
    receivedAt: now,
    ...(input.rawStoragePath ? { rawStoragePath: input.rawStoragePath } : { rawBase64: rawBase64 ?? '' }),
    sha256: rawSha,
    sizeBytes: input.rawBytes.byteLength,
    attachmentIds: input.emlAttachmentId ? [input.emlAttachmentId] : [],
    fileIds: fileInputs.map((file) => file.id),
    isMonthlyStatement: period.isMonthlyStatement,
    ...(period.statementPeriod ? { statementPeriod: period.statementPeriod } : {}),
    statementCount: input.statements.length,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  await db.transaction('rw', [db.emailArchives, db.emailArchiveFiles], async () => {
    if (existing) {
      const stale = await db.emailArchiveFiles
        .where('emailArchiveId')
        .equals(archiveId)
        .toArray();
      for (const file of stale) await db.emailArchiveFiles.delete(file.id);
    }
    await db.emailArchives.put(archive);
    if (fileInputs.length > 0) await db.emailArchiveFiles.bulkPut(fileInputs);
  });

  return { archive, files: fileInputs };
}

export async function getEmailArchive(
  db: LedgerDatabase,
  workspaceId: string,
  id: string,
): Promise<EmailArchive | undefined> {
  const archive = await db.emailArchives.get(id);
  return archive?.workspaceId === workspaceId ? archive : undefined;
}

export async function listEmailArchiveFiles(
  db: LedgerDatabase,
  workspaceId: string,
  archiveId: string,
): Promise<EmailArchiveFile[]> {
  const files = await db.emailArchiveFiles.where('emailArchiveId').equals(archiveId).toArray();
  return files
    .filter((file) => file.workspaceId === workspaceId)
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function findEmailArchiveForAttachment(
  db: LedgerDatabase,
  workspaceId: string,
  attachmentId: string,
): Promise<EmailArchive | undefined> {
  const rows = await db.emailArchives.where('workspaceId').equals(workspaceId).toArray();
  return rows.find((row) => row.attachmentIds.includes(attachmentId));
}

export async function findEmailArchiveForVoucher(
  db: LedgerDatabase,
  workspaceId: string,
  voucher: Voucher,
): Promise<EmailArchive | undefined> {
  if (voucher.sourceEmailId) {
    const direct = await getEmailArchive(db, workspaceId, voucher.sourceEmailId);
    if (direct) return direct;
  }

  const event = await db.moneyEvents
    .where('postedVoucherId')
    .equals(voucher.id)
    .and((row) => row.workspaceId === workspaceId)
    .first();
  if (event?.emailArchiveId) {
    const archived = await getEmailArchive(db, workspaceId, event.emailArchiveId);
    if (archived) return archived;
  }

  const attachments = await db.attachments
    .where('voucherId')
    .equals(voucher.id)
    .and((row) => row.workspaceId === workspaceId)
    .toArray();
  for (const attachment of attachments) {
    const archived = await findEmailArchiveForAttachment(db, workspaceId, attachment.id);
    if (archived) return archived;
  }
  return undefined;
}

export async function findAttachment(
  db: LedgerDatabase,
  workspaceId: string,
  attachmentId: string,
): Promise<Attachment | undefined> {
  const attachment = await db.attachments.get(attachmentId);
  return attachment?.workspaceId === workspaceId ? attachment : undefined;
}
