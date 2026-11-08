import { z } from 'zod';
import type { StatementAdapter } from './types';
import { STATEMENT_ADAPTERS } from './adapters';

export const StatementAdapterSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens'),
    name: z.string().min(1).max(128),
    kind: z.enum(['bank', 'fastag']),
    markers: z.array(z.string().min(1).max(128)).default([]),
    filePatterns: z.array(z.string().min(1).max(128)).optional(),
  })
  .strict();

function parseAdapter(input: unknown): StatementAdapter {
  const parsed = StatementAdapterSchema.parse(input);
  return {
    id: parsed.id,
    name: parsed.name,
    kind: parsed.kind,
    markers: parsed.markers,
    ...(parsed.filePatterns ? { filePatterns: parsed.filePatterns } : {}),
  };
}

export function defineAdapter(input: z.input<typeof StatementAdapterSchema>): StatementAdapter {
  return parseAdapter(input);
}

export function validateAdapter(input: unknown): StatementAdapter {
  return parseAdapter(input);
}

export function validateAdapterRegistry(
  adapters: readonly StatementAdapter[] = STATEMENT_ADAPTERS,
): void {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    StatementAdapterSchema.parse(adapter);
    if (ids.has(adapter.id)) throw new Error(`Duplicate statement adapter id: ${adapter.id}`);
    ids.add(adapter.id);
  }
}

export function adapterTemplate(): StatementAdapter {
  return {
    id: 'my-bank',
    name: 'My Bank',
    kind: 'bank',
    markers: ['my bank', 'mybank000'],
    filePatterns: ['mybank'],
  };
}
