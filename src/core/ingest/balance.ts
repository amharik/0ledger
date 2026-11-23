import type { StatementLine } from '@/core/model';

export interface BalanceMismatch {
  lineNo: number;
  date: string;
  description: string;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
  kind: 'running' | 'closing';
  page?: number;
}

export interface BalanceAssertion {
  checked: number;
  openingMinor?: number;
  closingMinor?: number;
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  expectedClosingMinor?: number;
  closingDifferenceMinor?: number;
  mismatches: BalanceMismatch[];
}

export interface StatementBalanceBoundaries {
  openingBalanceMinor?: number;
  closingBalanceMinor?: number;
}

export function verifyStatementBalance(
  lines: StatementLine[],
  boundaries: StatementBalanceBoundaries = {},
): BalanceAssertion {
  // Sort chronologically by date ascending; if dates match, preserve lineNo order
  const ordered = [...lines].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.lineNo - b.lineNo;
  });
  let previousBalance: number | undefined;
  let openingMinor: number | undefined;
  let closingMinor: number | undefined;
  let lastBalanceLine: StatementLine | undefined;
  let totalDebitsMinor = 0;
  let totalCreditsMinor = 0;
  let checked = 0;
  const mismatches: BalanceMismatch[] = [];

  for (const line of ordered) {
    totalDebitsMinor += line.debitMinor;
    totalCreditsMinor += line.creditMinor;
    if (line.balanceMinor === undefined) continue;
    if (previousBalance === undefined) {
      previousBalance = line.balanceMinor;
      openingMinor = boundaries.openingBalanceMinor ?? line.balanceMinor - line.creditMinor + line.debitMinor;
    } else {
      const expectedMinor = previousBalance + line.creditMinor - line.debitMinor;
      checked += 1;
      if (expectedMinor !== line.balanceMinor) {
        mismatches.push({
          lineNo: line.lineNo,
          date: line.date,
          description: line.description,
          expectedMinor,
          actualMinor: line.balanceMinor,
          differenceMinor: line.balanceMinor - expectedMinor,
          kind: 'running',
          ...(line.page === undefined ? {} : { page: line.page }),
        });
      }
    }
    previousBalance = line.balanceMinor;
    closingMinor = line.balanceMinor;
    lastBalanceLine = line;
  }

  let expectedClosingMinor: number | undefined;
  let closingDifferenceMinor: number | undefined;
  const actualClosingMinor = boundaries.closingBalanceMinor ?? closingMinor;
  const resolvedOpeningMinor = boundaries.openingBalanceMinor ?? openingMinor;
  if (resolvedOpeningMinor !== undefined && actualClosingMinor !== undefined) {
    expectedClosingMinor = resolvedOpeningMinor + totalCreditsMinor - totalDebitsMinor;
    closingDifferenceMinor = actualClosingMinor - expectedClosingMinor;
    if (mismatches.length === 0 && closingDifferenceMinor !== 0) {
      const anchor = lastBalanceLine ?? ordered[ordered.length - 1];
      mismatches.push({
        lineNo: anchor?.lineNo ?? 0,
        date: anchor?.date ?? '',
        description: 'Statement closing balance mismatch',
        expectedMinor: expectedClosingMinor,
        actualMinor: actualClosingMinor,
        differenceMinor: closingDifferenceMinor,
        kind: 'closing',
        ...(anchor?.page === undefined ? {} : { page: anchor.page }),
      });
    }
  }

  return {
    checked,
    totalDebitsMinor,
    totalCreditsMinor,
    ...(resolvedOpeningMinor === undefined ? {} : { openingMinor: resolvedOpeningMinor }),
    ...(actualClosingMinor === undefined ? {} : { closingMinor: actualClosingMinor }),
    ...(expectedClosingMinor === undefined ? {} : { expectedClosingMinor }),
    ...(closingDifferenceMinor === undefined ? {} : { closingDifferenceMinor }),
    mismatches,
  };
}
