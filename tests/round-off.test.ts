import { describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { appendRoundOff } from '@/core/ledger/round-off';
import { sumMinor } from '@/core/money/money';

describe('appendRoundOff', () => {
  it('posts an explicit rounding line so the voucher still balances', () => {
    const roundOffLedgerId = newId('led');
    const lines = [
      {
        ledgerId: newId('led'),
        amountMinor: 123_456,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
      {
        ledgerId: newId('led'),
        amountMinor: -123_456,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
    ];
    const result = appendRoundOff(lines, {
      ledgerId: roundOffLedgerId,
      stepMinor: 100,
      settlementLineIndex: 1,
    });
    expect(result.roundOffMinor).toBe(44);
    expect(result.roundedSettlementMinor).toBe(-123_500);
    expect(result.originalSettlementMinor).toBe(-123_456);
    expect(sumMinor(result.lines.map((line) => line.amountMinor))).toBe(0);
    expect(result.lines.at(-1)?.ledgerId).toBe(roundOffLedgerId);
    expect(result.lines[1]?.amountMinor).toBe(-123_500);
  });

  it('rounds a debit-side settlement and posts the opposite sign', () => {
    const lines = [
      {
        ledgerId: newId('led'),
        amountMinor: 123_456,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
      {
        ledgerId: newId('led'),
        amountMinor: -123_456,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
    ];
    const result = appendRoundOff(lines, {
      ledgerId: newId('led'),
      stepMinor: 100,
      settlementLineIndex: 0,
    });
    expect(result.roundOffMinor).toBe(-44);
    expect(result.roundedSettlementMinor).toBe(123_500);
    expect(sumMinor(result.lines.map((line) => line.amountMinor))).toBe(0);
  });

  it('adds nothing when the amount is already a multiple', () => {
    const lines = [
      {
        ledgerId: newId('led'),
        amountMinor: 123_400,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
      {
        ledgerId: newId('led'),
        amountMinor: -123_400,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
    ];
    const result = appendRoundOff(lines, {
      ledgerId: newId('led'),
      stepMinor: 100,
      settlementLineIndex: 1,
    });
    expect(result.roundOffMinor).toBe(0);
    expect(result.lines).toHaveLength(2);
  });

  it('refuses to hide an existing imbalance', () => {
    const lines = [
      {
        ledgerId: newId('led'),
        amountMinor: 100,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
      {
        ledgerId: newId('led'),
        amountMinor: -90,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
    ];
    expect(() =>
      appendRoundOff(lines, {
        ledgerId: newId('led'),
        stepMinor: 100,
        settlementLineIndex: 1,
      }),
    ).toThrow();
  });
});
