import { newId, nowIso } from '../ids';
import { markDriveDirty, clearDriveDirty, listDirtyWorkspaces } from '../db/sync-state';
import type { LedgerDatabase } from '../db/db';
import type { DriveLink, Workspace } from '../model';
import {
  AuditEventSchema,
  BatchSchema,
  BillAllocationSchema,
  CompanyProfileSchema,
  CostCenterAllocationSchema,
  CostCenterSchema,
  DriveLinkSchema,
  GodownSchema,
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
import { buildWorkbookSpec } from '../template/spec';
import { loadWorkbookData } from '../template/data';
import { renderSheetsValues } from '../template/sheets';
import { renderWorkbookXlsx } from '../template/xlsx';
import { parseSnapshotChunks, type WorkbookSnapshot } from '../template/snapshot';
import type { WorkbookSpec } from '../template/types';
import { sha256Hex } from '../util/hash';
import {
  DRIVE_FOLDER_MIME,
  SHEETS_MIME,
  XLSX_MIME,
  appPropertiesQuery,
  clearSheet,
  createFile,
  ensureSheets,
  findFirstFile,
  getFile,
  readSheetValues,
  replaceFileContent,
  uploadFile,
  writeSheetFormulas,
  writeSheetValues,
  type DriveFile,
  type FetchLike,
} from './api';

export interface DriveLocation {
  root: DriveFile;
  folder: DriveFile;
  workbook: DriveFile;
}

function displayName(workspace: Workspace): string {
  return workspace.readableName || workspace.name;
}

export function workbookName(workspace: Workspace): string {
  return `${displayName(workspace)} — Ledger`;
}

export function archiveName(workspace: Workspace, period: string): string {
  return `${displayName(workspace)} — ${period}.xlsx`;
}

function isAppFile(file: DriveFile | undefined, workspaceId: string): boolean {
  return (
    file?.appProperties?.app === '0ledger' &&
    (file.appProperties.workspaceId === undefined || file.appProperties.workspaceId === workspaceId)
  );
}

async function ensureFolder(
  token: string,
  name: string,
  workspaceId: string | undefined,
  kind: 'root' | 'workspace',
  parentId: string | undefined,
  fetchImpl: FetchLike,
): Promise<DriveFile> {
  const props: Record<string, string> = { app: '0ledger', kind };
  if (workspaceId) props.workspaceId = workspaceId;
  const parentClause = parentId ? ` and '${parentId.replace(/'/g, "\\'")}' in parents` : '';
  const query = `mimeType='${DRIVE_FOLDER_MIME}' and trashed=false and ${appPropertiesQuery(props)}${parentClause}`;
  const existing = await findFirstFile(token, query, fetchImpl);
  if (existing) return existing;
  return createFile(
    token,
    {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties: {
        app: '0ledger',
        kind,
        ...(workspaceId ? { workspaceId } : {}),
      },
    },
    fetchImpl,
  );
}

async function linkFor(
  db: LedgerDatabase,
  workspaceId: string,
  kind: 'sheets' | 'xlsx',
): Promise<DriveLink | undefined> {
  const links = await db.driveLinks.where('workspaceId').equals(workspaceId).toArray();
  return links.find((link) => link.kind === kind);
}

async function saveLink(
  db: LedgerDatabase,
  workspaceId: string,
  kind: 'sheets' | 'xlsx',
  file: DriveFile,
  extra: { contentHash?: string; lastSyncedAt?: string } = {},
): Promise<DriveLink> {
  const existing = await linkFor(db, workspaceId, kind);
  const sameFile = existing?.fileId === file.id;
  const now = nowIso();
  const previousSyncedAt = sameFile ? existing?.lastSyncedAt : undefined;
  const previousHash = sameFile ? existing?.contentHash : undefined;
  const previousModifiedAt = sameFile ? existing?.lastModifiedAt : undefined;
  const link = DriveLinkSchema.parse({
    id: existing?.id ?? newId('drv'),
    workspaceId,
    fileId: file.id,
    fileName: file.name,
    mimeType: file.mimeType,
    kind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(file.modifiedTime
      ? { lastModifiedAt: file.modifiedTime }
      : previousModifiedAt
        ? { lastModifiedAt: previousModifiedAt }
        : {}),
    ...(extra.lastSyncedAt ?? previousSyncedAt
      ? { lastSyncedAt: extra.lastSyncedAt ?? previousSyncedAt }
      : {}),
    ...(extra.contentHash ?? previousHash
      ? { contentHash: extra.contentHash ?? previousHash }
      : {}),
  });
  await db.driveLinks.put(link);
  return link;
}

async function assertManagedFile(
  token: string,
  fileId: string,
  workspaceId: string,
  fetchImpl: FetchLike,
): Promise<DriveFile> {
  const file = await getFile(token, fileId, fetchImpl);
  if (!isAppFile(file, workspaceId)) {
    throw new Error(
      `Refusing to overwrite ${file.name}: it was not created by 0ledger. Paste or open the file in Drive instead.`,
    );
  }
  return file;
}

export async function ensureDriveLocation(
  db: LedgerDatabase,
  workspaceId: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveLocation> {
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

  const root = await ensureFolder(token, '0ledger', undefined, 'root', undefined, fetchImpl);
  const folder = await ensureFolder(token, workspace.slug, workspaceId, 'workspace', root.id, fetchImpl);

  const existingLink = await linkFor(db, workspaceId, 'sheets');
  let workbook: DriveFile | undefined;
  if (existingLink) {
    workbook = await getFile(token, existingLink.fileId, fetchImpl).catch(() => undefined);
    if (workbook) workbook = await assertManagedFile(token, workbook.id, workspaceId, fetchImpl);
  }
  if (!workbook) {
    const query = `mimeType='${SHEETS_MIME}' and trashed=false and ${appPropertiesQuery({
      app: '0ledger',
      kind: 'workbook',
      workspaceId,
    })}`;
    workbook = await findFirstFile(token, query, fetchImpl);
  }
  if (!workbook) {
    workbook = await createFile(
      token,
      {
        name: workbookName(workspace),
        mimeType: SHEETS_MIME,
        parents: [folder.id],
        appProperties: { app: '0ledger', kind: 'workbook', workspaceId },
      },
      fetchImpl,
    );
  }

  await saveLink(db, workspaceId, 'sheets', workbook);
  return { root, folder, workbook };
}

function canonicalSpec(spec: WorkbookSpec): unknown {
  return spec.sheets.map((sheet) => ({
    name: sheet.name,
    columns: sheet.columns,
    rows:
      sheet.name === '_meta'
        ? sheet.rows.map((row) =>
            row[0] === 'generatedAt' || row[0] === 'manifest' ? [row[0], ''] : row,
          )
        : sheet.name === 'Dashboard'
          ? sheet.rows.map((row) =>
              row[0] === 'Generated at' ? [row[0], '', row[2] ?? ''] : row,
            )
          : sheet.rows,
  }));
}

export async function workbookContentHash(spec: WorkbookSpec): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalSpec(spec)));
}

