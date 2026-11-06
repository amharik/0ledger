import { describe, expect, it } from 'vitest';
import {
  financialYearKey,
  isEntityId,
  monthKey,
  newId,
  slugify,
  uniqueSlug,
  uuidv7,
} from '@/core/ids';

describe('ids', () => {
  it('generates UUIDv7-shaped ids with prefixes', () => {
    const raw = uuidv7();
    expect(raw).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const id = newId('vch');
    expect(isEntityId(id, 'vch')).toBe(true);
    expect(isEntityId(id, 'led')).toBe(false);
  });

  it('derives stable unique slugs', () => {
    expect(slugify('Acme Traders & Co.')).toBe('acme-traders-co');
    expect(slugify('  ')).toBe('item');
    expect(uniqueSlug('Acme Traders', ['acme-traders'])).toBe('acme-traders-2');
  });

  it('computes Indian financial year and month keys', () => {
    expect(financialYearKey('2026-03-31')).toBe('2025-26');
    expect(financialYearKey('2026-04-01')).toBe('2026-27');
    expect(monthKey('2026-11-06')).toBe('2026-11');
  });
});
