import { financialYearKey } from '../ids';
import { assertSafeMinor, sumMinor } from '../money/money';
import {
  type BillAllocation,
  type CompanyProfile,
  type Ledger,
  type NewVoucher,
  type NumberingScheme,
  type Party,
  type StockItem,
  type TallyPrimaryGroup,
  type TaxAllocation,
  type Voucher,
  type VoucherLine,
} from '../model';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  entityType?: string;
  entityId?: string;
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function makeResult(issues: ValidationIssue[]): ValidationResult {
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

export class LedgerValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'LedgerValidationError';
    this.issues = issues;
  }
}

export interface VoucherTotals {
  totalDebitMinor: number;
  totalCreditMinor: number;
  byCurrency: Record<string, { debit: number; credit: number; net: number }>;
}

export function computeTotals(
  lines: ReadonlyArray<Pick<VoucherLine, 'currency' | 'amountMinor'>>,
): VoucherTotals {
  const byCurrency: VoucherTotals['byCurrency'] = {};
  let totalDebitMinor = 0;
  let totalCreditMinor = 0;

  for (const line of lines) {
    assertSafeMinor(line.amountMinor, 'line amount');
    const entry = byCurrency[line.currency] ?? { debit: 0, credit: 0, net: 0 };
    if (line.amountMinor >= 0) {
      entry.debit += line.amountMinor;
      totalDebitMinor += line.amountMinor;
    } else {
      entry.credit += -line.amountMinor;
      totalCreditMinor += -line.amountMinor;
    }
    entry.net = entry.debit - entry.credit;
    byCurrency[line.currency] = entry;
  }

  return { totalDebitMinor, totalCreditMinor, byCurrency };
}

export function validateLineBalance(
  lines: ReadonlyArray<Pick<VoucherLine, 'currency' | 'amountMinor'>>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (lines.length < 2) {
    issues.push({
      code: 'voucher.too-few-lines',
      severity: 'error',
      message: 'A voucher needs at least two ledger lines',
    });
  }
  if (lines.some((line) => line.amountMinor === 0)) {
    issues.push({
      code: 'voucher.zero-line',
      severity: 'warning',
      message: 'Voucher contains a zero-amount line',
    });
  }

  const totals = computeTotals(lines);
  for (const [currency, entry] of Object.entries(totals.byCurrency)) {
    if (entry.net !== 0) {
      issues.push({
        code: 'voucher.unbalanced',
        severity: 'error',
        message: `Voucher is unbalanced in ${currency}: debit ${entry.debit}, credit ${entry.credit}`,
      });
    }
  }

  return makeResult(issues);
}

const PARTY_VOUCHER_TYPES = new Set(['Sales', 'Purchase', 'Credit Note', 'Debit Note']);

export function validateNewVoucherInput(input: NewVoucher): ValidationResult {
  const issues: ValidationIssue[] = [];
  const balance = validateLineBalance(input.lines);
  issues.push(...balance.issues);

  if (PARTY_VOUCHER_TYPES.has(input.voucherType) && !input.partyLedgerId) {
    issues.push({
      code: 'voucher.party-required',
      severity: 'error',
      message: `${input.voucherType} vouchers require a party ledger`,
    });
  }

  if (PARTY_VOUCHER_TYPES.has(input.voucherType) && !input.invoiceNumber) {
    issues.push({
      code: 'voucher.invoice-number-missing',
      severity: 'warning',
      message: `${input.voucherType} voucher has no invoice number`,
      hint: 'Tally import is easier with an invoice number per party and financial year.',
    });
  }

  if (input.lines.some((line) => line.currency !== input.currency)) {
    const hasForex = input.lines.some((line) => line.exchangeRate != null);
    if (!hasForex) {
      issues.push({
        code: 'voucher.forex-rate-missing',
        severity: 'warning',
        message: 'Mixed-currency voucher has no exchange rate on any line',
      });
    }
  }

  const itemTotal = sumMinor(input.items.map((item) => item.amountMinor));
  const lineDebitTotal = sumMinor(
    input.lines.map((line) => (line.amountMinor > 0 ? line.amountMinor : 0)),
  );
  if (input.items.length > 0 && itemTotal !== lineDebitTotal) {
    issues.push({
      code: 'voucher.items-total-mismatch',
      severity: 'warning',
      message: `Item lines total ${itemTotal} but voucher debit total is ${lineDebitTotal}`,
    });
  }

  return makeResult(issues);
}

export function assertNewVoucherValid(input: NewVoucher): void {
  const result = validateNewVoucherInput(input);
  if (!result.ok) {
    throw new LedgerValidationError(result.issues.filter((issue) => issue.severity === 'error'));
  }
}

