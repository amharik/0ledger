import type { WorkbookData } from './data';
import type { Cell } from './types';

export interface WorkbookSnapshot {
  version: 1;
  tables: Record<string, unknown[]>;
}

export function buildSnapshot(data: WorkbookData): WorkbookSnapshot {
  return {
    version: 1,
    tables: {
      workspaces: [data.workspace],
      companies: [data.company],
      ledgerGroups: data.groups,
      ledgers: data.ledgers,
      parties: data.parties,
      stockItems: data.stockItems,
      godowns: data.godowns,
      batches: data.batches,
      costCenters: data.costCenters,
      numberingSchemes: data.numberingSchemes,
      vouchers: data.vouchers,
      voucherLines: data.voucherLines,
      itemLines: data.itemLines,
      billAllocations: data.billAllocations,
      costCenterAllocations: data.costCenterAllocations,
      taxAllocations: data.taxAllocations,
      statementLines: data.statementLines,
      reconciliations: data.reconciliations,
      auditEvents: data.auditEvents,
    },
  };
}

export function snapshotChunks(data: WorkbookData, maxChars = 45_000): string[] {
  const json = JSON.stringify(buildSnapshot(data));
  const chunks: string[] = [];
  for (let index = 0; index < json.length; index += maxChars) {
    chunks.push(json.slice(index, index + maxChars));
  }
  return chunks.length > 0 ? chunks : [''];
}

export function snapshotRows(data: WorkbookData): Cell[][] {
  return snapshotChunks(data).map((chunk, index) => [index + 1, chunk]);
}

export function parseSnapshotChunks(values: unknown[][]): WorkbookSnapshot {
  const parts = values
    .map((row) => ({ index: Number(row[0] ?? 0), chunk: String(row[1] ?? '') }))
    .filter((row) => row.chunk.length > 0)
    .sort((a, b) => a.index - b.index);
  if (parts.length === 0) throw new Error('Workbook has no snapshot data');
  const parsed = JSON.parse(parts.map((part) => part.chunk).join('')) as WorkbookSnapshot;
  if (parsed.version !== 1 || typeof parsed.tables !== 'object' || parsed.tables === null) {
    throw new Error('Unsupported workbook snapshot');
  }
  return parsed;
}
