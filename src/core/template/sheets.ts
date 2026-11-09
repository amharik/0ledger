import { isFormulaCell, type CellValue, type WorkbookSpec } from './types';

export interface SheetsSheet {
  title: string;
  values: CellValue[][];
}

export interface SheetFormula {
  row: number;
  column: number;
  formula: string;
}

/** Actual formula cells only. Plain strings starting with "=" are never promoted. */
export function formulaCells(spec: WorkbookSpec): Map<string, SheetFormula[]> {
  const result = new Map<string, SheetFormula[]>();
  for (const sheet of spec.sheets) {
    const formulas: SheetFormula[] = [];
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (!isFormulaCell(cell)) return;
        formulas.push({
          row: rowIndex + 2,
          column: columnIndex,
          formula: `=${cell.formula.replace(/^=/, '')}`,
        });
      });
    });
    result.set(sheet.name, formulas);
  }
  return result;
}

export function renderSheetsValues(spec: WorkbookSpec): SheetsSheet[] {
  return spec.sheets.map((sheet) => ({
    title: sheet.name,
    values: [
      sheet.columns.map((column) => column.header),
      ...sheet.rows.map((row) =>
        row.map((cell): CellValue => (isFormulaCell(cell) ? `=${cell.formula.replace(/^=/, '')}` : cell)),
      ),
    ],
  }));
}
