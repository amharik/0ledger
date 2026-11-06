import {
  addMinor,
  assertSafeMinor,
  roundOffDifference,
  roundToStep,
  sumMinor,
  type RoundingMode,
} from '../money/money';
import type { VoucherLineInput } from '../model';

export interface RoundOffOptions {
  ledgerId: string;
  /** Round to this multiple of minor units, e.g. 100 paise = nearest rupee. */
  stepMinor: number;
  mode?: RoundingMode;
  narration?: string;
  /**
   * Line whose amount is rounded and replaced with the rounded settlement
   * amount. Usually the bank/cash/party line. Defaults to the last line.
   */
  settlementLineIndex?: number;
}

export interface RoundOffResult {
  lines: VoucherLineInput[];
  /** Signed amount posted to the round-off ledger. */
  roundOffMinor: number;
  /** Replacement amount for the settlement line. */
  roundedSettlementMinor: number;
  /** Original amount on the settlement line. */
  originalSettlementMinor: number;
}

/**
 * Balanced vouchers can still need an explicit round-off line when the
 * company rounds invoice totals. The input must already balance; this function
 * never hides an imbalance.
 *
 * The settlement line (bank/cash/party) is set to the rounded amount and the
 * difference is posted explicitly to the round-off ledger, so the voucher
 * remains balanced and the rounding is auditable.
 */
export function appendRoundOff(
  lines: VoucherLineInput[],
  options: RoundOffOptions,
): RoundOffResult {
  if (lines.length === 0) throw new Error('Cannot round an empty voucher');

  const totalMinor = sumMinor(lines.map((line) => line.amountMinor));
  if (totalMinor !== 0) {
    throw new Error(
      `Cannot round an unbalanced voucher: debits minus credits = ${totalMinor}`,
    );
  }

  const settlementIndex = options.settlementLineIndex ?? lines.length - 1;
  const settlement = lines[settlementIndex];
  if (!settlement) throw new Error(`No settlement line at index ${settlementIndex}`);

  const otherTotalMinor = sumMinor(
    lines
      .filter((_, index) => index !== settlementIndex)
      .map((line) => line.amountMinor),
  );
  const requiredSettlementMinor = -otherTotalMinor;
  const roundedSettlementMinor = roundToStep(
    requiredSettlementMinor,
    options.stepMinor,
    options.mode ?? 'half-up',
  );
  const roundOffMinor = requiredSettlementMinor - roundedSettlementMinor;

  if (roundOffMinor === 0) {
    return {
      lines,
      roundOffMinor: 0,
      roundedSettlementMinor,
      originalSettlementMinor: settlement.amountMinor,
    };
  }

  const adjustedSettlement: VoucherLineInput = {
    ...settlement,
    amountMinor: roundedSettlementMinor,
  };
  const roundOffLine: VoucherLineInput = {
    ledgerId: options.ledgerId,
    amountMinor: roundOffMinor,
    currency: settlement.currency,
    narration: options.narration ?? 'Round off',
    billAllocations: [],
    costCenterAllocations: [],
    taxAllocations: [],
  };

  const roundedLines = lines.map((line, index) =>
    index === settlementIndex ? adjustedSettlement : line,
  );
  roundedLines.push(roundOffLine);

  const check = sumMinor(roundedLines.map((line) => line.amountMinor));
  if (check !== 0) {
    throw new Error(`Round-off failed to balance the voucher: ${check}`);
  }

  return {
    lines: roundedLines,
    roundOffMinor,
    roundedSettlementMinor,
    originalSettlementMinor: settlement.amountMinor,
  };
}

export function roundOffForAmount(
  amountMinor: number,
  stepMinor: number,
  mode: RoundingMode = 'half-up',
): number {
  assertSafeMinor(amountMinor);
  return roundOffDifference(amountMinor, stepMinor, mode);
}

export function totalAfterRoundOff(
  amountMinor: number,
  stepMinor: number,
  mode: RoundingMode = 'half-up',
): number {
  return addMinor(amountMinor, roundOffForAmount(amountMinor, stepMinor, mode));
}
