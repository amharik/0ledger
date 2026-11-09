import { z } from 'zod';
import { nowIso } from '../ids';
import type { LedgerDatabase } from '../db/db';
import { DB_VERSION } from '../db/db';
import {
  AttachmentSchema,
  AuditEventSchema,
  BatchSchema,
  BillAllocationSchema,
  CompanyProfileSchema,
  CostCenterAllocationSchema,
  CostCenterSchema,
  DriveLinkSchema,
  GodownSchema,
  ImportBatchSchema,
  ItemLineSchema,
  LedgerGroupSchema,
  LedgerSchema,
  NumberingSchemeSchema,
  PartySchema,
  ReconciliationSchema,
  StatementLineSchema,
  StockItemSchema,
  TaxAllocationSchema,
  VoucherLineSchema,
  VoucherSchema,
  WorkspaceSchema,
} from '../model';

export const BACKUP_FORMAT = '0ledger-backup';
export const BACKUP_PAYLOAD_FORMAT = '0ledger-backup-payload';
export const BACKUP_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 1_000_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_CIPHERTEXT_CHARS = Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 16;

const KeyValueSchema = z.object({ key: z.string().min(1).max(256), value: z.unknown() }).strict();

const TABLE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  workspaces: WorkspaceSchema,
  companies: CompanyProfileSchema,
  ledgerGroups: LedgerGroupSchema,
  ledgers: LedgerSchema,
  parties: PartySchema,
  stockItems: StockItemSchema,
  godowns: GodownSchema,
  batches: BatchSchema,
  costCenters: CostCenterSchema,
  numberingSchemes: NumberingSchemeSchema,
  vouchers: VoucherSchema,
  voucherLines: VoucherLineSchema,
  itemLines: ItemLineSchema,
  billAllocations: BillAllocationSchema,
  costCenterAllocations: CostCenterAllocationSchema,
  taxAllocations: TaxAllocationSchema,
  attachments: AttachmentSchema,
  importBatches: ImportBatchSchema,
  statementLines: StatementLineSchema,
  reconciliations: ReconciliationSchema,
  auditEvents: AuditEventSchema,
  driveLinks: DriveLinkSchema,
  syncState: KeyValueSchema,
  settings: KeyValueSchema,
};

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    iv: string;
    tagLength: 128;
  };
  ciphertext: string;
}

export interface BackupPayload {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  version: number;
  exportedAt: string;
  dbVersion: number;
  tables: Record<string, unknown[]>;
}

export type RestoreMode = 'replace' | 'merge';

