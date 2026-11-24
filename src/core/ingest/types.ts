export type StatementKind =
  | 'bank'
  | 'fastag'
  | 'nps'
  | 'ppf'
  | 'interest'
  | 'p2p'
  | 'credit_card'
  | 'gift_card'
  | 'giftcard';

export interface ParsedStatementRow {
  date: string;
  valueDate?: string;
  description: string;
  reference?: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor?: number;
  page?: number;
  currency: string;
  raw: Record<string, unknown>;
}

export type StatementExtractor = 'docling-native' | 'docling-ocr' | 'text' | 'csv' | 'xlsx' | 'email';

export interface DepositAccountRef {
  numberMasked: string;
  tail: string;
  description?: string;
  maturityDate?: string;
  principalMinor?: number;
}

export interface ParsedStatementMetadata {
  accountNumberMasked?: string;
  accountTail?: string;
  accountCategory?:
    | 'bank_account'
    | 'credit_card'
    | 'wallet'
    | 'loan'
    | 'investment'
    | 'shopping'
    | 'gift_card';
  institution?: string;
  accountHolder?: string;
  ifsc?: string;
  branch?: string;
  statementFrom?: string;
  statementTo?: string;
  fixedDeposits?: DepositAccountRef[];
  ppfAccounts?: DepositAccountRef[];
  pageCount?: number;
  textPages?: number;
  ocrPages?: number;
  extractor?: StatementExtractor;
  repairedRows?: number;
}

export interface ParsedStatement {
  adapterId: string;
  adapterName: string;
  kind: StatementKind;
  currency: string;
  rows: ParsedStatementRow[];
  openingBalanceMinor?: number;
  closingBalanceMinor?: number;
  sourceText?: string;
  metadata?: ParsedStatementMetadata;
}

export interface PdfExtractionProgress {
  request_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  message: string;
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
  onProgress?: (progress: PdfExtractionProgress) => void;
}

export interface IngestFileInput {
  fileName: string;
  mimeType?: string;
  bytes?: ArrayBuffer | Uint8Array;
  text?: string;
  password?: string;
}
