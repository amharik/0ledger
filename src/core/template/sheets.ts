import { isFormulaCell, type CellValue, type WorkbookSpec } from './types';

export interface SheetsSheet {
  title: string;
  values: CellValue[][];
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
