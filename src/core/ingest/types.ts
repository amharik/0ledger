export type StatementKind = 'bank' | 'fastag';

export interface ParsedStatementRow {
  date: string;
  valueDate?: string;
  description: string;
  reference?: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor?: number;
  currency: string;
  raw: Record<string, unknown>;
}

export interface ParsedStatement {
  adapterId: string;
  adapterName: string;
  kind: StatementKind;
  currency: string;
  rows: ParsedStatementRow[];
  sourceText?: string;
}

export interface StatementAdapter {
  id: string;
  name: string;
  kind: StatementKind;
  markers: string[];
  filePatterns?: string[];
}

export interface ParseStatementOptions {
  adapterId?: string;
  fileName?: string;
  currency?: string;
}

export interface IngestFileInput {
  fileName: string;
  mimeType?: string;
  bytes?: ArrayBuffer | Uint8Array;
  text?: string;
  password?: string;
}
