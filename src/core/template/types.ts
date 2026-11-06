export type CellValue = string | number | null;

export interface FormulaCell {
  formula: string;
  result?: string | number;
}

export type Cell = CellValue | FormulaCell;

export interface SheetColumn {
  header: string;
  width: number;
  align?: 'left' | 'right';
  format?: 'text' | 'amount';
}

export interface SheetSpec {
  name: string;
  columns: SheetColumn[];
  rows: Cell[][];
  freezeHeader?: boolean;
}

export interface WorkbookSpec {
  title: string;
  generatedAt: string;
  sheets: SheetSpec[];
}

export function isFormulaCell(cell: Cell): cell is FormulaCell {
  return typeof cell === 'object' && cell !== null && 'formula' in cell;
}

export function formula(formulaText: string, result?: string | number): FormulaCell {
  return result === undefined ? { formula: formulaText } : { formula: formulaText, result };
}
