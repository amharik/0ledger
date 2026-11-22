import type { ClassificationMatchType, LedgerNature, TallyPrimaryGroup } from '../model';

export const TALLY_GROUP_NATURE: Record<TallyPrimaryGroup, LedgerNature> = {
  'Capital Account': 'equity',
  'Loans (Liability)': 'liability',
  'Current Liabilities': 'liability',
  'Fixed Assets': 'asset',
  'Current Assets': 'asset',
  Investments: 'asset',
  'Sundry Debtors': 'asset',
  'Sundry Creditors': 'liability',
  'Sales Accounts': 'income',
  'Purchase Accounts': 'expense',
  'Direct Income': 'income',
  'Indirect Income': 'income',
  'Direct Expenses': 'expense',
  'Indirect Expenses': 'expense',
  'Bank Accounts': 'asset',
  'Cash-in-Hand': 'asset',
  'Duties & Taxes': 'liability',
  'Suspense Account': 'asset',
  'Branch/Divisions': 'asset',
  'Miscellaneous Expenses (Asset)': 'asset',
};

export interface DefaultLedgerSpec {
  name: string;
  tallyParent: TallyPrimaryGroup;
  nature: LedgerNature;
  isBank?: boolean;
  isCash?: boolean;
  isTax?: boolean;
  isParty?: boolean;
  isSystem?: boolean;
  code?: string;
}

