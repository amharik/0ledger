import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { archiveEmail, findEmailArchiveForAttachment, getEmailArchive, listEmailArchiveFiles } from '@/core/desktop/email-archive';
import { captureStatementLines } from '@/core/autopilot';
import { stageImport } from '@/core/ingest';
import { parseCsvStatement } from '@/core/ingest/parsers';
import { AttachmentSchema } from '@/core/model';
import { newId, nowIso } from '@/core/ids';
import type { ParsedEmail } from '@/core/ingest/email';

const databases: LedgerDatabase[] = [];

function newDb() {
  const db = createTestDb();
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

async function seeded() {
  const db = newDb();
  const bundle = await createWorkspace(db, {
    name: 'Archive Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  return { db, bundle };
}

describe('email archive', () => {
  it('archives raw email bytes and attachment files with monthly statement metadata', async () => {
    const { db, bundle } = await seeded();
    const csv = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.
01/11/2026,UPI Payment,REF-1,"100.00",
15/11/2026,UPI Payment,REF-2,"250.00",
30/11/2026,UPI Payment,REF-3,"50.00",
`;
    const statement = parseCsvStatement(csv);
    const raw = new TextEncoder().encode('Subject: Statement\n\nHello');
    const attachmentBytes = new TextEncoder().encode(csv);
    const email: ParsedEmail = {
      subject: 'November statement',
      from: 'bank@example.com',
      date: '2026-11-30T10:15:00.000Z',
      messageId: '<statement@example.com>',
      text: 'Statement attached',
      attachments: [
        { fileName: 'november.csv', mimeType: 'text/csv', bytes: attachmentBytes.buffer.slice(0) as ArrayBuffer },
      ],
      raw: {},
    };
    const now = nowIso();
    const eml = AttachmentSchema.parse({
      id: newId('att'),
      workspaceId: bundle.workspace.id,
      fileName: 'november.eml',
      mimeType: 'message/rfc822',
      sizeBytes: raw.byteLength,
      sha256: 'a'.repeat(64),
      storageKey: '/tmp/november.eml',
      createdAt: now,
      updatedAt: now,
    });
    await db.attachments.add(eml);

    const { archive, files } = await archiveEmail(db, {
      workspaceId: bundle.workspace.id,
      uid: 42,
      mailbox: 'INBOX',
      subject: email.subject,
      from: email.from,
      rawBytes: raw,
      email,
      statements: [statement],
      emlAttachmentId: eml.id,
    });

    expect(archive.isMonthlyStatement).toBe(true);
    expect(archive.statementPeriod).toBe('2026-11');
    expect(archive.attachmentIds).toEqual([eml.id]);
    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toBe('november.csv');
    expect((await getEmailArchive(db, bundle.workspace.id, archive.id))?.sha256).toBe(archive.sha256);
    expect((await listEmailArchiveFiles(db, bundle.workspace.id, archive.id))[0]?.fileName).toBe(
      'november.csv',
    );
    expect((await findEmailArchiveForAttachment(db, bundle.workspace.id, eml.id))?.id).toBe(
      archive.id,
    );
  });


  it('keeps archives separate for the same UID in different mailboxes or accounts', async () => {
    const { db, bundle } = await seeded();
    const raw = new TextEncoder().encode('Subject: Alert\n\nNo attachments');
    const email: ParsedEmail = {
      subject: 'Alert',
      from: 'bank@example.com',
      date: '2026-11-21T09:30:00.000Z',
      text: 'Alert body',
      attachments: [],
      raw: {},
    };
    const base = {
      workspaceId: bundle.workspace.id,
      uid: 7,
      subject: email.subject,
      from: email.from,
      rawBytes: raw,
      email,
      statements: [],
    };

    const inbox = await archiveEmail(db, { ...base, accountId: 'acct-a', mailbox: 'INBOX' });
    const archiveFolder = await archiveEmail(db, { ...base, accountId: 'acct-a', mailbox: 'Archive' });
    const otherAccount = await archiveEmail(db, { ...base, accountId: 'acct-b', mailbox: 'INBOX' });
    const repeated = await archiveEmail(db, { ...base, accountId: 'acct-a', mailbox: 'INBOX' });

    expect(new Set([inbox.archive.id, archiveFolder.archive.id, otherAccount.archive.id]).size).toBe(3);
    expect(repeated.archive.id).toBe(inbox.archive.id);
    expect(await db.emailArchives.count()).toBe(3);
  });

  it('enriches duplicate money events with source email and timestamp', async () => {
    const { db, bundle } = await seeded();
    const csv = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.
21/11/2026,UPI Payment,REF-9,"90.00",
`;
    const statement = parseCsvStatement(csv);
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'email',
      statement,
      fileName: 'alert.eml',
    });
    const first = await captureStatementLines(db, bundle.workspace.id, staged.batch, staged.lines);
    expect(first.created).toHaveLength(1);

    const now = nowIso();
    const attachment = AttachmentSchema.parse({
      id: newId('att'),
      workspaceId: bundle.workspace.id,
      fileName: 'alert.eml',
      mimeType: 'message/rfc822',
      sizeBytes: 10,
      sha256: 'b'.repeat(64),
      storageKey: '/tmp/alert.eml',
      createdAt: now,
      updatedAt: now,
    });
    await db.attachments.add(attachment);
    const second = await captureStatementLines(
      db,
      bundle.workspace.id,
      staged.batch,
      staged.lines,
      {
        attachmentId: attachment.id,
        emailArchiveId: newId('eml'),
        occurredAt: '2026-11-21T09:30:00.000Z',
        mergeDuplicates: true,
      },
    );

    expect(second.created).toHaveLength(0);
    expect(second.enhanced).toBe(1);
    const event = await db.moneyEvents.get(first.created[0]!.id);
    expect(event?.attachmentId).toBe(attachment.id);
    expect(event?.emailArchiveId).toBeDefined();
    expect(event?.occurredAt).toBe('2026-11-21T09:30:00.000Z');
  });
});
