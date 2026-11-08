import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type LedgerDatabase } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import { postVoucher } from '@/core/ledger/post-voucher';
import { trialBalance } from '@/core/ledger/reports';
import { makeLineInput } from './fixtures';

const databases: LedgerDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    await db.delete();
    db.close();
  }
});

describe.runIf(process.env.STRESS === '1')('release gate: 10k vouchers', () => {
  it('posts 10,000 balanced journals without drift', { timeout: 180_000 }, async () => {
    const db = createTestDb();
    databases.push(db);
    const bundle = await createWorkspace(db, {
      name: 'Stress Co',
      state: 'Karnataka',
      booksBegin: '2026-04-01',
    });
    const cash = bundle.ledgers.find((ledger) => ledger.name === 'Cash')!;
    const expenses = bundle.ledgers.find((ledger) => ledger.name === 'Purchases')!;
    const date = '2026-04-15';

    for (let index = 0; index < 10_000; index += 1) {
      await postVoucher(db, {
        workspaceId: bundle.workspace.id,
        voucherType: 'Journal',
        date,
        narration: `Stress entry ${index + 1}`,
        currency: 'INR',
        reverseCharge: false,
        status: 'regular',
        source: 'manual',
        groupIds: [],
        tags: [],
        lines: [makeLineInput(expenses.id, 100), makeLineInput(cash.id, -100)],
      });
    }

    const vouchers = await db.vouchers.where('workspaceId').equals(bundle.workspace.id).count();
    const lines = await db.voucherLines.where('workspaceId').equals(bundle.workspace.id).toArray();
    const tb = await trialBalance(db, bundle.workspace.id);

    expect(vouchers).toBe(10_000);
    expect(lines).toHaveLength(20_000);
    expect(lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(0);
    expect(tb.balanced).toBe(true);
  });
});
