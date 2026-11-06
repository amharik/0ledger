import { newId, nowIso } from '@/core/ids';
import type {
  CompanyProfile,
  Ledger,
  NumberingScheme,
  Party,
  Voucher,
  VoucherLine,
} from '@/core/model';

export function makeLedger(overrides: Partial<Ledger> = {}): Ledger {
  const now = nowIso();
  return {
    id: newId('led'),
    workspaceId: newId('ws'),
    name: 'Cash',
    tallyParent: 'Cash-in-Hand',
    nature: 'asset',
    isParty: false,
    isBank: false,
    isCash: true,
    isTax: false,
    isSystem: false,
    openingBalanceMinor: 0,
    currency: 'INR',
    billwise: false,
    costCenterApplicable: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeCompany(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  const now = nowIso();
  return {
    id: newId('co'),
    workspaceId: newId('ws'),
    legalName: 'Acme Traders',
    country: 'IN',
    state: 'Karnataka',
    currency: 'INR',
    booksBegin: '2026-04-01',
    settings: {
      fyStartMonth: 4,
      roundToMinor: 1,
      roundingMode: 'half-up',
      taxRoundingLevel: 'invoice',
      decimalPlaces: 2,
      defaultCurrency: 'INR',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeParty(overrides: Partial<Party> = {}): Party {
  const now = nowIso();
  return {
    id: newId('pty'),
    workspaceId: newId('ws'),
    ledgerId: newId('led'),
    type: 'debtor',
    legalName: 'Customer One',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeVoucher(overrides: Partial<Voucher> = {}): Voucher {
  const now = nowIso();
  return {
    id: newId('vch'),
    workspaceId: newId('ws'),
    voucherType: 'Journal',
    number: 'JRN/2026-27/0001',
    date: '2026-11-06',
    reverseCharge: false,
    status: 'regular',
    currency: 'INR',
    totalDebitMinor: 0,
    totalCreditMinor: 0,
    roundOffAmountMinor: 0,
    source: 'manual',
    groupIds: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeVoucherLine(overrides: Partial<VoucherLine> = {}): VoucherLine {
  const now = nowIso();
  return {
    id: newId('vln'),
    voucherId: newId('vch'),
    workspaceId: newId('ws'),
    lineNo: 1,
    ledgerId: newId('led'),
    amountMinor: 0,
    currency: 'INR',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeScheme(overrides: Partial<NumberingScheme> = {}): NumberingScheme {
  const now = nowIso();
  return {
    id: newId('num'),
    workspaceId: newId('ws'),
    voucherType: 'Journal',
    name: 'Journal default',
    prefix: 'JRN',
    suffix: '',
    separator: '/',
    padding: 4,
    nextNumber: 1,
    startNumber: 1,
    resetPeriod: 'fy',
    allowManualOverride: true,
    enforceUnique: true,
    allowGaps: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

import type { NewVoucher, VoucherLineInput } from '@/core/model';

export function makeLineInput(ledgerId: string, amountMinor: number): VoucherLineInput {
  return {
    ledgerId,
    amountMinor,
    currency: 'INR',
    billAllocations: [],
    costCenterAllocations: [],
    taxAllocations: [],
  };
}

export function makeNewVoucher(
  overrides: Partial<NewVoucher> & Pick<NewVoucher, 'workspaceId' | 'lines'>,
): NewVoucher {
  return {
    voucherType: 'Payment',
    date: '2026-11-06',
    reverseCharge: false,
    status: 'regular',
    currency: 'INR',
    source: 'manual',
    groupIds: [],
    tags: [],
    items: [],
    ...overrides,
  };
}