export interface SyncResult {
  workspaceId: string;
  fileId: string;
  webViewLink?: string;
  skipped: boolean;
  contentHash: string;
  sheets: number;
}

export interface SyncOptions {
  token: string;
  force?: boolean;
  fetchImpl?: FetchLike;
  generatedAt?: string;
}

export async function syncWorkspaceToDrive(
  db: LedgerDatabase,
  workspaceId: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const location = await ensureDriveLocation(db, workspaceId, options.token, fetchImpl);
  const data = await loadWorkbookData(db, workspaceId);
  const spec = buildWorkbookSpec(data, {
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  });
  const contentHash = await workbookContentHash(spec);
  const link = await linkFor(db, workspaceId, 'sheets');

  if (!options.force && link?.contentHash === contentHash) {
    await clearDriveDirty(db, workspaceId);
    return {
      workspaceId,
      fileId: location.workbook.id,
      ...(location.workbook.webViewLink ? { webViewLink: location.workbook.webViewLink } : {}),
      skipped: true,
      contentHash,
      sheets: spec.sheets.length,
    };
  }

  const rendered = renderSheetsValues(spec);
  await ensureSheets(
    options.token,
    location.workbook.id,
    rendered.map((sheet) => sheet.title),
    fetchImpl,
  );
  for (const sheet of rendered) {
    await clearSheet(options.token, location.workbook.id, sheet.title, fetchImpl);
    if (sheet.values.length > 0) {
      await writeSheetValues(
        options.token,
        location.workbook.id,
        sheet.title,
        sheet.values,
        fetchImpl,
      );
      const formulas: { row: number; column: number; formula: string }[] = [];
      sheet.values.forEach((row, rowIndex) => {
        row.forEach((value, columnIndex) => {
          if (typeof value === 'string' && value.startsWith('=')) {
            formulas.push({ row: rowIndex + 2, column: columnIndex, formula: value });
          }
        });
      });
      await writeSheetFormulas(
        options.token,
        location.workbook.id,
        sheet.title,
        formulas,
        fetchImpl,
      );
    }
  }

  const syncedAt = nowIso();
  await saveLink(db, workspaceId, 'sheets', location.workbook, {
    contentHash,
    lastSyncedAt: syncedAt,
  });
  await clearDriveDirty(db, workspaceId);

  return {
    workspaceId,
    fileId: location.workbook.id,
    ...(location.workbook.webViewLink ? { webViewLink: location.workbook.webViewLink } : {}),
    skipped: false,
    contentHash,
    sheets: rendered.length,
  };
}