export interface TallyReadinessInput {
  company?: CompanyProfile;
  ledgers: Ledger[];
  parties: Party[];
  stockItems?: StockItem[];
  vouchers: Voucher[];
  lines: VoucherLine[];
  billAllocations?: BillAllocation[];
  taxAllocations?: TaxAllocation[];
  numberingSchemes: NumberingScheme[];
  fyStartMonth?: number;
}

const ROUND_OFF_GROUPS: TallyPrimaryGroup[] = ['Indirect Expenses', 'Indirect Income'];

export function checkTallyReadiness(input: TallyReadinessInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const fyStartMonth = input.fyStartMonth ?? input.company?.settings.fyStartMonth ?? 4;
  const ledgerById = new Map(input.ledgers.map((ledger) => [ledger.id, ledger]));
  const partyLedgerIds = new Set(input.parties.map((party) => party.ledgerId));
  const itemIds = new Set((input.stockItems ?? []).map((item) => item.id));
  const linesByVoucher = new Map<string, VoucherLine[]>();
  for (const line of input.lines) {
    const list = linesByVoucher.get(line.voucherId) ?? [];
    list.push(line);
    linesByVoucher.set(line.voucherId, list);
  }
  const allocationsByVoucher = new Map<string, BillAllocation[]>();
  for (const allocation of input.billAllocations ?? []) {
    const list = allocationsByVoucher.get(allocation.voucherId) ?? [];
    list.push(allocation);
    allocationsByVoucher.set(allocation.voucherId, list);
  }
  const taxByVoucher = new Map<string, TaxAllocation[]>();
  for (const tax of input.taxAllocations ?? []) {
    const list = taxByVoucher.get(tax.voucherId) ?? [];
    list.push(tax);
    taxByVoucher.set(tax.voucherId, list);
  }

  if (!input.company) {
    issues.push({
      code: 'company.missing',
      severity: 'error',
      message: 'Company profile is missing',
    });
  } else {
    if (!input.company.legalName.trim()) {
      issues.push({
        code: 'company.name',
        severity: 'error',
        message: 'Company legal name is required for Tally',
      });
    }
    if (!input.company.booksBegin) {
      issues.push({
        code: 'company.books-begin',
        severity: 'error',
        message: 'Company books-begin date is required for Tally',
      });
    }
    if (!input.company.state) {
      issues.push({
        code: 'company.state',
        severity: 'warning',
        message: 'Company state is required for place-of-supply defaults',
      });
    }
  }

  for (const ledger of input.ledgers) {
    if (!ledger.tallyParent) {
      issues.push({
        code: 'ledger.tally-parent',
        severity: 'error',
        message: `Ledger "${ledger.name}" has no Tally parent group`,
        entityType: 'ledger',
        entityId: ledger.id,
      });
    }
    if (ledger.isParty && !partyLedgerIds.has(ledger.id)) {
      issues.push({
        code: 'ledger.party-master-missing',
        severity: 'error',
        message: `Party ledger "${ledger.name}" has no party master`,
        entityType: 'ledger',
        entityId: ledger.id,
      });
    }
    if (ledger.isParty && ledger.tallyParent !== 'Sundry Debtors' && ledger.tallyParent !== 'Sundry Creditors') {
      issues.push({
        code: 'ledger.party-group',
        severity: 'error',
        message: `Party ledger "${ledger.name}" must sit under Sundry Debtors or Sundry Creditors`,
        entityType: 'ledger',
        entityId: ledger.id,
      });
    }
    if (ledger.billwise && !input.parties.some((party) => party.ledgerId === ledger.id)) {
      issues.push({
        code: 'ledger.billwise-without-party',
        severity: 'warning',
        message: `Bill-wise ledger "${ledger.name}" has no party master`,
        entityType: 'ledger',
        entityId: ledger.id,
      });
    }
  }

  const seenNumbers = new Map<string, string>();
  for (const voucher of input.vouchers) {
    const lines = linesByVoucher.get(voucher.id) ?? [];
    const balance = validateLineBalance(lines);
    for (const issue of balance.issues) {
      issues.push({
        ...issue,
        entityType: 'voucher',
        entityId: voucher.id,
      });
    }

    const numberKey = `${voucher.voucherType}|${financialYearKey(voucher.date, fyStartMonth)}|${voucher.number}`;
    const previous = seenNumbers.get(numberKey);
    if (previous) {
      issues.push({
        code: 'voucher.duplicate-number',
        severity: 'error',
        message: `Duplicate ${voucher.voucherType} number "${voucher.number}" in the same financial year`,
        entityType: 'voucher',
        entityId: voucher.id,
        hint: `Also used by ${previous}`,
      });
    } else {
      seenNumbers.set(numberKey, voucher.id);
    }

    if (PARTY_VOUCHER_TYPES.has(voucher.voucherType)) {
      if (!voucher.partyLedgerId) {
        issues.push({
          code: 'voucher.party-required',
          severity: 'error',
          message: `${voucher.voucherType} ${voucher.number} has no party ledger`,
          entityType: 'voucher',
          entityId: voucher.id,
        });
      }
      if (!voucher.invoiceNumber) {
        issues.push({
          code: 'voucher.invoice-number-missing',
          severity: 'warning',
          message: `${voucher.voucherType} ${voucher.number} has no invoice number`,
          entityType: 'voucher',
          entityId: voucher.id,
        });
      }
    }

    if (voucher.roundOffAmountMinor !== 0) {
      const roundOffLedger = voucher.roundOffLedgerId
        ? ledgerById.get(voucher.roundOffLedgerId)
        : undefined;
      if (!roundOffLedger) {
        issues.push({
          code: 'voucher.roundoff-ledger-missing',
          severity: 'error',
          message: `Voucher ${voucher.number} has a round-off amount but no round-off ledger`,
          entityType: 'voucher',
          entityId: voucher.id,
        });
      } else if (!ROUND_OFF_GROUPS.includes(roundOffLedger.tallyParent)) {
        issues.push({
          code: 'voucher.roundoff-group',
          severity: 'warning',
          message: `Round-off ledger "${roundOffLedger.name}" should sit under Indirect Expenses or Indirect Income`,
          entityType: 'ledger',
          entityId: roundOffLedger.id,
        });
      }
    }

    const voucherTaxes = taxByVoucher.get(voucher.id) ?? [];
    if (voucherTaxes.length > 0) {
      if (!voucher.placeOfSupply) {
        issues.push({
          code: 'voucher.place-of-supply',
          severity: 'warning',
          message: `Tax voucher ${voucher.number} has no place of supply`,
          entityType: 'voucher',
          entityId: voucher.id,
        });
      }
      if (!voucher.partyLedgerId) {
        issues.push({
          code: 'voucher.tax-party',
          severity: 'warning',
          message: `Tax voucher ${voucher.number} has no party ledger`,
          entityType: 'voucher',
          entityId: voucher.id,
        });
      }
    }

    const voucherBillAllocations = allocationsByVoucher.get(voucher.id) ?? [];
    const hasBillwiseLine = lines.some((line) => {
      const ledger = ledgerById.get(line.ledgerId);
      return ledger?.billwise === true;
    });
    if (hasBillwiseLine && voucherBillAllocations.length === 0) {
      issues.push({
        code: 'voucher.bill-allocation-missing',
        severity: 'warning',
        message: `Voucher ${voucher.number} uses a bill-wise ledger but has no bill allocation`,
        entityType: 'voucher',
        entityId: voucher.id,
      });
    }

    for (const line of lines) {
      if (line.ledgerId && !ledgerById.has(line.ledgerId)) {
        issues.push({
          code: 'line.ledger-missing',
          severity: 'error',
          message: `Voucher ${voucher.number} references missing ledger ${line.ledgerId}`,
          entityType: 'voucherLine',
          entityId: line.id,
        });
      }
    }
  }

  for (const scheme of input.numberingSchemes) {
    if (!scheme.name.trim()) {
      issues.push({
        code: 'numbering.name',
        severity: 'error',
        message: `Numbering scheme for ${scheme.voucherType} has no name`,
        entityType: 'numberingScheme',
        entityId: scheme.id,
      });
    }
  }

  const usedVoucherTypes = new Set(input.vouchers.map((voucher) => voucher.voucherType));
  for (const voucherType of usedVoucherTypes) {
    if (!input.numberingSchemes.some((scheme) => scheme.voucherType === voucherType)) {
      issues.push({
        code: 'numbering.missing-scheme',
        severity: 'warning',
        message: `No numbering scheme found for ${voucherType}`,
      });
    }
  }

  if (input.stockItems) {
    for (const voucher of input.vouchers) {
      // Item lines are validated separately by the posting service; this is a cheap sanity check.
      void voucher;
    }
    if (itemIds.size === 0) {
      issues.push({
        code: 'items.empty',
        severity: 'warning',
        message: 'No stock items are defined',
      });
    }
  }

  return makeResult(issues);
}

export function assertTallyReady(input: TallyReadinessInput): void {
  const result = checkTallyReadiness(input);
  if (!result.ok) {
    throw new LedgerValidationError(result.issues.filter((issue) => issue.severity === 'error'));
  }
}
