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

export type IngestBatchState =
  | 'RECEIVED'
  | 'QUEUED'
  | 'EXTRACTING'
  | 'FINGERPRINTING'
  | 'AUTO_MAPPED'
  | 'NEEDS_MAPPING'
  | 'SCRUTINY_REQUIRED'
  | 'RECONCILED'
  | 'COMMITTED'
  | 'ABORTED';

export type ColumnRole =
  | 'date'
  | 'valueDate'
  | 'description'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'type'
  | 'balance'
  | 'reference'
  | 'ignore';

export interface ExtractedTableDto {
  tableIndex: number;
  rawHeaders: string[];
  rawRows: string[][];
}

export interface IngestBatchDto {
  idKey: string;
  workspaceId: string;
  bankAccountId?: string;
  sourceType: string;
  sourceReference?: string;
  contentSha256: string;
  senderAddress?: string;
  state: IngestBatchState;
  statementKind: string;
  institutionSlug?: string;
  accountTail?: string;
  totalRows: number;
  reconciledRows: number;
  skippedDuplicateCount: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StatementTemplateDto {
  idKey: string;
  workspaceId: string;
  institutionSlug: string;
  statementKind: string;
  headerFingerprint: string;
  columnMappings: Record<string, ColumnRole>;
  createdAt: string;
  updatedAt: string;
}

export interface StatementSummaryDto {
  openingBalanceMinor?: number;
  closingBalanceMinor?: number;
  previousBalanceMinor?: number;
  totalDueMinor?: number;
  summaryDebitsMinor?: number;
  summaryCreditsMinor?: number;
}

export interface ParsedIngestRowDto {
  rowIndex: number;
  date: string;
  valueDate?: string;
  description: string;
  reference?: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor?: number;
  narrationNorm: string;
  dailyRank: number;
}

export interface BalanceDiscrepancyDto {
  rowIndex?: number;
  expectedMinor: number;
  actualMinor: number;
  deltaMinor: number;
  message: string;
}

export interface IngestBatchStatusResponse {
  batch: IngestBatchDto;
  tables: ExtractedTableDto[];
  template?: StatementTemplateDto;
  discrepancies: BalanceDiscrepancyDto[];
}

export interface AuditPatchDto {
  field: string;
  rawValue: string;
  repairedValue: number;
  repairType: string;
  actor: string;
  rationale: string;
}

export interface ForcePostAssertionDto {
  actor: string;
  rationale: string;
  discrepancyMinor: number;
}
