/**
 * Currency metadata. Amounts are always stored as integer minor units.
 */
export interface Currency {
  code: string;
  symbol: string;
  minorUnit: number;
  locale: string;
}

export const CURRENCIES: Record<string, Currency> = {
  INR: { code: 'INR', symbol: '\u20b9', minorUnit: 2, locale: 'en-IN' },
  USD: { code: 'USD', symbol: '$', minorUnit: 2, locale: 'en-US' },
  EUR: { code: 'EUR', symbol: '\u20ac', minorUnit: 2, locale: 'de-DE' },
  GBP: { code: 'GBP', symbol: '\u00a3', minorUnit: 2, locale: 'en-GB' },
  AED: { code: 'AED', symbol: 'AED', minorUnit: 2, locale: 'en-AE' },
  SGD: { code: 'SGD', symbol: 'S$', minorUnit: 2, locale: 'en-SG' },
};

export function getCurrency(code: string): Currency {
  const currency = CURRENCIES[code.toUpperCase()];
  if (!currency) throw new Error(`Unsupported currency: ${code}`);
  return currency;
}

export const DEFAULT_CURRENCY = 'INR';
