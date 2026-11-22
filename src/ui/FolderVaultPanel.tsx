import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  ArrowRight,
  FolderOpen,
  FolderSync,
  Lock,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import { sha256Hex } from '@/core/util/hash';
import {
  classifyAccountingCategory,
  getDefaultFolders,
  getWatcherConfig,
  listVaultHistory,
  runBrowserFolderIngestion,
  runFolderIngestionCycle,
  saveWatcherConfig,
  scanInboxFolder,
  SUPPORTED_VAULT_EXTENSIONS,
  type BrowserSelectedFile,
  type DiscoveredFile,
  type FolderWatcherConfig,
  type IngestCycleResult,
  type VaultHistoryEntry,
} from '@/core/desktop/folder-watcher';

interface FolderVaultPanelProps {
  workspaceId: string;
  companyName: string;
  onChanged?: ((message: string) => void) | undefined;
  onOpenInbox?: (() => void) | undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fileExtension(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? (parts[parts.length - 1] ?? '').toLowerCase() : '';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function FolderVaultPanel({
  workspaceId,
  companyName,
  onChanged,
  onOpenInbox,
}: FolderVaultPanelProps) {
  const native = isTauri();
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const [config, setConfig] = useState<FolderWatcherConfig>(() => getWatcherConfig(workspaceId));
  const [nativeFiles, setNativeFiles] = useState<DiscoveredFile[]>([]);
  const [browserFiles, setBrowserFiles] = useState<BrowserSelectedFile[]>([]);
  const [history, setHistory] = useState<VaultHistoryEntry[]>([]);
  const [pdfPassword, setPdfPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [lastResult, setLastResult] = useState<IngestCycleResult>();

  const loadHistory = useCallback(async () => {
    const entries = await listVaultHistory(getDb());
    setHistory(entries);
  }, []);

  useEffect(() => {
    const stored = getWatcherConfig(workspaceId);
    setConfig(stored);
    void loadHistory();
    if (native && stored.watchFolder === '~/Downloads') {
      void getDefaultFolders().then((defaults) => {
        setConfig((current) =>
          current.watchFolder === '~/Downloads'
            ? {
                ...current,
                watchFolder: defaults.watch_folder,
                archiveFolder: defaults.archive_folder,
              }
            : current,
        );
      });
    }
  }, [workspaceId, native, loadHistory]);

  function handleSaveConfig() {
    saveWatcherConfig(workspaceId, config);
    const msg = 'Saved folder watcher and archive settings.';
    setNotice(msg);
    onChanged?.(msg);
  }

  async function handleNativeScan() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const found = await scanInboxFolder(config.watchFolder);
      setNativeFiles(found);
      setNotice(`Found ${found.length} accounting file(s) in ${config.watchFolder}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleNativeIngest() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      saveWatcherConfig(workspaceId, config);
      const res = await runFolderIngestionCycle(
        getDb(),
        workspaceId,
        companyName,
        config,
        pdfPassword.trim() || undefined,
      );
      setLastResult(res);
      const msg = `Ingested ${res.newFilesIngested} new file(s) and staged ${res.transactionsCreated} transaction(s) in Money inbox.`;
      setNotice(msg);
      onChanged?.(msg);
      await loadHistory();
      const remaining = await scanInboxFolder(config.watchFolder);
      setNativeFiles(remaining);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleBrowserFolderSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const db = getDb();
      const staged: BrowserSelectedFile[] = [];
      let unsupportedCount = 0;

      for (const file of Array.from(fileList)) {
        const ext = fileExtension(file.name);
        if (!SUPPORTED_VAULT_EXTENSIONS.has(ext)) {
          unsupportedCount += 1;
          continue;
        }
        const bytes = await file.arrayBuffer();
        const sha256 = await sha256Hex(bytes);
        const existing = await db.syncState.get(`vault.file:${sha256}`);
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        staged.push({
          file,
          relativePath,
          extension: ext,
          sha256,
          alreadyProcessed: Boolean(existing),
          category: classifyAccountingCategory(file.name, ext),
        });
      }

      setBrowserFiles(staged);
      const freshCount = staged.filter((f) => !f.alreadyProcessed).length;
      setNotice(
        `Scanned ${staged.length} supported accounting file(s) (${freshCount} new, ${
          staged.length - freshCount
        } already imported${unsupportedCount > 0 ? `, ${unsupportedCount} unsupported skipped` : ''}).`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      if (folderInputRef.current) {
        folderInputRef.current.value = '';
      }
    }
  }

  async function handleBrowserIngest() {
    if (browserFiles.length === 0) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      saveWatcherConfig(workspaceId, config);
      const res = await runBrowserFolderIngestion(
        getDb(),
        workspaceId,
        companyName,
        config,
        browserFiles,
        pdfPassword.trim() || undefined,
      );
      setLastResult(res);
      const msg =
        res.newFilesIngested > 0
          ? `Ingested ${res.newFilesIngested} new file(s) and staged ${res.transactionsCreated} transaction(s) in Money inbox.`
          : 'All selected files were already processed previously (deduplicated by SHA-256).';
      setNotice(msg);
      onChanged?.(msg);
      setBrowserFiles((prev) => prev.map((item) => ({ ...item, alreadyProcessed: true })));
      await loadHistory();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearVaultEntry(sha256: string) {
    await getDb().syncState.delete(`vault.file:${sha256}`);
    setBrowserFiles((prev) =>
      prev.map((item) => (item.sha256 === sha256 ? { ...item, alreadyProcessed: false } : item)),
    );
    await loadHistory();
    setNotice('Removed file hash from vault history. It can be re-ingested on the next scan.');
  }

  const newBrowserCount = browserFiles.filter((f) => !f.alreadyProcessed).length;

  return (
    <div className="space-y-5">
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span>{notice}</span>
          {onOpenInbox && lastResult && lastResult.transactionsCreated > 0 ? (
            <button
              type="button"
              onClick={onOpenInbox}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-800 underline underline-offset-2 hover:text-emerald-950 dark:text-emerald-200"
            >
              <span>Review in Money inbox</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Main Folder Scanner & Action Bar */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              {native ? 'Desktop folder watcher & vault' : 'Batch folder scan & vault'}
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {native
                ? 'Scan a local downloads folder for bank statements, invoices, and receipts, stage transactions to Money inbox, and archive files by financial year.'
                : 'Select an entire folder of downloaded bank statements, CSVs, XLSX, PDFs, or EMLs. Duplicate files are skipped automatically via SHA-256.'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {native ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleNativeScan()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                  <span>Scan folder</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleNativeIngest()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  <FolderSync className="h-3.5 w-3.5" />
                  <span>{busy ? 'Ingesting...' : 'Ingest & archive'}</span>
                </button>
              </>
            ) : (
              <>
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  // @ts-expect-error webkitdirectory is standard in Chromium/Firefox/Safari for folder selection
                  webkitdirectory=""
                  onChange={(event) => void handleBrowserFolderSelected(event.target.files)}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Choose folder</span>
                </button>
                <button
                  type="button"
                  disabled={busy || newBrowserCount === 0}
                  onClick={() => void handleBrowserIngest()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  <FolderSync className="h-3.5 w-3.5" />
                  <span>
                    {busy
                      ? 'Ingesting...'
                      : newBrowserCount > 0
                        ? `Ingest ${newBrowserCount} new file(s)`
                        : 'Ingest new files'}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Watcher / Vault Configuration */}
        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800">
          {native ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Watch folder
              </span>
              <input
                value={config.watchFolder}
                onChange={(e) => setConfig({ ...config, watchFolder: e.target.value })}
                placeholder="~/Downloads"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          ) : null}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Archive vault path
            </span>
            <input
              value={config.archiveFolder}
              onChange={(e) => setConfig({ ...config, archiveFolder: e.target.value })}
              placeholder="~/0ledger/Archive"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Archive action
            </span>
            <select
              value={config.action}
              onChange={(e) =>
                setConfig({ ...config, action: e.target.value as 'copy' | 'move' })
              }
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="copy">Copy to vault (keep originals)</option>
              <option value="move">Move to vault (clean inbox)</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <Lock className="h-3 w-3" />
              <span>PDF password (optional)</span>
            </span>
            <input
              type="password"
              value={pdfPassword}
              onChange={(e) => setPdfPassword(e.target.value)}
              placeholder="For protected statements"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={config.autoOrganize}
              onChange={(e) => setConfig({ ...config, autoOrganize: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              Auto-classify into{' '}
              <span className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
                {config.archiveFolder}/{companyName}/FY/Month/Category
              </span>
            </span>
          </label>

          <button
            type="button"
            onClick={handleSaveConfig}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Save preferences</span>
          </button>
        </div>
      </section>

      {/* Last Ingestion Summary */}
      {lastResult ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Latest ingestion summary
            </h4>
            <div className="num-tabular flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{lastResult.discovered} scanned</span>
              <span aria-hidden="true">·</span>
              <span>{lastResult.newFilesIngested} ingested</span>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-emerald-700 dark:text-emerald-400">
                {lastResult.transactionsCreated} transactions
              </span>
            </div>
          </div>

          {lastResult.filesOrganized.length > 0 ? (
            <div className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
              {lastResult.filesOrganized.map((item, idx) => (
                <div key={`${item.destination}-${idx}`} className="truncate font-mono text-[11px]">
                  {item.source} → {item.destination}
                </div>
              ))}
            </div>
          ) : null}

          {lastResult.errors.length > 0 ? (
            <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-rose-700 dark:border-slate-800 dark:text-rose-300">
              {lastResult.errors.map((err, idx) => (
                <div key={`${err}-${idx}`}>{err}</div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Discovered Files Queue */}
      {(native ? nativeFiles.length > 0 : browserFiles.length > 0) ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Discovered files ({native ? nativeFiles.length : browserFiles.length})
            </h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                  <th className="px-4 py-2.5 font-medium">File</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-4 py-2.5 font-medium text-right">Size</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {native
                  ? nativeFiles.map((file) => (
                      <tr key={file.path}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {file.filename}
                          </div>
                          <div className="num-tabular text-[11px] text-slate-400">
                            {file.extension.toUpperCase()} · {file.sha256.slice(0, 10)}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                          {classifyAccountingCategory(file.filename, file.extension).replace(
                            /_/g,
                            ' ',
                          )}
                        </td>
                        <td className="num-tabular px-4 py-2.5 text-right text-slate-600 dark:text-slate-300">
                          {formatBytes(file.size_bytes)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">
                          Ready to scan
                        </td>
                      </tr>
                    ))
                  : browserFiles.map((item) => (
                      <tr key={item.sha256 + item.relativePath}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {item.file.name}
                          </div>
                          <div className="num-tabular text-[11px] text-slate-400">
                            {item.extension.toUpperCase()} · {item.sha256.slice(0, 10)}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                          {item.category.replace(/_/g, ' ')}
                        </td>
                        <td className="num-tabular px-4 py-2.5 text-right text-slate-600 dark:text-slate-300">
                          {formatBytes(item.file.size)}
                        </td>
                        <td className="px-4 py-2.5">
                          {item.alreadyProcessed ? (
                            <span className="text-slate-400 dark:text-slate-500">
                              Already imported
                            </span>
                          ) : (
                            <span className="font-medium text-indigo-600 dark:text-indigo-400">
                              New
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Processed Vault History */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div>
            <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Vault history
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Files previously hashed and imported by folder vault.
            </p>
          </div>
          <span className="num-tabular text-xs text-slate-500 dark:text-slate-400">
            {history.length} file(s)
          </span>
        </div>

        {history.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No files processed through the folder vault yet. Choose a folder above to ingest
            statements in bulk.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                  <th className="px-4 py-2.5 font-medium">File</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-4 py-2.5 font-medium text-right">Transactions</th>
                  <th className="px-4 py-2.5 font-medium">Processed</th>
                  <th className="px-4 py-2.5 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {history.slice(0, 25).map((entry) => (
                  <tr key={entry.sha256}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {entry.filename}
                      </div>
                      {entry.destination ? (
                        <div className="max-w-md truncate font-mono text-[11px] text-slate-400">
                          {entry.destination}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                      {(entry.category ?? 'Unclassified').replace(/_/g, ' ')}
                    </td>
                    <td className="num-tabular px-4 py-2.5 text-right font-medium text-slate-900 dark:text-slate-100">
                      {entry.txns}
                    </td>
                    <td className="num-tabular px-4 py-2.5 text-slate-500 dark:text-slate-400">
                      {entry.date ? entry.date.slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void handleClearVaultEntry(entry.sha256)}
                        title="Allow re-importing this file"
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Reset</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
