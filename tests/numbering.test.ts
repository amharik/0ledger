import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '@/core/ids';
import { formatVoucherNumber, previewNextNumber, validateManualNumber } from '@/core/numbering';
import type { NumberingScheme } from '@/core/model';

function scheme(overrides: Partial<NumberingScheme> = {}): NumberingScheme {
  const now = nowIso();
  return {
    id: newId('num'),
    workspaceId: newId('ws'),
    voucherType: 'Sales',
    name: 'Sales default',
    prefix: 'INV',
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

describe('numbering', () => {
  it('formats FY-based numbers and advances the counter', () => {
    const preview = previewNextNumber(scheme(), '2026-11-06');
    expect(preview.number).toBe('INV/2026-27/0001');
    expect(preview.scheme.nextNumber).toBe(2);
    expect(preview.scheme.currentPeriodKey).toBe('2026-27');

    const second = previewNextNumber(preview.scheme, '2026-11-07');
    expect(second.number).toBe('INV/2026-27/0002');
  });

  it('resets when the financial year changes', () => {
    const advanced = scheme({ nextNumber: 42, currentPeriodKey: '2025-26' });
    const next = previewNextNumber(advanced, '2026-04-01');
    expect(next.number).toBe('INV/2026-27/0001');
    expect(next.scheme.nextNumber).toBe(2);
  });

  it('supports never/yearly/monthly reset periods', () => {
    expect(
      formatVoucherNumber(scheme({ resetPeriod: 'never' }), 7, 'all'),
    ).toBe('INV/0007');
    expect(
      formatVoucherNumber(scheme({ resetPeriod: 'yearly' }), 7, '2026'),
    ).toBe('INV/2026/0007');
    expect(
      formatVoucherNumber(scheme({ resetPeriod: 'monthly' }), 7, '2026-11'),
    ).toBe('INV/2026-11/0007');
  });

  it('validates manual overrides and duplicates', () => {
    expect(validateManualNumber(scheme(), 'INV/2026-27/0099', []).ok).toBe(true);
    expect(validateManualNumber(scheme(), 'INV/2026-27/0001', ['INV/2026-27/0001']).ok).toBe(false);
    expect(
      validateManualNumber(scheme({ allowManualOverride: false }), 'X', []).ok,
    ).toBe(false);
  });
});
