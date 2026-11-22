import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createLedger } from '@/core/db/ledger-service';
import { buildImportBundle, toRustCompany } from '@/core/db/sqlite-mirror';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import { makeCompany, makeLineInput, makeNewVoucher } from './fixtures';

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

describe('SQLite mirror contract', () => {
  it('omits undefined optional fields instead of sending null-ish values', () => {
    const mapped = toRustCompany(makeCompany());
    expect('tradeName' in mapped).toBe(false);
    expect('gstin' in mapped).toBe(false);
    expect('pan' in mapped).toBe(false);
  });

  it('builds a stable Rust import bundle from Dexie records', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, {
      name: 'Mirror Co',
      state: 'Karnataka',
      booksBegin: '2026-04-01',
    });
    const group = (name: string) => bundle.groups.find((item) => item.name === name)!;
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const sales = bundle.ledgers.find((ledger) => ledger.name === 'Sales')!;
    await createLedger(db, {
      workspaceId: bundle.workspace.id,
      name: 'Mirror Customer',
      groupId: group('Sundry Debtors').id,
    });

    await postVoucher(
      db,
      makeNewVoucher({
        workspaceId: bundle.workspace.id,
        voucherType: 'Journal',
        lines: [
          makeLineInput(cash.id, 100_000),
          makeLineInput(sales.id, -100_000),
        ],
      }),
    );

    const first = await buildImportBundle(db, bundle.workspace.id);
    const second = await buildImportBundle(db, bundle.workspace.id);

    expect(first.workspaces).toHaveLength(1);
    expect(first.companies).toHaveLength(1);
    expect(first.ledgers).toHaveLength(await db.ledgers.count());
    expect(first.parties).toHaveLength(1);
    expect(first.parties[0]!.name).toBe('Mirror Customer');
    expect(first.vouchers).toHaveLength(1);
    expect(first.vouchers[0]!.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect('roundOffLedgerId' in first.vouchers[0]!.voucher).toBe(false);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
