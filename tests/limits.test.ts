import { describe, expect, it } from 'vitest';
import {
  MAX_INGEST_BYTES,
  MAX_INGEST_ROWS,
  MAX_INGEST_TEXT_CHARS,
  assertByteLimit,
  assertRowLimit,
  assertTextLimit,
} from '@/core/ingest/limits';

describe('ingestion limits', () => {
  it('rejects oversized bytes, text and rows', () => {
    expect(() => assertByteLimit(new Uint8Array(MAX_INGEST_BYTES + 1))).toThrow(/too large/);
    expect(() => assertTextLimit('x'.repeat(MAX_INGEST_TEXT_CHARS + 1))).toThrow(/too large/);
    expect(() => assertRowLimit(MAX_INGEST_ROWS + 1)).toThrow(/too many rows/);
  });

  it('accepts values at the limit', () => {
    expect(() => assertByteLimit(new Uint8Array(MAX_INGEST_BYTES))).not.toThrow();
    expect(() => assertTextLimit('x'.repeat(MAX_INGEST_TEXT_CHARS))).not.toThrow();
    expect(() => assertRowLimit(MAX_INGEST_ROWS)).not.toThrow();
  });
});
