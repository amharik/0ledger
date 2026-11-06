import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import {
  commitImportBatch,
  listImportBatches,
  listStatementLines,
  stageImport,
  undoImportBatch,
  verifyStatementBalance,
  groupFastagLines,
} from '@/core/ingest';
import { parseCsvStatement } from '@/core/ingest';

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

const CSV = `HDFC Bank Statement

Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/2026,UPI-PAID-VENDOR,REF123,"1,500.00",,"98,500.00"
02/11/2026,NEFT RECEIVED FROM CUSTOMER,REF456,,"5,000.00","1,03,500.00"
`;

describe('statement staging', () => {
  it('stages rows, posts vouchers, and undoes the batch', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Import Co', state: 'Karnataka' });
    const bank = bundle.ledgers.find((ledger) => ledger.name === 'Bank Account')!;
    const purchases = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;

    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement: parseCsvStatement(CSV),
      fileName: 'hdfc.csv',
    });
    expect(staged.batch.totalLines).toBe(2);
    expect(staged.duplicates).toBe(0);
    expect(await listStatementLines(db, staged.batch.id)).toHaveLength(2);
    const balance = verifyStatementBalance(await listStatementLines(db, staged.batch.id));
    expect(balance.checked).toBe(1);
    expect(balance.mismatches).toEqual([]);

    const result = await commitImportBatch(db, bundle.workspace.id, staged.batch.id, {
      accountId: bank.id,
      defaultLedgerId: purchases.id,
    });
    expect(result.committed).toBe(2);
    expect(result.failed).toBe(0);

    const vouchers = await db.vouchers.where('workspaceId').equals(bundle.workspace.id).toArray();
    expect(vouchers.map((voucher) => voucher.voucherType).sort()).toEqual(['Payment', 'Receipt']);
    expect(vouchers.every((voucher) => voucher.source === 'statement')).toBe(true);

    const lines = await listStatementLines(db, staged.batch.id);
    expect(lines.every((line) => line.matchStatus === 'matched')).toBe(true);
    expect(lines.every((line) => line.matchedVoucherId)).toBe(true);

    const restored = await undoImportBatch(db, bundle.workspace.id, staged.batch.id);
    expect(restored).toBe(2);
    expect(await db.vouchers.count()).toBe(0);
    const after = await listStatementLines(db, staged.batch.id);
    expect(after.every((line) => line.matchStatus === 'unmatched')).toBe(true);
    expect((await listImportBatches(db, bundle.workspace.id))[0]?.status).toBe('cancelled');
  });

  it('rejects duplicate statement lines', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'Dedupe Co', state: 'Karnataka' });
    const statement = parseCsvStatement(CSV);
    await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'csv',
      statement,
      fileName: 'hdfc.csv',
    });
    await expect(
      stageImport(db, {
        workspaceId: bundle.workspace.id,
        source: 'csv',
        statement,
        fileName: 'hdfc.csv',
      }),
    ).rejects.toThrow(/already staged or imported/);
  });
});

describe('fastag grouping', () => {
  it('groups toll lines by vehicle and plaza', async () => {
    const db = newDb();
    const bundle = await createWorkspace(db, { name: 'FASTag Co', state: 'Karnataka' });
    const staged = await stageImport(db, {
      workspaceId: bundle.workspace.id,
      source: 'fastag',
      fileName: 'fastag.csv',
      statement: {
        adapterId: 'fastag',
        adapterName: 'FASTag',
        kind: 'fastag',
        currency: 'INR',
        rows: [
          {
            date: '2026-11-01',
            description: 'TOLL PLAZA Electronic City',
            debitMinor: 10_000,
            creditMinor: 0,
            currency: 'INR',
            raw: { vehicle: 'KA01AB1234', plaza: 'Electronic City' },
          },
          {
            date: '2026-11-02',
            description: 'TOLL PLAZA Electronic City',
            debitMinor: 12_000,
            creditMinor: 0,
            currency: 'INR',
            raw: { vehicle: 'KA01AB1234', plaza: 'Electronic City' },
          },
        ],
      },
    });
    const lines = await listStatementLines(db, staged.batch.id);
    const groups = groupFastagLines(lines);
    expect(groups).toEqual([
      { vehicle: 'KA01AB1234', plaza: 'Electronic City', count: 2, debitMinor: 22_000, creditMinor: 0 },
    ]);
  });
});
