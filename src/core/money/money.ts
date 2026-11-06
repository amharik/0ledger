import { DEFAULT_CURRENCY, getCurrency, type Currency } from './currency';

export type RoundingMode = 'half-up' | 'half-even';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertSafeMinor(value: number, label = 'amount'): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer minor amount, got ${value}`);
  }
}

/**
 * Parse a human-formatted amount into integer minor units.
 * Accepts Indian/Western grouping, currency symbols, parentheses negatives,
 * trailing minus, and surrounding whitespace.
 */
export function parseAmountToMinor(
  input: string | number,
  currencyCode: string = DEFAULT_CURRENCY,
  mode: RoundingMode = 'half-up',
): number {
  const currency = getCurrency(currencyCode);
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Invalid amount: ${input}`);
    return parseAmountToMinor(input.toFixed(currency.minorUnit + 6), currencyCode, mode);
  }

  let text = input.trim();
  if (text.length === 0) throw new MoneyError('Amount is empty');

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }

  // Remove currency symbols, codes, and grouping separators (commas, spaces, NBSP).
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/[,\s]/g, '')
    .replace(/^(?:rs\.?|inr|\u20b9|\$|usd|eur|gbp|aed|sgd)/i, '')
    .trim();

  const drCr = text.match(/(dr|cr)$/i)?.[1]?.toLowerCase();
  if (drCr === 'cr') negative = !negative;
  if (drCr) text = text.slice(0, -drCr.length);

  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(text) && !/^\.\d+$/.test(text)) {
    throw new MoneyError(`Invalid amount: ${input}`);
  }

  const normalized = text.startsWith('.') ? `0${text}` : text;
  const [wholePart = '0', fractionPart = ''] = normalized.split('.');
  const whole = Number.parseInt(wholePart, 10);
  if (!Number.isSafeInteger(whole)) throw new MoneyError(`Amount too large: ${input}`);

  const fraction = fractionPart.padEnd(currency.minorUnit + 1, '0').slice(0, currency.minorUnit + 1);
  const fractionMinor = Number.parseInt(fraction.slice(0, currency.minorUnit) || '0', 10);
  const remainder = Number.parseInt(fraction.slice(currency.minorUnit) || '0', 10);

  let minor = whole * 10 ** currency.minorUnit + fractionMinor;
  if (currency.minorUnit > 0 && remainder > 0) {
    const step = 10 ** (fraction.length - currency.minorUnit);
    minor = roundToStep(minor * step + remainder, step, mode) / step;
  }

  if (negative) minor = -minor;
  assertSafeMinor(minor);
  return minor;
}

/**
 * Round an integer minor amount to a multiple of `stepMinor`.
 * Half-up rounds away from zero; half-even uses banker's rounding.
 */
export function roundToStep(
  valueMinor: number,
  stepMinor: number,
  mode: RoundingMode = 'half-up',
): number {
  assertSafeMinor(valueMinor, 'value');
  if (!Number.isSafeInteger(stepMinor) || stepMinor <= 0) {
    throw new MoneyError(`Rounding step must be a positive integer, got ${stepMinor}`);
  }
  if (valueMinor % stepMinor === 0) return valueMinor;

  const sign = valueMinor < 0 ? -1 : 1;
  const abs = Math.abs(valueMinor);
  const quotient = abs / stepMinor;
  const floor = Math.floor(quotient);
  const fraction = quotient - floor;

  let roundedCount: number;
  if (fraction > 0.5) {
    roundedCount = floor + 1;
  } else if (fraction < 0.5) {
    roundedCount = floor;
  } else if (mode === 'half-up') {
    roundedCount = floor + 1;
  } else {
    roundedCount = floor % 2 === 0 ? floor : floor + 1;
  }

  const result = sign * roundedCount * stepMinor;
  assertSafeMinor(result, 'rounded amount');
  return result;
}

/** The explicit round-off entry needed to move `valueMinor` to the nearest step. */
export function roundOffDifference(
  valueMinor: number,
  stepMinor: number,
  mode: RoundingMode = 'half-up',
): number {
  return roundToStep(valueMinor, stepMinor, mode) - valueMinor;
}

/**
 * Split an amount across weights using the largest-remainder method so the
 * parts always sum exactly to the total. Used for line-level round-off
 * allocation and tax splits.
 */
export function allocateMinor(totalMinor: number, weights: number[]): number[] {
  assertSafeMinor(totalMinor);
  if (weights.length === 0) throw new MoneyError('Cannot allocate to zero weights');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('Weights must be finite, non-negative numbers');
  }

  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum === 0) throw new MoneyError('Weights must not sum to zero');

  const sign = totalMinor < 0 ? -1 : 1;
  const absTotal = Math.abs(totalMinor);
  const raw = weights.map((w) => (absTotal * w) / weightSum);
  const floors = raw.map(Math.floor);
  let remaining = absTotal - floors.reduce((sum, v) => sum + v, 0);

  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (const item of order) {
    if (remaining <= 0) break;
    result[item.index] = (result[item.index] ?? 0) + 1;
    remaining -= 1;
  }

  return result.map((value) => sign * value);
}

export function formatMinor(
  minor: number,
  currencyCode: string = DEFAULT_CURRENCY,
  options: { symbol?: boolean; signed?: boolean } = {},
): string {
  assertSafeMinor(minor);
  const currency = getCurrency(currencyCode);
  const value = minor / 10 ** currency.minorUnit;
  const formatted = new Intl.NumberFormat(currency.locale, {
    style: options.symbol === false ? 'decimal' : 'currency',
    currency: currency.code,
    minimumFractionDigits: currency.minorUnit,
    maximumFractionDigits: currency.minorUnit,
    signDisplay: options.signed ? 'always' : 'auto',
  }).format(value);
  return formatted;
}

/** Export-friendly decimal string with no grouping or symbol. */
export function minorToDecimalString(
  minor: number,
  currencyCode: string = DEFAULT_CURRENCY,
): string {
  assertSafeMinor(minor);
  const currency = getCurrency(currencyCode);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const factor = 10 ** currency.minorUnit;
  const whole = Math.floor(abs / factor);
  const fraction = abs % factor;
  if (currency.minorUnit === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(fraction).padStart(currency.minorUnit, '0')}`;
}

export function addMinor(...values: number[]): number {
  const total = values.reduce((sum, value) => {
    assertSafeMinor(value);
    return sum + value;
  }, 0);
  assertSafeMinor(total);
  return total;
}

export function sumMinor(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    assertSafeMinor(value);
    total += value;
  }
  assertSafeMinor(total);
  return total;
}

export function negateMinor(value: number): number {
  assertSafeMinor(value);
  return value === 0 ? 0 : -value;
}

export function currenciesEqual(a: Currency, b: Currency): boolean {
  return a.code === b.code;
}