export interface RestoreResult {
  tables: Record<string, number>;
  totalRecords: number;
  mode: RestoreMode;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BackupError(`Backup password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new BackupError('Web Crypto is unavailable in this environment');
  return subtle;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = subtleCrypto();
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function backupFilename(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `0ledger-backup-${stamp}.0ledger`;
}

export async function createBackupPayload(db: LedgerDatabase): Promise<BackupPayload> {
  const tables: Record<string, unknown[]> = {};
  for (const table of db.tables) {
    tables[table.name] = await table.toArray();
  }
  return {
    format: BACKUP_PAYLOAD_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: nowIso(),
    dbVersion: DB_VERSION,
    tables,
  };
}

export async function encryptBackup(
  payload: BackupPayload,
  password: string,
  options: { iterations?: number } = {},
): Promise<BackupEnvelope> {
  assertPassword(password);
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) {
    throw new BackupError('PBKDF2 iterations must be at least 100000');
  }
  if (iterations > MAX_PBKDF2_ITERATIONS) {
    throw new BackupError(`PBKDF2 iterations must not exceed ${MAX_PBKDF2_ITERATIONS}`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await subtleCrypto().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext),
  );

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: nowIso(),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: bytesToBase64(salt),
    },
    cipher: {
      name: 'AES-GCM',
      iv: bytesToBase64(iv),
      tagLength: 128,
    },
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function createBackup(
  db: LedgerDatabase,
  password: string,
  options: { iterations?: number } = {},
): Promise<BackupEnvelope> {
  return encryptBackup(await createBackupPayload(db), password, options);
}

function assertEnvelope(value: unknown): asserts value is BackupEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new BackupError('Backup file is not an object');
  }
  const envelope = value as Partial<BackupEnvelope>;
  if (envelope.format !== BACKUP_FORMAT) {
    throw new BackupError('Not a 0ledger backup file');
  }
  if (envelope.version !== BACKUP_VERSION) {
    throw new BackupError(`Unsupported backup version: ${String(envelope.version)}`);
  }
  if (
    !envelope.kdf ||
    envelope.kdf.name !== 'PBKDF2' ||
    envelope.kdf.hash !== 'SHA-256' ||
    !Number.isSafeInteger(envelope.kdf.iterations) ||
    envelope.kdf.iterations < 100_000 ||
    envelope.kdf.iterations > MAX_PBKDF2_ITERATIONS ||
    typeof envelope.kdf.salt !== 'string'
  ) {
    throw new BackupError('Backup KDF parameters are invalid');
  }
  if (
    !envelope.cipher ||
    envelope.cipher.name !== 'AES-GCM' ||
    envelope.cipher.tagLength !== 128 ||
    typeof envelope.cipher.iv !== 'string'
  ) {
    throw new BackupError('Backup cipher parameters are invalid');
  }
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length === 0) {
    throw new BackupError('Backup ciphertext is missing');
  }
  if (envelope.ciphertext.length > MAX_CIPHERTEXT_CHARS) {
    throw new BackupError('Backup ciphertext is too large');
  }
  if (base64ToBytes(envelope.kdf.salt).byteLength !== SALT_BYTES) {
    throw new BackupError('Backup salt has an invalid length');
  }
  if (base64ToBytes(envelope.cipher.iv).byteLength !== IV_BYTES) {
    throw new BackupError('Backup IV has an invalid length');
  }
}

function assertPayload(value: unknown): asserts value is BackupPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BackupError('Backup payload is not an object');
  }
  const payload = value as Partial<BackupPayload>;
  if (payload.format !== BACKUP_PAYLOAD_FORMAT) {
    throw new BackupError('Backup payload format is invalid');
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new BackupError(`Unsupported backup payload version: ${String(payload.version)}`);
  }
  if (typeof payload.tables !== 'object' || payload.tables === null) {
    throw new BackupError('Backup payload has no tables');
  }
  if (typeof payload.dbVersion !== 'number' || payload.dbVersion > DB_VERSION) {
    throw new BackupError('Backup was created by a newer database version');
  }
  let total = 0;
  for (const [name, rows] of Object.entries(payload.tables)) {
    if (!Array.isArray(rows)) {
      throw new BackupError(`Backup table "${name}" is not an array`);
    }
    total += rows.length;
    if (total > MAX_BACKUP_RECORDS) throw new BackupError('Backup has too many records');
    const schema = TABLE_SCHEMAS[name];
    if (!schema) continue;
    for (const [index, row] of rows.entries()) {
      if (!schema.safeParse(row).success) {
        throw new BackupError(`Backup table "${name}" has invalid row ${index + 1}`);
      }
    }
  }
}

export async function decryptBackup(
  envelope: BackupEnvelope,
  password: string,
): Promise<BackupPayload> {
  assertPassword(password);
  assertEnvelope(envelope);

  const salt = base64ToBytes(envelope.kdf.salt);
  const iv = base64ToBytes(envelope.cipher.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const key = await deriveKey(password, salt, envelope.kdf.iterations);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      ciphertext,
    );
  } catch {
    throw new BackupError('Unable to decrypt backup: wrong password or corrupted file');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new BackupError('Backup payload is not valid JSON');
  }
  assertPayload(parsed);
  return parsed;
}

export async function restoreBackup(
  db: LedgerDatabase,
  envelope: BackupEnvelope,
  password: string,
  options: { mode?: RestoreMode } = {},
): Promise<RestoreResult> {
  const payload = await decryptBackup(envelope, password);
  const mode = options.mode ?? 'replace';
  const tableNames = new Set(db.tables.map((table) => table.name));
  const unknownTables = Object.keys(payload.tables).filter((name) => !tableNames.has(name));
  if (unknownTables.length > 0) {
    throw new BackupError(`Backup contains unknown tables: ${unknownTables.join(', ')}`);
  }

  const tables = db.tables.filter((table) => payload.tables[table.name] !== undefined);
  const counts: Record<string, number> = {};

  await db.transaction('rw', tables, async () => {
    for (const table of tables) {
      const rows = payload.tables[table.name] ?? [];
      if (mode === 'replace') await table.clear();
      if (rows.length > 0) await table.bulkPut(rows);
      counts[table.name] = rows.length;
    }
  });

  const totalRecords = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { tables: counts, totalRecords, mode };
}
