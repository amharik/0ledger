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

export const MONEY_EVENT_SOURCES = ['statement', 'email', 'manual', 'fastag'] as const;
export type MoneyEventSource = (typeof MONEY_EVENT_SOURCES)[number];

export const MONEY_EVENT_DIRECTIONS = ['in', 'out'] as const;
export type MoneyEventDirection = (typeof MONEY_EVENT_DIRECTIONS)[number];

export const MONEY_EVENT_STATUSES = [
  'captured',
  'suggested',
  'needs_review',
  'posted',
  'ignored',
  'duplicate',
] as const;
export type MoneyEventStatus = (typeof MONEY_EVENT_STATUSES)[number];

export const CLASSIFICATION_MATCH_TYPES = [
  'reference',
  'amount-date-party',
  'narration-keyword',
  'party',
  'tax-hint',
] as const;
export type ClassificationMatchType = (typeof CLASSIFICATION_MATCH_TYPES)[number];

export const CLASSIFICATION_RULE_SOURCES = ['seed', 'owner'] as const;
export type ClassificationRuleSource = (typeof CLASSIFICATION_RULE_SOURCES)[number];

export const CLOSE_ITEM_TYPES = [
  'unreconciled_bank',
  'low_confidence',
  'missing_document',
  'tax_field',
  'duplicate',
  'voucher_error',
] as const;
export type CloseItemType = (typeof CLOSE_ITEM_TYPES)[number];

export const CLOSE_ITEM_STATUSES = ['open', 'resolved', 'asked_ca', 'waived'] as const;
export type CloseItemStatus = (typeof CLOSE_ITEM_STATUSES)[number];

export const CLOSE_ITEM_OWNERS = ['owner', 'ca', 'system'] as const;
export type CloseItemOwner = (typeof CLOSE_ITEM_OWNERS)[number];

export const READINESS_STATUSES = ['ready', 'needs_review', 'not_ready'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const ARTIFACT_SOURCES = ['email', 'statement', 'invoice', 'receipt', 'webmail', 'upload'] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const OBSERVATION_CHANNELS = [
  'upi',
  'upi_cc',
  'upi_lite',
  'pos',
  'ecom',
  'contactless',
  'atm',
  'neft',
  'imps',
  'rtgs',
  'nach',
  'bbps',
  'generic',
] as const;
export type ObservationChannel = (typeof OBSERVATION_CHANNELS)[number];

export const INSTRUMENT_TYPES = [
  'savings',
  'current',
  'card',
  'wallet',
  'upi_lite',
  'loan',
  'nps',
  'ppf',
  'unknown',
] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const CANONICAL_TXN_STATUSES = ['pending', 'posted', 'reversed', 'refunded'] as const;
export type CanonicalTxnStatus = (typeof CANONICAL_TXN_STATUSES)[number];

export const ID_BASES = ['upi', 'utr', 'arn', 'card', 'order', 'fingerprint'] as const;
export type IdBasis = (typeof ID_BASES)[number];

export const OWN_ACCOUNT_TYPES = ['savings', 'current', 'card', 'wallet', 'nps', 'ppf'] as const;
export type OwnAccountType = (typeof OWN_ACCOUNT_TYPES)[number];
