import { describe, expect, it } from 'vitest';
import {
  allocateMinor,
  formatMinor,
  minorToDecimalString,
  parseAmountToMinor,
  roundOffDifference,
  roundToStep,
  sumMinor,
} from '@/core/money/money';

describe('parseAmountToMinor', () => {
  it('parses Indian grouping and currency symbols', () => {
    expect(parseAmountToMinor('1,23,456.78')).toBe(12_345_678);
    expect(parseAmountToMinor('\u20b9 1,234.5')).toBe(123_450);
    expect(parseAmountToMinor('Rs. 99')).toBe(9_900);
  });

  it('parses negatives in common formats', () => {
    expect(parseAmountToMinor('-123.45')).toBe(-12_345);
    expect(parseAmountToMinor('(123.45)')).toBe(-12_345);
    expect(parseAmountToMinor('123.45-')).toBe(-12_345);
    expect(parseAmountToMinor('123.45 Cr')).toBe(-12_345);
  });

  it('rounds excess decimal places', () => {
    expect(parseAmountToMinor('0.005')).toBe(1);
    expect(parseAmountToMinor('0.004')).toBe(0);
    expect(parseAmountToMinor('1.005')).toBe(101);
  });

  it('rejects malformed input', () => {
    expect(() => parseAmountToMinor('')).toThrow();
    expect(() => parseAmountToMinor('12.3.4')).toThrow();
    expect(() => parseAmountToMinor('abc')).toThrow();
  });
});

describe('roundToStep', () => {
  it('rounds half up away from zero', () => {
    expect(roundToStep(12_345, 100, 'half-up')).toBe(12_300);
    expect(roundToStep(12_350, 100, 'half-up')).toBe(12_400);
    expect(roundToStep(-12_350, 100, 'half-up')).toBe(-12_400);
  });

  it('rounds half even', () => {
    expect(roundToStep(12_350, 100, 'half-even')).toBe(12_400);
    expect(roundToStep(12_250, 100, 'half-even')).toBe(12_200);
    expect(roundToStep(12_450, 100, 'half-even')).toBe(12_400);
  });

  it('leaves exact multiples untouched', () => {
    expect(roundToStep(12_300, 100)).toBe(12_300);
  });

  it('reports the explicit round-off difference', () => {
    expect(roundOffDifference(123_456, 100, 'half-up')).toBe(44);
    expect(roundOffDifference(-123_456, 100, 'half-up')).toBe(-44);
  });
});

describe('allocateMinor', () => {
  it('splits without losing a minor unit', () => {
    const parts = allocateMinor(100, [1, 1, 1]);
    expect(sumMinor(parts)).toBe(100);
    expect(parts.sort((a, b) => a - b)).toEqual([33, 33, 34]);
  });

  it('handles negatives', () => {
    const parts = allocateMinor(-101, [1, 2]);
    expect(sumMinor(parts)).toBe(-101);
  });
});

describe('formatting', () => {
  it('formats minor units as currency', () => {
    expect(formatMinor(12_345_678)).toContain('1,23,456.78');
    expect(minorToDecimalString(12_345_678)).toBe('123456.78');
    expect(minorToDecimalString(-5)).toBe('-0.05');
  });
});
