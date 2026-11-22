import { invoke, isTauri } from '@tauri-apps/api/core';
import type { LedgerDatabase } from '@/core/db/db';
import { ingestFile, type StageImportResult } from '@/core/ingest';
import { captureStatementLines } from '@/core/autopilot';

export interface FolderDefaults {
  watch_folder: string;
  archive_folder: string;
}

export interface DiscoveredFile {
  path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  modified_ms: number;
  sha256: string;
}

export interface OrganizeRequest {
  source_path: string;
  archive_root: string;
  company_name: string;
  financial_year: string;
  period_month: string;
  category: string;
  action?: 'move' | 'copy';
}

export interface FolderWatcherConfig {
  watchFolder: string;
  archiveFolder: string;
  autoOrganize: boolean;
  action: 'move' | 'copy';
}

const CONFIG_KEY = '0ledger.folder_watcher.config';
const memoryStore = new Map<string, string>();

function getStorageItem(key: string): string | null {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
}

function setStorageItem(key: string, value: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  } else {
    memoryStore.set(key, value);
  }
}

export async function getDefaultFolders(): Promise<FolderDefaults> {
  if (isTauri()) {
    try {
      return await invoke<FolderDefaults>('get_default_folders');
    } catch (e) {
      console.warn('Failed to get default folders from Tauri, using fallback:', e);
    }
  }
  return {
    watch_folder: '~/Downloads',
    archive_folder: '~/0ledger/Archive',
  };
}

