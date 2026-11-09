export const MAX_INGEST_BYTES = 25 * 1024 * 1024;
export const MAX_INGEST_TEXT_CHARS = 5_000_000;
export const MAX_INGEST_ROWS = 100_000;
export const MAX_PDF_PAGES = 200;
export const MAX_EMAIL_ATTACHMENTS = 25;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_EMAIL_BODY_CHARS = 1_000_000;
export const MAX_RAW_KEYS = 40;
export const MAX_RAW_KEY_CHARS = 64;
export const MAX_RAW_VALUE_CHARS = 2_000;

export function byteLength(value: ArrayBuffer | Uint8Array): number {
  return value instanceof Uint8Array ? value.byteLength : value.byteLength;
}

export function assertByteLimit(value: ArrayBuffer | Uint8Array, label = 'File'): void {
  if (byteLength(value) > MAX_INGEST_BYTES) {
    throw new Error(`${label} is too large (max ${Math.round(MAX_INGEST_BYTES / 1024 / 1024)} MB)`);
  }
}

export function assertTextLimit(value: string, label = 'Statement'): void {
  if (value.length > MAX_INGEST_TEXT_CHARS) {
    throw new Error(`${label} is too large (max ${MAX_INGEST_TEXT_CHARS.toLocaleString()} characters)`);
  }
}

export function assertRowLimit(count: number, label = 'Statement'): void {
  if (count > MAX_INGEST_ROWS) {
    throw new Error(`${label} has too many rows (max ${MAX_INGEST_ROWS.toLocaleString()})`);
  }
}