export const DEFAULT_LEDGERS: DefaultLedgerSpec[] = [
  { name: 'Cash', tallyParent: 'Cash-in-Hand', nature: 'asset', isCash: true, code: '1000' },
  {
    name: 'Bank Account',
    tallyParent: 'Bank Accounts',
    nature: 'asset',
    isBank: true,
    code: '1010',
  },
  { name: 'Sales', tallyParent: 'Sales Accounts', nature: 'income', code: '4000' },
  { name: 'Purchases', tallyParent: 'Purchase Accounts', nature: 'expense', code: '5000' },
  { name: 'Discount Given', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5100' },
  { name: 'Discount Received', tallyParent: 'Indirect Income', nature: 'income', code: '4100' },
  { name: 'Round Off', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5900' },
  { name: 'Bank Charges', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5910' },
  { name: 'Interest Paid', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5920' },
  { name: 'Salary', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5930' },
  { name: 'Rent', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5940' },
  { name: 'Local Conveyance', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5950' },
  { name: 'Meals & Entertainment', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5960' },
  { name: 'Software Subscriptions', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5970' },
  { name: 'Office Expenses', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5980' },
  { name: 'Utilities', tallyParent: 'Indirect Expenses', nature: 'expense', code: '5990' },
  { name: 'Interest Received', tallyParent: 'Indirect Income', nature: 'income', code: '4110' },
  { name: 'TDS Payable', tallyParent: 'Duties & Taxes', nature: 'liability', isTax: true, code: '2320' },
  { name: 'Suspense', tallyParent: 'Suspense Account', nature: 'asset', isSystem: true, code: '1999' },
  {
    name: 'Opening Balance Equity',
    tallyParent: 'Capital Account',
    nature: 'equity',
    isSystem: true,
    code: '3000',
  },
  {
    name: 'GST Input CGST',
    tallyParent: 'Duties & Taxes',
    nature: 'asset',
    isTax: true,
    code: '1310',
  },
  {
    name: 'GST Input SGST',
    tallyParent: 'Duties & Taxes',
    nature: 'asset',
    isTax: true,
    code: '1311',
  },
  {
    name: 'GST Input IGST',
    tallyParent: 'Duties & Taxes',
    nature: 'asset',
    isTax: true,
    code: '1312',
  },
  {
    name: 'GST Output CGST',
    tallyParent: 'Duties & Taxes',
    nature: 'liability',
    isTax: true,
    code: '2310',
  },
  {
    name: 'GST Output SGST',
    tallyParent: 'Duties & Taxes',
    nature: 'liability',
    isTax: true,
    code: '2311',
  },
  {
    name: 'GST Output IGST',
    tallyParent: 'Duties & Taxes',
    nature: 'liability',
    isTax: true,
    code: '2312',
  },
];

export interface DefaultNumberingSpec {
  voucherType:
    | 'Sales'
    | 'Purchase'
    | 'Payment'
    | 'Receipt'
    | 'Journal'
    | 'Contra'
    | 'Credit Note'
    | 'Debit Note';
  prefix: string;
}

export const DEFAULT_NUMBERING: DefaultNumberingSpec[] = [
  { voucherType: 'Sales', prefix: 'INV' },
  { voucherType: 'Purchase', prefix: 'PUR' },
  { voucherType: 'Payment', prefix: 'PMT' },
  { voucherType: 'Receipt', prefix: 'RCT' },
  { voucherType: 'Journal', prefix: 'JRN' },
  { voucherType: 'Contra', prefix: 'CTR' },
  { voucherType: 'Credit Note', prefix: 'CRN' },
  { voucherType: 'Debit Note', prefix: 'DBN' },
];

/** First day of the current Indian financial year (April 1 by default). */
export function defaultBooksBegin(fyStartMonth = 4, today = new Date()): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const startYear = month >= fyStartMonth ? year : year - 1;
  const monthText = String(fyStartMonth).padStart(2, '0');
  return `${startYear}-${monthText}-01`;
}

export interface DefaultClassificationRuleSpec {
  name: string;
  matchType: ClassificationMatchType;
  pattern: string;
  ledgerName: string;
  taxHint?: string;
  confidence: number;
}

export const DEFAULT_CLASSIFICATION_RULES: DefaultClassificationRuleSpec[] = [
  { name: 'Bank charges', matchType: 'narration-keyword', pattern: 'bank charge', ledgerName: 'Bank Charges', confidence: 0.94 },
  { name: 'SMS charges', matchType: 'narration-keyword', pattern: 'sms charge', ledgerName: 'Bank Charges', confidence: 0.92 },
  { name: 'Annual card fee', matchType: 'narration-keyword', pattern: 'annual fee', ledgerName: 'Bank Charges', confidence: 0.9 },
  { name: 'Debit interest', matchType: 'narration-keyword', pattern: 'interest charged', ledgerName: 'Interest Paid', confidence: 0.92 },
  { name: 'Debit interest short', matchType: 'narration-keyword', pattern: 'int debit', ledgerName: 'Interest Paid', confidence: 0.88 },
  { name: 'Interest received', matchType: 'narration-keyword', pattern: 'interest received', ledgerName: 'Interest Received', confidence: 0.92 },
  { name: 'Credit interest short', matchType: 'narration-keyword', pattern: 'int credit', ledgerName: 'Interest Received', confidence: 0.88 },
  { name: 'Salary', matchType: 'narration-keyword', pattern: 'salary', ledgerName: 'Salary', confidence: 0.9 },
  { name: 'Rent', matchType: 'narration-keyword', pattern: 'rent', ledgerName: 'Rent', confidence: 0.9 },
  { name: 'GST payment', matchType: 'tax-hint', pattern: 'gst', ledgerName: 'GST Input CGST', taxHint: 'GST', confidence: 0.72 },
  { name: 'TDS payment', matchType: 'tax-hint', pattern: 'tds', ledgerName: 'TDS Payable', taxHint: 'TDS', confidence: 0.8 },
  { name: 'Travel - Uber', matchType: 'narration-keyword', pattern: 'uber', ledgerName: 'Local Conveyance', confidence: 0.9 },
  { name: 'Travel - Ola', matchType: 'narration-keyword', pattern: 'ola', ledgerName: 'Local Conveyance', confidence: 0.9 },
  { name: 'Travel - IRCTC', matchType: 'narration-keyword', pattern: 'irctc', ledgerName: 'Local Conveyance', confidence: 0.9 },
  { name: 'Meals - Swiggy', matchType: 'narration-keyword', pattern: 'swiggy', ledgerName: 'Meals & Entertainment', confidence: 0.9 },
  { name: 'Meals - Zomato', matchType: 'narration-keyword', pattern: 'zomato', ledgerName: 'Meals & Entertainment', confidence: 0.9 },
  { name: 'Software - AWS', matchType: 'narration-keyword', pattern: 'aws', ledgerName: 'Software Subscriptions', confidence: 0.9 },
  { name: 'Software - Google', matchType: 'narration-keyword', pattern: 'google', ledgerName: 'Software Subscriptions', confidence: 0.86 },
  { name: 'Software - Microsoft', matchType: 'narration-keyword', pattern: 'microsoft', ledgerName: 'Software Subscriptions', confidence: 0.88 },
  { name: 'Utilities - electricity', matchType: 'narration-keyword', pattern: 'electricity', ledgerName: 'Utilities', confidence: 0.9 },
  { name: 'Office supplies', matchType: 'narration-keyword', pattern: 'office', ledgerName: 'Office Expenses', confidence: 0.84 },
];
