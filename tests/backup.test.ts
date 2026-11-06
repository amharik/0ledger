import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  createBackup,
  createBackupPayload,
  decryptBackup,
  encryptBackup,
  restoreBackup,
  type BackupEnvelope,
} from '@/core/backup';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace, getWorkspaceBundle } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import { makeLineInput, makeNewVoucher } from './fixtures';

const PASSWORD = 'correct horse battery staple';
const FAST_KDF = { iterations: 100_000 };
const databases: LedgerDatabase[] = [];

function newDb() {
  const db = createTestDb();
  databases.push(db);
  return db;
}

async function seed(db: LedgerDatabase, name = 'Acme Traders') {
  const bundle = await createWorkspace(db, { name, state: 'Karnataka' });
  const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
  const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
  await postVoucher(
    db,
    makeNewVoucher({
      workspaceId: bundle.workspace.id,
      lines: [makeLineInput(purchases.id, 50_000), makeLineInput(cash.id, -50_000)],
    }),
  );
  return bundle;
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

describe('encrypted backup', () => {
  it('round-trips a complete ledger without exposing plaintext', async () => {
    const source = newDb();
    const bundle = await seed(source);
    const envelope = await createBackup(source, PASSWORD, FAST_KDF);
    const serialized = JSON.stringify(envelope);

    expect(envelope.format).toBe('0ledger-backup');
    expect(envelope.kdf.iterations).toBe(100_000);
    expect(serialized).not.toContain('Acme Traders');
    expect(serialized).not.toContain('Cash');

    const target = newDb();
    const result = await restoreBackup(target, envelope, PASSWORD);
    expect(result.mode).toBe('replace');
    expect(result.totalRecords).toBeGreaterThan(0);

    const restored = await getWorkspaceBundle(target, bundle.workspace.id);
    expect(restored?.workspace.name).toBe('Acme Traders');
    expect(restored?.company.state).toBe('Karnataka');
    expect(restored?.ledgers).toHaveLength(bundle.ledgers.length);
    expect(await target.vouchers.count()).toBe(1);
    expect(await target.voucherLines.count()).toBe(2);
    expect(await target.auditEvents.count()).toBeGreaterThanOrEqual(1);
  });

  it('decrypts to the same payload', async () => {
    const source = newDb();
    await seed(source);
    const payload = await createBackupPayload(source);
    const envelope = await encryptBackup(payload, PASSWORD, FAST_KDF);
    const decrypted = await decryptBackup(envelope, PASSWORD);

    expect(decrypted.exportedAt).toBe(payload.exportedAt);
    expect(Object.keys(decrypted.tables).sort()).toEqual(Object.keys(payload.tables).sort());
    expect(decrypted.tables.workspaces).toHaveLength(1);
  });

  it('rejects a wrong password', async () => {
    const source = newDb();
    await seed(source);
    const envelope = await createBackup(source, PASSWORD, FAST_KDF);
    await expect(decryptBackup(envelope, 'wrong password')).rejects.toBeInstanceOf(BackupError);
  });

  it('rejects tampered ciphertext', async () => {
    const source = newDb();
    await seed(source);
    const envelope = await createBackup(source, PASSWORD, FAST_KDF);
    const tampered: BackupEnvelope = {
      ...envelope,
      ciphertext: envelope.ciphertext.slice(0, -2) + 'AA',
    };
    await expect(decryptBackup(tampered, PASSWORD)).rejects.toBeInstanceOf(BackupError);
  });

  it('replaces existing data by default', async () => {
    const source = newDb();
    const sourceBundle = await seed(source, 'Source Co');
    const envelope = await createBackup(source, PASSWORD, FAST_KDF);

    const target = newDb();
    await createWorkspace(target, { name: 'Existing Co' });
    await restoreBackup(target, envelope, PASSWORD);

    const workspaces = await target.workspaces.toArray();
    expect(workspaces.map((workspace) => workspace.id)).toEqual([sourceBundle.workspace.id]);
  });

  it('can merge without clearing existing data', async () => {
    const source = newDb();
    await seed(source, 'Source Co');
    const envelope = await createBackup(source, PASSWORD, FAST_KDF);

    const target = newDb();
    const existing = await createWorkspace(target, { name: 'Existing Co' });
    const result = await restoreBackup(target, envelope, PASSWORD, { mode: 'merge' });
    expect(result.mode).toBe('merge');

    const workspaces = await target.workspaces.toArray();
    expect(workspaces).toHaveLength(2);
    expect(workspaces.some((workspace) => workspace.id === existing.workspace.id)).toBe(true);
    expect(workspaces.some((workspace) => workspace.name === 'Source Co')).toBe(true);
  });

  it('rejects backups that reference unknown tables', async () => {
    const source = newDb();
    const payload = await createBackupPayload(source);
    payload.tables.evil = [];
    const envelope = await encryptBackup(payload, PASSWORD, FAST_KDF);
    await expect(restoreBackup(newDb(), envelope, PASSWORD)).rejects.toThrow(/unknown tables/);
  });

  it('rejects short passwords', async () => {
    const source = newDb();
    await expect(createBackup(source, 'short')).rejects.toBeInstanceOf(BackupError);
  });
});
