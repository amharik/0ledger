import { describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import {
  checkTallyReadiness,
  computeTotals,
  validateLineBalance,
  validateNewVoucherInput,
} from '@/core/ledger/validation';
import { makeCompany, makeLedger, makeParty, makeScheme, makeVoucher, makeVoucherLine } from './fixtures';

describe('voucher balance', () => {
  it('accepts a balanced voucher', () => {
    const result = validateLineBalance([
      { currency: 'INR', amountMinor: 50_000 },
      { currency: 'INR', amountMinor: -50_000 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects an unbalanced voucher', () => {
    const result = validateLineBalance([
      { currency: 'INR', amountMinor: 50_000 },
      { currency: 'INR', amountMinor: -49_999 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'voucher.unbalanced')).toBe(true);
  });

  it('computes debit/credit totals', () => {
    const totals = computeTotals([
      { currency: 'INR', amountMinor: 100 },
      { currency: 'INR', amountMinor: -100 },
      { currency: 'INR', amountMinor: 50 },
      { currency: 'INR', amountMinor: -50 },
    ]);
    expect(totals.totalDebitMinor).toBe(150);
    expect(totals.totalCreditMinor).toBe(150);
    expect(totals.byCurrency.INR?.net).toBe(0);
  });
});

describe('new voucher input', () => {
  it('requires a party for sales invoices', () => {
    const workspaceId = newId('ws');
    const result = validateNewVoucherInput({
      workspaceId,
      voucherType: 'Sales',
      date: '2026-11-06',
      reverseCharge: false,
      status: 'regular',
      currency: 'INR',
      source: 'manual',
      groupIds: [],
      tags: [],
      items: [],
      lines: [
        {
          ledgerId: newId('led'),
          amountMinor: 100_000,
          currency: 'INR',
          billAllocations: [],
          costCenterAllocations: [],
          taxAllocations: [],
        },
        {
          ledgerId: newId('led'),
          amountMinor: -100_000,
          currency: 'INR',
          billAllocations: [],
          costCenterAllocations: [],
          taxAllocations: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'voucher.party-required')).toBe(true);
  });
});

describe('tally readiness', () => {
  function readySet() {
    const workspaceId = newId('ws');
    const company = makeCompany({ workspaceId, state: 'Karnataka' });
    const cash = makeLedger({
      workspaceId,
      name: 'Cash',
      tallyParent: 'Cash-in-Hand',
      nature: 'asset',
      isCash: true,
    });
    const partyLedger = makeLedger({
      workspaceId,
      name: 'Customer One',
      tallyParent: 'Sundry Debtors',
      nature: 'asset',
      isParty: true,
      billwise: true,
    });
    const sales = makeLedger({
      workspaceId,
      name: 'Sales',
      tallyParent: 'Sales Accounts',
      nature: 'income',
    });
    const roundOff = makeLedger({
      workspaceId,
      name: 'Round Off',
      tallyParent: 'Indirect Expenses',
      nature: 'expense',
    });
    const party = makeParty({ workspaceId, ledgerId: partyLedger.id, legalName: 'Customer One' });
    const voucher = makeVoucher({
      workspaceId,
      voucherType: 'Sales',
      number: 'INV/2026-27/0001',
      invoiceNumber: 'INV-001',
      partyLedgerId: partyLedger.id,
      totalDebitMinor: 100_000,
      totalCreditMinor: 100_000,
    });
    const lines = [
      makeVoucherLine({
        workspaceId,
        voucherId: voucher.id,
        ledgerId: partyLedger.id,
        amountMinor: 100_000,
        lineNo: 1,
      }),
      makeVoucherLine({
        workspaceId,
        voucherId: voucher.id,
        ledgerId: sales.id,
        amountMinor: -100_000,
        lineNo: 2,
      }),
    ];
    const scheme = makeScheme({ workspaceId, voucherType: 'Sales', prefix: 'INV' });
    return { workspaceId, company, cash, partyLedger, sales, roundOff, party, voucher, lines, scheme };
  }

  it('passes a complete ledger', () => {
    const set = readySet();
    const result = checkTallyReadiness({
      company: set.company,
      ledgers: [set.cash, set.partyLedger, set.sales, set.roundOff],
      parties: [set.party],
      vouchers: [set.voucher],
      lines: set.lines,
      numberingSchemes: [set.scheme],
    });
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags a party ledger with no party master', () => {
    const set = readySet();
    const result = checkTallyReadiness({
      company: set.company,
      ledgers: [set.cash, set.partyLedger, set.sales],
      parties: [],
      vouchers: [set.voucher],
      lines: set.lines,
      numberingSchemes: [set.scheme],
    });
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => issue.code === 'ledger.party-master-missing'),
    ).toBe(true);
  });

  it('flags duplicate voucher numbers in the same FY', () => {
    const set = readySet();
    const duplicate = { ...set.voucher, id: newId('vch') };
    const result = checkTallyReadiness({
      company: set.company,
      ledgers: [set.cash, set.partyLedger, set.sales],
      parties: [set.party],
      vouchers: [set.voucher, duplicate],
      lines: set.lines,
      numberingSchemes: [set.scheme],
    });
    expect(result.issues.some((issue) => issue.code === 'voucher.duplicate-number')).toBe(true);
  });
});
