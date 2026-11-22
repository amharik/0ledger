import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import {
  getDefaultFolders,
  getWatcherConfig,
  saveWatcherConfig,
} from '@/core/desktop/folder-watcher';
import {
  getMailSyncConfig,
  saveMailSyncConfig,
  listMailboxes,
  saveMailbox,
  deleteMailbox,
  getActiveMailbox,
  encodePassword,
  decodePassword,
  saveEmailAttachment,
  type MailboxAccount,
} from '@/core/desktop/mail-sync';
import { parseCsvStatement } from '@/core/ingest';
import { stageImport } from '@/core/ingest';
import { extractTransactionId, parseAlertText } from '@/core/ingest/email';
import {
  captureStatementLines,
  listExceptionQueue,
  approveMoneyEvent,
  classifyMoneyEventRisk,
} from '@/core/autopilot';

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

describe('Folder Watcher & Vault Configuration', () => {
  it('returns default folder paths with safe fallbacks', async () => {
    const defaults = await getDefaultFolders();
    expect(defaults.watch_folder).toBeDefined();
    expect(defaults.archive_folder).toBeDefined();
  });

  it('persists and retrieves folder watcher settings', () => {
    const wsId = 'ws_test_watcher';
    const config = getWatcherConfig(wsId);
    expect(config.watchFolder).toBeDefined();

    saveWatcherConfig(wsId, {
      watchFolder: '/custom/downloads',
      archiveFolder: '/custom/archive',
      autoOrganize: true,
      action: 'move',
    });

    const updated = getWatcherConfig(wsId);
    expect(updated.watchFolder).toBe('/custom/downloads');
    expect(updated.archiveFolder).toBe('/custom/archive');
    expect(updated.action).toBe('move');
  });
});

describe('Mail Sync Configuration & Multi-Mailbox Manager', () => {
  it('persists and retrieves IMAP mail sync settings', () => {
    const wsId = 'ws_test_mail';
    expect(getMailSyncConfig(wsId)).toBeUndefined();

    saveMailSyncConfig(wsId, {
      host: 'imap.gmail.com',
      port: 993,
      username: 'accounts@mycompany.in',
      password: 'abcd efgh ijkl mnop',
      mailbox: 'INBOX',
    });

    const config = getMailSyncConfig(wsId);
    expect(config).toBeDefined();
    expect(config?.username).toBe('accounts@mycompany.in');
    expect(config?.host).toBe('imap.gmail.com');
  });

  it('safely obfuscates passwords and manages multiple mailboxes', () => {
    const wsId = 'ws_multi_mailbox';
    const plain = 'secret_app_pass_123';
    const cipher = encodePassword(plain, wsId);
    expect(cipher).not.toBe(plain);
    expect(decodePassword(cipher, wsId)).toBe(plain);

    const mbx1: MailboxAccount = {
      id: 'mbx_hdfc',
      label: 'HDFC Banking Alerts',
      provider: 'gmail',
      host: 'imap.gmail.com',
      port: 993,
      username: 'billing@acme.com',
      passwordCipher: cipher,
      mailbox: 'INBOX',
      isDefault: true,
    };

    const mbx2: MailboxAccount = {
      id: 'mbx_fastag',
      label: 'FASTag & Toll Alerts',
      provider: 'outlook',
      host: 'outlook.office365.com',
      port: 993,
      username: 'founder@acme.in',
      passwordCipher: encodePassword('toll_pass_456', wsId),
      mailbox: 'INBOX',
      isDefault: false,
    };

    saveMailbox(wsId, mbx1);
    saveMailbox(wsId, mbx2);

    const list = listMailboxes(wsId);
    expect(list.length).toBe(2);
    expect(getActiveMailbox(wsId)?.id).toBe('mbx_hdfc');
    expect(getActiveMailbox(wsId, 'mbx_fastag')?.username).toBe('founder@acme.in');

    deleteMailbox(wsId, 'mbx_hdfc');
    const remaining = listMailboxes(wsId);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe('mbx_fastag');
    expect(remaining[0]!.isDefault).toBe(true);
  });
});

