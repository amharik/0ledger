import type { LedgerNature, TallyPrimaryGroup } from '../model';

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
