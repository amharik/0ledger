import { describe, expect, it } from 'vitest';
import { verifyStatementBalance } from '@/core/ingest/balance';
import type { StatementLine } from '@/core/model';

function line(overrides: Partial<StatementLine> & Pick<StatementLine, 'lineNo' | 'date'>): StatementLine {
  const { lineNo, date, ...rest } = overrides;
  return {
    id: `stl_${lineNo}`,
    workspaceId: 'w1',
    importBatchId: 'imp_1',
    lineNo,
    date,
    description: 'Statement row',
    debitMinor: 0,
    creditMinor: 0,
    currency: 'INR',
    matchStatus: 'unmatched',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...rest,
  };
}

describe('statement balance verification', () => {
  it('flags the exact running-balance row and page', () => {
    const assertion = verifyStatementBalance([
      line({ lineNo: 1, date: '2026-04-01', balanceMinor: 100_000, page: 1 }),
      line({ lineNo: 2, date: '2026-04-02', debitMinor: 10_000, balanceMinor: 85_000, page: 2 }),
    ]);
    expect(assertion.checked).toBe(1);
    expect(assertion.mismatches[0]).toMatchObject({
      kind: 'running',
      lineNo: 2,
      page: 2,
      expectedMinor: 90_000,
      actualMinor: 85_000,
      differenceMinor: -5_000,
    });
  });

  it('checks opening + credits - debits against the statement closing balance', () => {
    const lines = [
      line({ lineNo: 1, date: '2026-04-01', debitMinor: 10_000, balanceMinor: 90_000, page: 1 }),
    ];
    const matched = verifyStatementBalance(lines, {
      openingBalanceMinor: 100_000,
      closingBalanceMinor: 90_000,
    });
    expect(matched.mismatches).toEqual([]);
    expect(matched.expectedClosingMinor).toBe(90_000);

    const mismatched = verifyStatementBalance(lines, {
      openingBalanceMinor: 100_000,
      closingBalanceMinor: 95_000,
    });
    expect(mismatched.mismatches[0]).toMatchObject({
      kind: 'closing',
      lineNo: 1,
      page: 1,
      expectedMinor: 90_000,
      actualMinor: 95_000,
      differenceMinor: 5_000,
    });
  });
});
