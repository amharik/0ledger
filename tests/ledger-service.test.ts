import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createLedger, removeLedger, updateLedger } from '@/core/db/ledger-service';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import { makeLineInput, makeNewVoucher } from './fixtures';

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
    name: 'Accounts Co',
    state: 'Karnataka',
    booksBegin: '2026-04-01',
  });
  const group = (name: string) => bundle.groups.find((item) => item.name === name)!;
  return { db, bundle, group };
}

describe('ledger service', () => {
  it('creates a bank ledger with derived flags and opening balance', async () => {
    const { db, bundle, group } = await seeded();
    const created = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'HDFC Current A/C 1234',
      groupId: group('Bank Accounts').id,
      openingBalanceMinor: 125_000_00,
      code: '1020',
    });

    expect(created.ledger.isBank).toBe(true);
    expect(created.ledger.nature).toBe('asset');
    expect(created.ledger.tallyParent).toBe('Bank Accounts');
    expect(created.ledger.openingBalanceDate).toBe('2026-04-01');
    expect(created.party).toBeUndefined();
  });

  it('creates a party master for debtor and creditor ledgers', async () => {
    const { db, bundle, group } = await seeded();
    const debtor = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Customer One',
      groupId: group('Sundry Debtors').id,
    });
    const creditor = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Supplier One',
      groupId: group('Sundry Creditors').id,
    });

    expect(debtor.ledger.isParty).toBe(true);
    expect(debtor.ledger.billwise).toBe(true);
    expect(debtor.party?.type).toBe('debtor');
    expect(creditor.party?.type).toBe('creditor');
    expect(await db.parties.count()).toBe(2);
  });

  it('rejects duplicate names case-insensitively', async () => {
    const { db, bundle, group } = await seeded();
    await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Travel',
      groupId: group('Indirect Expenses').id,
    });
    await expect(
      createLedger(db, {
        workspaceId: bundle.workspace.id,
        name: ' travel ',
        groupId: group('Indirect Expenses').id,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('updates opening balances and ledger metadata', async () => {
    const { db, bundle, group } = await seeded();
    const { ledger } = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Travel',
      groupId: group('Indirect Expenses').id,
    });

    const updated = await updateLedger(db, ledger.id, {
      openingBalanceMinor: -50_000,
      openingBalanceDate: '2026-04-01',
      code: '5200',
      notes: 'Opening balance imported from Tally',
    });
    expect(updated.openingBalanceMinor).toBe(-50_000);
    expect(updated.code).toBe('5200');
    expect(updated.notes).toContain('Tally');
  });

  it('deletes unused ledgers but archives used ones', async () => {
    const { db, bundle, group } = await seeded();
    const unused = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Unused',
      groupId: group('Indirect Expenses').id,
    });
    expect(await removeLedger(db, unused.ledger.id)).toBe('deleted');

    const purchases = await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Travel',
      groupId: group('Indirect Expenses').id,
    });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        lines: [makeLineInput(purchases.ledger.id, 10_000), makeLineInput(cash.id, -10_000)],
      }),
    );

    expect(await removeLedger(db, purchases.ledger.id)).toBe('archived');
    const archived = await db.ledgers.get(purchases.ledger.id);
    expect(archived?.archived).toBe(true);
  });

  it('refuses to delete system ledgers', async () => {
    const { db, bundle } = await seeded();
    const system = bundle.ledgers.find((ledger) => ledger.isSystem)!;
    await expect(removeLedger(db, system.id)).rejects.toThrow(/System ledgers/);
  });
});
