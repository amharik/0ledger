import { describe, expect, it } from 'vitest';
import {
  adapterTemplate,
  defineAdapter,
  validateAdapterRegistry,
} from '@/core/ingest';
import { STATEMENT_ADAPTERS } from '@/core/ingest/adapters';

describe('adapter SDK', () => {
  it('defines the built-in registry without duplicate ids', () => {
    expect(() => validateAdapterRegistry()).not.toThrow();
    expect(STATEMENT_ADAPTERS.length).toBeGreaterThan(10);
  });

  it('normalises optional file patterns and rejects bad ids', () => {
    const adapter = defineAdapter({
      id: 'my-bank',
      name: 'My Bank',
      kind: 'bank',
      markers: ['my bank'],
    });
    expect(adapter.filePatterns).toBeUndefined();
    expect(() => defineAdapter({ id: 'My Bank', name: 'Bad', kind: 'bank' })).toThrow();
    expect(adapterTemplate().id).toBe('my-bank');
  });
});
