export type IdPrefix =
  | 'ws'
  | 'co'
  | 'grp'
  | 'led'
  | 'pty'
  | 'item'
  | 'god'
  | 'bat'
  | 'cc'
  | 'vch'
  | 'vln'
  | 'iln'
  | 'bil'
  | 'ccl'
  | 'tax'
  | 'att'
  | 'num'
  | 'aud'
  | 'imp'
  | 'stl'
  | 'rec'
  | 'drv';

const ID_PATTERN = /^[a-z]{2,6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 UUIDv7 (time-ordered). Uses crypto.getRandomValues when available. */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new Error('Secure random source unavailable');
  }
  cryptoObj.getRandomValues(bytes);

  let timestamp = Date.now();
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${uuidv7()}`;
}

export function isEntityId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_PATTERN.test(value)) return false;
  return prefix ? value.startsWith(`${prefix}_`) : true;
}

/** Human-readable slug used for files, tabs and stable lookup hints. */
export function slugify(input: string, fallback = 'item', maxLength = 48): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const existing = new Set(taken);
  const root = slugify(base);
  if (!existing.has(root)) return root;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${root}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a unique slug from "${base}"`);
}

export interface CompositeName {
  workspace: string;
  account: string;
  readable: string;
}

export function compositeName(parts: CompositeName): string {
  return `${parts.workspace} / ${parts.account} / ${parts.readable}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Financial-year key for an Indian-style April–March year, e.g. 2026-27. */
export function financialYearKey(dateIso: string, fyStartMonth = 4): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${dateIso}`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const start = month >= fyStartMonth ? year : year - 1;
  const end = start + 1;
  return `${start}-${String(end % 100).padStart(2, '0')}`;
}

/** Calendar month key, e.g. 2026-11. */
export function monthKey(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${dateIso}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