describe('Transaction ID Extraction & Alert Parsing', () => {
  it('extracts canonical transaction IDs from varied Indian payment alerts', () => {
    // UPI RRN
    const upiAlert =
      'Your A/C ending 5678 has been debited by Rs. 1,450.00 on 21-Nov-2026. Info: UPI/432156789012/Swiggy. UPI Ref: 432156789012.';
    expect(extractTransactionId(upiAlert)).toBe('432156789012');

    // NEFT UTR
    const neftAlert =
      'Dear Customer, INR 55,000.00 credited to account XX1234 on 20-Nov-2026 by NEFT UTR: HDFCN26325987123.';
    expect(extractTransactionId(neftAlert)).toBe('HDFCN26325987123');

    // IMPS Ref
    const impsAlert =
      'Payment of Rs. 3,200.00 debited from A/c XX9900. IMPS Ref: 629182736450. Avail Bal: Rs 14,000.';
    expect(extractTransactionId(impsAlert)).toBe('629182736450');

    // FASTag Toll Txn ID
    const fastagAlert =
      'NETC FASTag: Toll plaza Khed Shivapur debited INR 45.00 on 21-Nov-2026. Toll Txn ID: 987654321012.';
    expect(extractTransactionId(fastagAlert)).toBe('987654321012');

    // Amazon Order ID
    const amazonAlert =
      'Thanks for your order with Amazon.in! Order ID: 405-1234567-8901234. Order Total: Rs. 1,899.00.';
    expect(extractTransactionId(amazonAlert)).toBe('405-1234567-8901234');
  });

  it('parses email body alerts into structured statements with transaction IDs', () => {
    const alert = parseAlertText({
      subject: 'Transaction alert: INR 2,500.00 debited from A/C XX4321',
      text: 'Dear Customer, INR 2,500.00 was debited from your A/C ending 4321 on 21-Nov-2026. UPI Ref: 432198765432. Merchant: Swiggy.',
      from: 'alerts@hdfcbank.net',
    });

    expect(alert).toBeDefined();
    expect(alert?.rows.length).toBe(1);
    expect(alert?.rows[0]!.debitMinor).toBe(250000);
    expect(alert?.rows[0]!.creditMinor).toBe(0);
    expect(alert?.rows[0]!.reference).toBe('432198765432');
  });
});

describe('EML Vault Archival & Ledger Attachment Audit Linking', () => {
  it('archives .eml as an attachment, links to MoneyEvent, and associates with Voucher on approval', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Acme Traders', state: 'Karnataka' });
    const wsId = bundle.workspace.id;

    // 1. Create .eml attachment in vault
    const emailAttachment = await saveEmailAttachment(
      db,
      wsId,
      {
        uid: 501,
        subject: 'FASTag Toll Deduction INR 90',
        from: 'alerts@fastag.netc.org.in',
        date: '2026-11-21',
        raw_base64: btoa('Subject: FASTag Toll\nFrom: alerts@fastag.netc.org.in\n\nAmount: Rs. 90.00 Toll Txn ID: 88123456'),
      },
      '/tmp/0ledger_archive',
      'Acme Traders',
      'FY2026-27',
      '2026-11',
    );

    expect(emailAttachment).toBeDefined();
    expect(emailAttachment?.attachmentId).toBeDefined();

    // Verify stored in db.attachments
    const storedAtt = await db.attachments.get(emailAttachment!.attachmentId);
    expect(storedAtt).toBeDefined();
    expect(storedAtt?.mimeType).toBe('message/rfc822');
    expect(storedAtt?.voucherId).toBeUndefined();

    // 2. Stage import and capture MoneyEvent with attachmentId
    const csvContent = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.
21/11/2026,FASTag Toll Plaza Toll Txn ID 88123456,88123456,"90.00",
`;
    const statement = parseCsvStatement(csvContent);
    const staged = await stageImport(db, {
      workspaceId: wsId,
      source: 'fastag',
      statement,
      fileName: 'fastag-toll.csv',
    });

    const captured = await captureStatementLines(db, wsId, staged.batch, staged.lines, {
      attachmentId: emailAttachment!.attachmentId,
    });

    expect(captured.created.length).toBe(1);
    const event = captured.created[0]!;
    expect(event.attachmentId).toBe(emailAttachment!.attachmentId);
    expect(event.sourceRef).toBe('88123456');

    // Verify risk assessment: having attachmentId keeps risk from escalating to high
    const risk = classifyMoneyEventRisk({ event });
    expect(risk.reasons).not.toContain('Missing supporting document');
    expect(risk.band).not.toBe('high');

    // 3. Approve MoneyEvent into a Voucher
    const fuelLedger = await db.ledgers.where('workspaceId').equals(wsId).and((l) => l.name.includes('Office') || l.name.includes('Bank')).first();
    const bankLedger = await db.ledgers.where('workspaceId').equals(wsId).and((l) => l.isBank).first();

    const approved = await approveMoneyEvent(db, wsId, event.id, {
      ledgerId: fuelLedger?.id || bundle.ledgers[0]!.id,
      bankLedgerId: bankLedger!.id,
    });

    expect(approved.status).toBe('posted');
    expect(approved.postedVoucherId).toBeDefined();

    // 4. Verify attachment now points to the posted Voucher
    const updatedAtt = await db.attachments.get(emailAttachment!.attachmentId);
    expect(updatedAtt?.voucherId).toBe(approved.postedVoucherId);

    // 5. Verify deduplication by canonical transaction ID
    const duplicateCapture = await captureStatementLines(db, wsId, staged.batch, staged.lines);
    expect(duplicateCapture.created.length).toBe(0);
    expect(duplicateCapture.duplicates).toBe(1);
  });
});