export interface FlushResult {
  synced: SyncResult[];
  failed: { workspaceId: string; error: string }[];
}

export async function flushDirtyWorkspaces(
  db: LedgerDatabase,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<FlushResult> {
  const result: FlushResult = { synced: [], failed: [] };
  for (const workspaceId of await listDirtyWorkspaces(db)) {
    try {
      result.synced.push(await syncWorkspaceToDrive(db, workspaceId, { token, fetchImpl }));
    } catch (error) {
      result.failed.push({
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export async function archiveMonthToDrive(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
  options: SyncOptions,
): Promise<{ file: DriveFile; contentHash: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const location = await ensureDriveLocation(db, workspaceId, options.token, fetchImpl);
  const data = await loadWorkbookData(db, workspaceId);
  const generatedAt =
    options.generatedAt ?? `${period}-01T00:00:00.000Z`;
  const spec = buildWorkbookSpec(data, { generatedAt, today: `${period}-01` });
  const buffer = await renderWorkbookXlsx(spec);
  const content = new Blob([buffer], { type: XLSX_MIME });
  const contentHash = await sha256Hex(buffer);

  const query = `trashed=false and ${appPropertiesQuery({
    app: '0ledger',
    kind: 'archive',
    workspaceId,
    period,
  })}`;
  const existing = await findFirstFile(options.token, query, fetchImpl);
  let file: DriveFile;
  if (existing) {
    file = await replaceFileContent(
      options.token,
      existing.id,
      content,
      XLSX_MIME,
      fetchImpl,
    );
  } else {
    file = await uploadFile(
      options.token,
      {
        name: archiveName(workspace, period),
        mimeType: XLSX_MIME,
        parents: [location.folder.id],
        appProperties: { app: '0ledger', kind: 'archive', workspaceId, period },
        content,
      },
      fetchImpl,
    );
  }
  await saveLink(db, workspaceId, 'xlsx', file, {
    contentHash,
    lastSyncedAt: nowIso(),
  });
  return { file, contentHash };
}

export async function readDriveSnapshot(
  token: string,
  spreadsheetId: string,
  fetchImpl: FetchLike = fetch,
): Promise<WorkbookSnapshot> {
  const values = await readSheetValues(token, spreadsheetId, '_snapshot', fetchImpl);
  const rows = values.length > 0 && String(values[0]?.[0] ?? '') === 'Chunk' ? values.slice(1) : values;
  return parseSnapshotChunks(rows);
}

function recordsForWorkspace(snapshot: WorkbookSnapshot, workspaceId: string, table: string): unknown[] {
  const records = snapshot.tables[table] ?? [];
  return records.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    const row = record as Record<string, unknown>;
    return row.id === workspaceId || row.workspaceId === workspaceId || table === 'workspaces';
  });
}

export interface SnapshotDiffTable {
  remote: number;
  local: number;
  changed: number;
  remoteOnly: number;
  localOnly: number;
}

export interface SnapshotDiff {
  workspaceId: string;
  tables: Record<string, SnapshotDiffTable>;
  changed: number;
  remoteOnly: number;
  localOnly: number;
}

function recordKey(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const id = (record as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

export async function diffDriveSnapshot(
  db: LedgerDatabase,
  workspaceId: string,
  snapshot: WorkbookSnapshot,
): Promise<SnapshotDiff> {
  const tables: Record<string, SnapshotDiffTable> = {};
  let totalChanged = 0;
  let totalRemoteOnly = 0;
  let totalLocalOnly = 0;

  for (const [table, records] of Object.entries(snapshot.tables)) {
    const remote = recordsForWorkspace(snapshot, workspaceId, table);
    const localTable = (db as unknown as Record<string, { where: (key: string) => { equals: (value: string) => { toArray: () => Promise<unknown[]> } } }>)[table];
    if (!localTable) continue;
    let local: unknown[];
    if (table === 'workspaces') {
      const row = await db.workspaces.get(workspaceId);
      local = row ? [row] : [];
    } else {
      local = await localTable.where('workspaceId').equals(workspaceId).toArray();
    }
    const localById = new Map<string, unknown>();
    for (const record of local) {
      const key = recordKey(record);
      if (key) localById.set(key, record);
    }
    const remoteIds = new Set<string>();
    let changed = 0;
    let remoteOnly = 0;
    for (const record of remote) {
      const key = recordKey(record);
      if (!key) continue;
      remoteIds.add(key);
      const existing = localById.get(key);
      if (!existing) {
        remoteOnly += 1;
      } else if (JSON.stringify(existing) !== JSON.stringify(record)) {
        changed += 1;
      }
    }
    const localOnly = [...localById.keys()].filter((key) => !remoteIds.has(key)).length;
    tables[table] = { remote: remote.length, local: local.length, changed, remoteOnly, localOnly };
    totalChanged += changed;
    totalRemoteOnly += remoteOnly;
    totalLocalOnly += localOnly;
  }

  return {
    workspaceId,
    tables,
    changed: totalChanged,
    remoteOnly: totalRemoteOnly,
    localOnly: totalLocalOnly,
  };
}

const RESTORE_TABLES = [
  'ledgerGroups',
  'ledgers',
  'parties',
  'stockItems',
  'godowns',
  'batches',
  'costCenters',
  'numberingSchemes',
  'vouchers',
  'voucherLines',
  'itemLines',
  'billAllocations',
  'costCenterAllocations',
  'taxAllocations',
  'statementLines',
  'reconciliations',
  'auditEvents',
] as const;

export type RestoreMode = 'merge' | 'replace';

const RESTORE_SCHEMAS: Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } }> = {
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
  statementLines: StatementLineSchema,
  reconciliations: ReconciliationSchema,
  auditEvents: AuditEventSchema,
};

function validateRecords(table: string, records: unknown[]): unknown[] {
  const schema = RESTORE_SCHEMAS[table];
  if (!schema) return records;
  return records.map((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) {
      throw new Error(`Invalid record ${index + 1} in Drive table ${table}: ${String(result.error)}`);
    }
    return result.data;
  });
}

export async function restoreDriveSnapshot(
  db: LedgerDatabase,
  workspaceId: string,
  snapshot: WorkbookSnapshot,
  mode: RestoreMode = 'merge',
): Promise<{ restored: number; mode: RestoreMode }> {
  const workspaceRecords = recordsForWorkspace(snapshot, workspaceId, 'workspaces');
  const remoteWorkspace = workspaceRecords[0] as { id?: string } | undefined;
  if (remoteWorkspace?.id && remoteWorkspace.id !== workspaceId) {
    throw new Error('Drive snapshot belongs to a different workspace');
  }

  const validated = new Map<string, unknown[]>();
  for (const table of ['workspaces', 'companies', ...RESTORE_TABLES]) {
    validated.set(table, validateRecords(table, recordsForWorkspace(snapshot, workspaceId, table)));
  }

  const tables = new Set(RESTORE_TABLES);
  let restored = 0;
  await db.transaction(
    'rw',
    [
      db.workspaces,
      db.companies,
      db.ledgerGroups,
      db.ledgers,
      db.parties,
      db.stockItems,
      db.godowns,
      db.batches,
      db.costCenters,
      db.numberingSchemes,
      db.vouchers,
      db.voucherLines,
      db.itemLines,
      db.billAllocations,
      db.costCenterAllocations,
      db.taxAllocations,
      db.statementLines,
      db.reconciliations,
      db.auditEvents,
    ],
    async () => {
      if (mode === 'replace') {
        for (const table of tables) {
          const target = (db as unknown as Record<string, { where: (key: string) => { equals: (value: string) => { delete: () => Promise<number> } } }>)[table];
          if (target) await target.where('workspaceId').equals(workspaceId).delete();
        }
        await db.companies.where('workspaceId').equals(workspaceId).delete();
      }
      const groupRecords = validated.get('ledgerGroups') ?? [];
      if (groupRecords.length > 0) await db.ledgerGroups.bulkPut(groupRecords as never[]);
      for (const table of RESTORE_TABLES.slice(1)) {
        const records = validated.get(table) ?? [];
        const target = (db as unknown as Record<string, { bulkPut: (rows: unknown[]) => Promise<unknown> }>)[table];
        if (target && records.length > 0) {
          await target.bulkPut(records);
          restored += records.length;
        }
      }
      const companies = validated.get('companies') ?? [];
      if (companies.length > 0) await db.companies.bulkPut(companies as never[]);
      const workspaceRow = validated.get('workspaces')?.[0];
      if (workspaceRow) await db.workspaces.put(workspaceRow as never);
      restored += groupRecords.length + companies.length;
    },
  );

  await markDriveDirty(db, workspaceId);
  return { restored, mode };
}