export function getWatcherConfig(workspaceId: string): FolderWatcherConfig {
  try {
    const raw = getStorageItem(`${CONFIG_KEY}:${workspaceId}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    watchFolder: '~/Downloads',
    archiveFolder: '~/0ledger/Archive',
    autoOrganize: true,
    action: 'copy',
  };
}

export function saveWatcherConfig(workspaceId: string, config: FolderWatcherConfig): void {
  setStorageItem(`${CONFIG_KEY}:${workspaceId}`, JSON.stringify(config));
}

export async function scanInboxFolder(folderPath: string): Promise<DiscoveredFile[]> {
  if (!isTauri()) {
    return [];
  }
  return await invoke<DiscoveredFile[]>('scan_inbox_folder', { folderPath });
}

export async function readFileBase64(filePath: string): Promise<string> {
  return await invoke<string>('read_file_base64', { filePath });
}

export async function organizeAccountingFile(req: OrganizeRequest): Promise<string> {
  return await invoke<string>('organize_accounting_file', { req });
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function classifyAccountingCategory(filename: string, ext: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('fastag') || lower.includes('toll') || lower.includes('nhai')) {
    return 'Fastag_Tolls';
  }
  if (
    lower.includes('statement') ||
    lower.includes('bank') ||
    lower.includes('hdfc') ||
    lower.includes('icici') ||
    lower.includes('sbi') ||
    lower.includes('axis') ||
    lower.includes('kotak')
  ) {
    return 'Bank_Statements';
  }
  if (
    lower.includes('invoice') ||
    lower.includes('bill') ||
    lower.includes('receipt') ||
    lower.includes('amazon') ||
    lower.includes('swiggy') ||
    lower.includes('uber') ||
    lower.includes('flipkart')
  ) {
    return 'Invoices';
  }
  if (ext === 'eml' || ext === 'msg') {
    return 'Emails';
  }
  return 'Unclassified';
}

export function currentFinancialYear(date = new Date()): string {
  const month = date.getMonth() + 1; // 1-12
  const year = date.getFullYear();
  if (month >= 4) {
    return `FY${year}-${String(year + 1).slice(2)}`;
  }
  return `FY${year - 1}-${String(year).slice(2)}`;
}

export function currentPeriodMonth(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

export const SUPPORTED_VAULT_EXTENSIONS = new Set([
  'pdf',
  'csv',
  'xlsx',
  'xls',
  'eml',
  'txt',
  'png',
  'jpg',
  'jpeg',
]);

export function inferMimeFromExtension(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === 'pdf') return 'application/pdf';
  if (lower === 'csv') return 'text/csv';
  if (lower === 'xlsx' || lower === 'xls') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (lower === 'eml') return 'message/rfc822';
  if (lower === 'txt') return 'text/plain';
  if (lower === 'png') return 'image/png';
  if (lower === 'jpg' || lower === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

export interface IngestCycleResult {
  discovered: number;
  newFilesIngested: number;
  transactionsCreated: number;
  filesOrganized: Array<{ source: string; destination: string }>;
  errors: string[];
}

export interface VaultHistoryEntry {
  sha256: string;
  filename: string;
  date: string;
  txns: number;
  category?: string;
  destination?: string;
}

export async function listVaultHistory(db: LedgerDatabase): Promise<VaultHistoryEntry[]> {
  const rows = await db.syncState
    .filter((entry) => entry.key.startsWith('vault.file:'))
    .toArray();
  const parsed: VaultHistoryEntry[] = [];
  for (const row of rows) {
    try {
      const data = (
        typeof row.value === 'string' ? JSON.parse(row.value) : row.value
      ) as Partial<VaultHistoryEntry> | null;
      if (!data || typeof data !== 'object') continue;
      parsed.push({
        sha256: row.key.slice('vault.file:'.length),
        filename: data.filename ?? 'Unknown file',
        date: data.date ?? '',
        txns: typeof data.txns === 'number' ? data.txns : 0,
        ...(data.category ? { category: data.category } : {}),
        ...(data.destination ? { destination: data.destination } : {}),
      });
    } catch {
      // ignore malformed syncState entry
    }
  }
  return parsed.sort((a, b) => b.date.localeCompare(a.date));
}

export async function runFolderIngestionCycle(
  db: LedgerDatabase,
  workspaceId: string,
  companyName: string,
  config: FolderWatcherConfig,
  password?: string,
): Promise<IngestCycleResult> {
  const files = await scanInboxFolder(config.watchFolder);
  const result: IngestCycleResult = {
    discovered: files.length,
    newFilesIngested: 0,
    transactionsCreated: 0,
    filesOrganized: [],
    errors: [],
  };

  const fy = currentFinancialYear();
  const period = currentPeriodMonth();

  for (const file of files) {
    try {
      const syncKey = `vault.file:${file.sha256}`;
      const existing = await db.syncState.get(syncKey);
      if (existing) {
        continue; // File was already processed
      }

      const base64 = await readFileBase64(file.path);
      const bytes = base64ToUint8Array(base64);
      const mimeType = inferMimeFromExtension(file.extension);

      const stagedList: StageImportResult[] = await ingestFile(
        db,
        workspaceId,
        {
          fileName: file.filename,
          mimeType,
          bytes: bytes.buffer as ArrayBuffer,
          ...(password ? { password } : {}),
        },
      );

      let txnsForFile = 0;
      for (const staged of stagedList) {
        const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
        txnsForFile += captured.created.length;
      }

      result.newFilesIngested += 1;
      result.transactionsCreated += txnsForFile;

      const category = classifyAccountingCategory(file.filename, file.extension);
      let destination: string | undefined;

      // Auto-organize into Vault
      if (config.autoOrganize) {
        destination = await organizeAccountingFile({
          source_path: file.path,
          archive_root: config.archiveFolder,
          company_name: companyName,
          financial_year: fy,
          period_month: period,
          category,
          action: config.action,
        });
        result.filesOrganized.push({ source: file.path, destination });
      }

      // Mark file as processed
      await db.syncState.put({
        key: syncKey,
        value: JSON.stringify({
          filename: file.filename,
          date: new Date().toISOString(),
          txns: txnsForFile,
          category,
          ...(destination ? { destination } : {}),
        }),
      });
    } catch (e) {
      result.errors.push(`${file.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

export interface BrowserSelectedFile {
  file: File;
  relativePath: string;
  extension: string;
  sha256: string;
  alreadyProcessed: boolean;
  category: string;
}

export async function runBrowserFolderIngestion(
  db: LedgerDatabase,
  workspaceId: string,
  companyName: string,
  config: FolderWatcherConfig,
  files: BrowserSelectedFile[],
  password?: string,
): Promise<IngestCycleResult> {
  const result: IngestCycleResult = {
    discovered: files.length,
    newFilesIngested: 0,
    transactionsCreated: 0,
    filesOrganized: [],
    errors: [],
  };

  const fy = currentFinancialYear();
  const period = currentPeriodMonth();
  const safeCompany = companyName.replace(/[^a-z0-9._-]+/gi, '_') || 'Company';

  for (const item of files) {
    try {
      const syncKey = `vault.file:${item.sha256}`;
      const existing = await db.syncState.get(syncKey);
      if (existing) {
        continue;
      }

      const bytes = await item.file.arrayBuffer();
      const mimeType = item.file.type || inferMimeFromExtension(item.extension);

      const stagedList: StageImportResult[] = await ingestFile(db, workspaceId, {
        fileName: item.file.name,
        mimeType,
        bytes,
        ...(password ? { password } : {}),
      });

      let txnsForFile = 0;
      for (const staged of stagedList) {
        const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
        txnsForFile += captured.created.length;
      }

      const category = item.category;
      const virtualDest = `${config.archiveFolder.replace(/\/+$/, '')}/${safeCompany}/${fy}/${period}/${category}/${item.file.name}`;

      result.newFilesIngested += 1;
      result.transactionsCreated += txnsForFile;
      if (config.autoOrganize) {
        result.filesOrganized.push({ source: item.relativePath, destination: virtualDest });
      }

      await db.syncState.put({
        key: syncKey,
        value: JSON.stringify({
          filename: item.file.name,
          date: new Date().toISOString(),
          txns: txnsForFile,
          category,
          destination: virtualDest,
        }),
      });
    } catch (e) {
      result.errors.push(`${item.file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

