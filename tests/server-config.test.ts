import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_PORT, parseServerPort, serverUrl } from '../server.config';

describe('server config', () => {
  it('falls back to the shared default port', () => {
    expect(parseServerPort(undefined)).toBe(DEFAULT_SERVER_PORT);
    expect(parseServerPort('')).toBe(DEFAULT_SERVER_PORT);
  });

  it('accepts a valid PORT override', () => {
    expect(parseServerPort('4100')).toBe(4100);
    expect(serverUrl(4100)).toBe('http://127.0.0.1:4100');
  });

  it('rejects invalid ports instead of silently falling back', () => {
    expect(() => parseServerPort('0')).toThrow(/Invalid PORT/);
    expect(() => parseServerPort('65536')).toThrow(/Invalid PORT/);
    expect(() => parseServerPort('abc')).toThrow(/Invalid PORT/);
    expect(() => parseServerPort('1e3')).toThrow(/Invalid PORT/);
  });
});
