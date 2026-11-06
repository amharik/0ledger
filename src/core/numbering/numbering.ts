import { financialYearKey } from '../ids';
import type { NumberingScheme } from '../model';
import type { RoundingMode } from '../money/money';

export interface NumberPreview {
  number: string;
  sequence: number;
  periodKey: string;
  scheme: NumberingScheme;
}

export class NumberingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumberingError';
  }
}

export function periodKeyFor(
  scheme: Pick<NumberingScheme, 'resetPeriod'>,
  dateIso: string,
  fyStartMonth = 4,
): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new NumberingError(`Invalid date: ${dateIso}`);
  switch (scheme.resetPeriod) {
    case 'never':
      return 'all';
    case 'yearly':
      return String(date.getUTCFullYear());
    case 'monthly': {
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      return `${date.getUTCFullYear()}-${month}`;
    }
    case 'fy':
    default:
      return financialYearKey(dateIso, fyStartMonth);
  }
}

export function formatVoucherNumber(
  scheme: Pick<NumberingScheme, 'prefix' | 'suffix' | 'separator' | 'padding' | 'resetPeriod'>,
  sequence: number,
  periodKey: string,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new NumberingError(`Sequence must be a positive integer, got ${sequence}`);
  }
  const separator = scheme.separator ?? '/';
  const padded = String(sequence).padStart(scheme.padding, '0');
  const parts = [scheme.prefix, periodKey === 'all' ? '' : periodKey, padded, scheme.suffix].filter(
    (part) => part != null && part.length > 0,
  );
  return parts.join(separator);
}

/**
 * Returns the next number and the scheme state to persist (next counter + active period).
 * The caller must persist it in the same database transaction as the voucher.
 */
export function previewNextNumber(
  scheme: NumberingScheme,
  dateIso: string,
  fyStartMonth = 4,
): NumberPreview {
  const periodKey = periodKeyFor(scheme, dateIso, fyStartMonth);
  const periodChanged = scheme.currentPeriodKey != null && scheme.currentPeriodKey !== periodKey;
  const baseSequence = periodChanged || scheme.currentPeriodKey == null
    ? scheme.startNumber
    : Math.max(scheme.nextNumber, scheme.startNumber);
  const sequence = baseSequence;
  return {
    number: formatVoucherNumber(scheme, sequence, periodKey),
    sequence,
    periodKey,
    scheme: {
      ...scheme,
      nextNumber: sequence + 1,
      currentPeriodKey: periodKey,
    },
  };
}

export function manualNumberAllowed(scheme: NumberingScheme): boolean {
  return scheme.allowManualOverride;
}

export function validateManualNumber(
  scheme: NumberingScheme,
  number: string,
  existingNumbers: Iterable<string>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!scheme.allowManualOverride) {
    errors.push(`Manual numbering is disabled for ${scheme.voucherType}`);
  }
  if (number.trim().length === 0) errors.push('Voucher number must not be empty');
  if (scheme.enforceUnique) {
    const existing = new Set(existingNumbers);
    if (existing.has(number)) errors.push(`Voucher number ${number} already exists`);
  }
  return { ok: errors.length === 0, errors };
}

export function formatNumberSequence(
  sequence: number,
  padding: number,
  mode: RoundingMode = 'half-up',
): string {
  void mode;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new NumberingError(`Invalid sequence: ${sequence}`);
  }
  return String(sequence).padStart(padding, '0');
}
