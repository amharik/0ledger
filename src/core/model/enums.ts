export const LEDGER_NATURES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type LedgerNature = (typeof LEDGER_NATURES)[number];

/** Tally primary groups. Custom sub-groups hang off these. */
export const TALLY_PRIMARY_GROUPS = [
  'Capital Account',
  'Loans (Liability)',
  'Current Liabilities',
  'Fixed Assets',
  'Current Assets',
  'Investments',
  'Sundry Debtors',
  'Sundry Creditors',
  'Sales Accounts',
  'Purchase Accounts',
  'Direct Income',
  'Indirect Income',
  'Direct Expenses',
  'Indirect Expenses',
  'Bank Accounts',
  'Cash-in-Hand',
  'Duties & Taxes',
  'Suspense Account',
  'Branch/Divisions',
  'Miscellaneous Expenses (Asset)',
] as const;
export type TallyPrimaryGroup = (typeof TALLY_PRIMARY_GROUPS)[number];

export const VOUCHER_TYPES = [
  'Contra',
  'Payment',
  'Receipt',
  'Journal',
  'Sales',
  'Purchase',
  'Credit Note',
  'Debit Note',
  'Delivery Note',
  'Receipt Note',
  'Rejection In',
  'Rejection Out',
  'Stock Journal',
  'Physical Stock',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export const VOUCHER_STATUSES = ['regular', 'optional', 'cancelled'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const VOUCHER_SOURCES = [
  'manual',
  'email',
  'statement',
  'fastag',
  'import',
  'system',
] as const;
export type VoucherSource = (typeof VOUCHER_SOURCES)[number];

export const BILL_TYPES = ['New Ref', 'Against Ref', 'Advance', 'On Account'] as const;
export type BillType = (typeof BILL_TYPES)[number];

export const TAX_TYPES = ['CGST', 'SGST', 'IGST', 'CESS', 'TDS', 'TCS', 'VAT', 'Other'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

export const PARTY_TYPES = ['debtor', 'creditor', 'both'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const NUMBERING_RESET_PERIODS = ['never', 'yearly', 'fy', 'monthly'] as const;
export type NumberingResetPeriod = (typeof NUMBERING_RESET_PERIODS)[number];

export const ROUNDING_MODES = ['half-up', 'half-even'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const TAX_ROUNDING_LEVELS = ['line', 'invoice'] as const;
export type TaxRoundingLevel = (typeof TAX_ROUNDING_LEVELS)[number];

export const IMPORT_SOURCES = ['email', 'csv', 'xlsx', 'pdf', 'fastag', 'manual'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = [
  'staged',
  'reviewing',
  'committed',
  'failed',
  'cancelled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const MATCH_STATUSES = ['unmatched', 'suggested', 'matched', 'ignored'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const RECONCILIATION_METHODS = ['reference', 'amount-date', 'fuzzy', 'manual'] as const;
export type ReconciliationMethod = (typeof RECONCILIATION_METHODS)[number];

export const RECONCILIATION_STATUSES = ['suggested', 'confirmed', 'rejected'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];
