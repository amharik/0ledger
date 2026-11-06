import { isFormulaCell, type WorkbookSpec } from './types';

export async function renderWorkbookXlsx(spec: WorkbookSpec): Promise<ArrayBuffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '0ledger';
  workbook.title = spec.title;
  workbook.created = new Date(spec.generatedAt);
  workbook.modified = new Date(spec.generatedAt);

  for (const sheetSpec of spec.sheets) {
    const sheet = workbook.addWorksheet(sheetSpec.name, {
      views: sheetSpec.freezeHeader ? [{ state: 'frozen' as const, ySplit: 1 }] : [],
    });

    sheet.columns = sheetSpec.columns.map((column) => ({
      header: column.header,
      width: column.width,
      style: { alignment: { horizontal: column.align ?? 'left' } },
    }));

    for (const row of sheetSpec.rows) {
      sheet.addRow(
        row.map((cell) => {
          if (isFormulaCell(cell)) {
            const formula = cell.formula.replace(/^=/, '');
            return cell.result === undefined ? { formula } : { formula, result: cell.result };
          }
          return cell;
        }),
      );
    }

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F2937' },
    };
    header.alignment = { vertical: 'middle' };

    if (sheetSpec.columns.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheetSpec.columns.length },
      };
    }

    sheetSpec.columns.forEach((column, index) => {
      if (column.format === 'amount') {
        sheet.getColumn(index + 1).numFmt = '#,##0.00';
      }
    });
  }

  const output = await workbook.xlsx.writeBuffer();
  return output instanceof ArrayBuffer ? output : new Uint8Array(output).buffer;
}
