import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  FileSpreadsheet,
  KeyRound,
  RefreshCw,
  Shield,
  Upload,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  backupFilename,
  createBackup,
  MAX_BACKUP_BYTES,
  restoreBackup,
  type BackupEnvelope,
  type RestoreMode,
} from '@/core/backup';
import {
  exportBeancount,
  exportOfx,
  exportTallyMasters,
  exportTallyVouchers,
  importBeancount,
  importTallyXml,
  ledgersCsv,
  trialBalanceCsv,
  voucherLinesCsv,
} from '@/core/interchange';
import { checkTallyReadiness } from '@/core/ledger/validation';
import {
  pushLedgerToTallyPrime,
  testTallyConnection,
} from '@/core/interchange/tally-bridge';
import {
  buildWorkbookSpec,
  loadWorkbookData,
  renderWorkbookXlsx,
  type WorkbookData,
} from '@/core/template';

interface Props {
  workspaceId: string;
  onChanged?: ((message: string) => void) | undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function downloadText(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadBinary(filename: string, bytes: ArrayBuffer, type: string): void {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || '0ledger';
}

export function BooksExportPanel({ workspaceId, onChanged }: Props) {
  const [data, setData] = useState<WorkbookData>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<string[]>([]);

  // Export & import options
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [tallyFile, setTallyFile] = useState<File>();
  const [beancountFile, setBeancountFile] = useState<File>();

  // Encrypted local backup
  const [backupPassword, setBackupPassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);

  // Optional Tally Prime Live Bridge
  const [showTallyBridge, setShowTallyBridge] = useState(false);
  const [tallyUrl, setTallyUrl] = useState('http://localhost:9000');
  const [tallyStatus, setTallyStatus] = useState<string>();

  const refresh = useCallback(async () => {
    const next = await loadWorkbookData(getDb(), workspaceId);
    setData(next);
    const banks = next.ledgers.filter((ledger) => ledger.isBank);
    setBankLedgerId((current) =>
      banks.some((ledger) => ledger.id === current) ? current : banks[0]?.id ?? '',
    );
  }, [workspaceId]);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  function pushNotice(msg: string) {
    setNotice(msg);
    onChanged?.(msg);
  }

  async function runExport(action: (current: WorkbookData) => Promise<void> | void) {
    if (!data) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      await action(data);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function exportFile(
    extension: string,
    mime: string,
    label: string,
    build: (current: WorkbookData) => string,
  ) {
    void runExport((current) => {
      downloadText(
        `${safeFilename(current.workspace.slug)}-${label}.${extension}`,
        build(current),
        mime,
      );
      pushNotice(`Downloaded ${label}.${extension}.`);
    });
  }

  function exportExcelWorkbook() {
    void runExport(async (current) => {
      const spec = buildWorkbookSpec(current);
      const buffer = await renderWorkbookXlsx(spec);
      downloadBinary(
        `${safeFilename(current.workspace.slug)}-workbook.xlsx`,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      pushNotice(`Downloaded multi-sheet Excel workbook (${spec.sheets.length} sheets).`);
    });
  }

  function checkReadiness() {
    void runExport((current) => {
      const vouchers = current.vouchers.filter((voucher) => voucher.status === 'regular');
      const ids = new Set(vouchers.map((voucher) => voucher.id));
      const result = checkTallyReadiness({
        company: current.company,
        ledgers: current.ledgers,
        parties: current.parties,
        stockItems: current.stockItems,
        vouchers,
        lines: current.voucherLines.filter((line) => ids.has(line.voucherId)),
        itemLines: current.itemLines.filter((line) => ids.has(line.voucherId)),
        billAllocations: current.billAllocations.filter((item) => ids.has(item.voucherId)),
        taxAllocations: current.taxAllocations.filter((item) => ids.has(item.voucherId)),
        numberingSchemes: current.numberingSchemes,
        fyStartMonth: current.company.settings.fyStartMonth,
      });
      setIssues(
        result.issues.slice(0, 25).map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      );
      setNotice(
        result.ok
          ? `Tally readiness passed with ${result.issues.length} warning(s).`
          : `Tally readiness found ${result.issues.filter((issue) => issue.severity === 'error').length} error(s).`,
      );
    });
  }

  async function handleImportTally() {
    if (!tallyFile) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      const xml = await tallyFile.text();
      const result = await importTallyXml(getDb(), workspaceId, xml);
      setIssues(result.errors.map((item) => `${item.voucher ?? 'Voucher'}: ${item.message}`));
      pushNotice(
        `Imported ${result.imported} Tally voucher(s), skipped ${result.skipped}. Added ${result.masters.ledgers} ledger(s) and ${result.masters.stockItems} stock item(s).`,
      );
      setTallyFile(undefined);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportBeancount() {
    if (!beancountFile) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      const text = await beancountFile.text();
      const result = await importBeancount(getDb(), workspaceId, text);
      setIssues(result.errors.map((item) => `Line ${item.line}: ${item.message}`));
      pushNotice(
        `Imported ${result.imported} Beancount transaction(s), skipped ${result.skipped}.`,
      );
      setBeancountFile(undefined);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadBackup() {
    if (backupPassword.length < 8) {
      setError('Backup passphrase must be at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const envelope = await createBackup(getDb(), backupPassword);
      downloadText(backupFilename(), JSON.stringify(envelope, null, 2), 'application/json');
      setBackupPassword('');
      pushNotice('Encrypted .0ledger backup downloaded.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreBackup() {
    if (!restoreFile) {
      setError('Choose a .0ledger backup file first.');
      return;
    }
    if (restoreFile.size > MAX_BACKUP_BYTES) {
      setError('Backup file exceeds the 50 MB size limit.');
      return;
    }
    if (restorePassword.length < 8) {
      setError('Enter the passphrase used to encrypt this backup.');
      return;
    }
    if (restoreMode === 'replace' && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const envelope = JSON.parse(await restoreFile.text()) as BackupEnvelope;
      const result = await restoreBackup(getDb(), envelope, restorePassword, { mode: restoreMode });
      setRestoreFile(undefined);
      setRestorePassword('');
      setConfirmReplace(false);
      pushNotice(
        `Restored ${result.totalRecords} record(s) using ${result.mode} mode.`,
      );
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleTestTally() {
    setBusy(true);
    setError(undefined);
    setTallyStatus(undefined);
    try {
      const res = await testTallyConnection(tallyUrl);
      if (res.online) {
        setTallyStatus(
          res.companyNames.length > 0
            ? `Connected to Tally Prime (${res.companyNames.join(', ')})`
            : 'Connected to Tally Prime XML server',
        );
      } else {
        setTallyStatus(res.errorMessage ?? 'Unable to reach Tally Prime on this URL.');
      }
    } catch (cause) {
      setTallyStatus(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handlePushToTally() {
    if (!data) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await pushLedgerToTallyPrime(data, {
        endpoint: tallyUrl,
        exportOptions: { allowIncomplete },
      });
      if (res.success) {
        pushNotice(
          `Pushed to Tally Prime: ${res.created} created, ${res.altered} altered, ${res.errors} errors.`,
        );
      } else {
        setError(res.errorMessages[0] ?? 'Tally Prime rejected the XML payload.');
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading export & backup tools...
      </div>
    );
  }

  const banks = data.ledgers.filter((ledger) => ledger.isBank);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
          Export & backup
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Your books stay in open formats. Export for your CA or Tally, or keep an encrypted local
          backup.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="mb-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
            Validation notes ({issues.length})
          </div>
          <ul className="space-y-1 text-xs text-amber-900 dark:text-amber-200">
            {issues.map((issue, idx) => (
              <li key={`${idx}-${issue}`}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Section 1: Standard Exports */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="mb-4 flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Accounting & Tally exports
            </h3>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              onClick={exportExcelWorkbook}
              className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2.5 text-left text-sm font-medium text-indigo-900 transition hover:bg-indigo-50 disabled:opacity-50 sm:col-span-2 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-200 dark:hover:bg-indigo-950/50"
            >
              <span>Full Excel workbook (.xlsx with formulas)</span>
              <Download className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                exportFile('xml', 'application/xml', 'tally-masters', (current) =>
                  exportTallyMasters(current, { allowIncomplete }),
                )
              }
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Tally masters XML</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                exportFile('xml', 'application/xml', 'tally-vouchers', (current) =>
                  exportTallyVouchers(current, { allowIncomplete }),
                )
              }
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Tally vouchers XML</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => exportFile('csv', 'text/csv', 'voucher-lines', voucherLinesCsv)}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Voucher lines CSV</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => exportFile('csv', 'text/csv', 'trial-balance', trialBalanceCsv)}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Trial balance CSV</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => exportFile('csv', 'text/csv', 'ledgers', ledgersCsv)}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Chart of accounts CSV</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                exportFile('beancount', 'text/plain', 'books', (current) => exportBeancount(current))
              }
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm font-medium text-slate-800 transition hover:border-indigo-300 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Beancount ledger</span>
              <Download className="h-4 w-4 text-slate-400" />
            </button>
          </div>

          {/* OFX Bank export */}
          <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:items-center dark:border-slate-800">
            <select
              value={bankLedgerId}
              onChange={(event) => setBankLedgerId(event.target.value)}
              aria-label="Bank account for OFX export"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {banks.length === 0 ? <option value="">No bank ledger</option> : null}
              {banks.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !bankLedgerId}
              onClick={() =>
                exportFile('ofx', 'application/x-ofx', 'statement', (current) =>
                  exportOfx(current, { bankLedgerId }),
                )
              }
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export OFX</span>
            </button>
          </div>

          {/* Tally readiness check */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={allowIncomplete}
                onChange={(event) => setAllowIncomplete(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>Allow partial Tally XML export</span>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={checkReadiness}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Run Tally readiness check</span>
            </button>
          </div>
        </section>

        {/* Section 2: Import Ledger Data */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="mb-4 flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Import from Tally or Beancount
            </h3>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Tally Prime XML (masters or vouchers)
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="file"
                  accept=".xml,application/xml,text/xml"
                  onChange={(event) => setTallyFile(event.target.files?.[0])}
                  className="block flex-1 text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
                />
                <button
                  type="button"
                  disabled={busy || !tallyFile}
                  onClick={() => void handleImportTally()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Import XML</span>
                </button>
              </div>
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Beancount file (.beancount / .bean)
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="file"
                  accept=".beancount,.bean,.txt,text/plain"
                  onChange={(event) => setBeancountFile(event.target.files?.[0])}
                  className="block flex-1 text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
                />
                <button
                  type="button"
                  disabled={busy || !beancountFile}
                  onClick={() => void handleImportBeancount()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Import Beancount</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Section 3: Encrypted Local Backup & Restore */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="mb-4 flex items-center gap-2">
          <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
            Encrypted local backup (.0ledger)
          </h3>
        </div>
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          AES-256-GCM encrypted in your browser with PBKDF2-SHA256. Keep a copy offline or move
          your books between devices.
        </p>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Download backup */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Create encrypted backup
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={backupPassword}
                  onChange={(event) => setBackupPassword(event.target.value)}
                  placeholder="Passphrase (min 8 chars)"
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
              <button
                type="button"
                disabled={busy || backupPassword.length < 8}
                onClick={() => void handleDownloadBackup()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                <span>Download backup</span>
              </button>
            </div>
          </div>

          {/* Restore backup */}
          <div className="space-y-3 border-t border-slate-100 pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0 dark:border-slate-800">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Restore from backup
            </div>
            <input
              type="file"
              accept=".0ledger,.json,application/json"
              onChange={(event) => {
                setRestoreFile(event.target.files?.[0]);
                setConfirmReplace(false);
              }}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-400 dark:file:bg-slate-800 dark:file:text-slate-200"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={restorePassword}
                onChange={(event) => setRestorePassword(event.target.value)}
                placeholder="Backup passphrase"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <select
                value={restoreMode}
                onChange={(event) => {
                  setRestoreMode(event.target.value as RestoreMode);
                  setConfirmReplace(false);
                }}
                aria-label="Restore mode"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="merge">Merge records</option>
                <option value="replace">Replace all data</option>
              </select>
              <button
                type="button"
                disabled={busy || !restoreFile || restorePassword.length < 8}
                onClick={() => void handleRestoreBackup()}
                className={
                  confirmReplace
                    ? 'inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50'
                    : 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'
                }
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{confirmReplace ? 'Confirm replace' : 'Restore'}</span>
              </button>
            </div>
            {confirmReplace ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                Replace mode overwrites all local companies and vouchers. Click Confirm replace to
                proceed.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Section 4: Collapsible Tally Prime Live Bridge */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        <button
          type="button"
          onClick={() => setShowTallyBridge((open) => !open)}
          className="flex w-full items-center justify-between px-5 py-4 text-left"
        >
          <div>
            <div className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Tally Prime live bridge (optional)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Connect directly to a local Tally Prime XML server on port 9000.
            </div>
          </div>
          {showTallyBridge ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
        </button>

        {showTallyBridge ? (
          <div className="space-y-4 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Tally server URL
                </span>
                <input
                  value={tallyUrl}
                  onChange={(event) => setTallyUrl(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTestTally()}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Test</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handlePushToTally()}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>Push books</span>
                </button>
              </div>
            </div>

            {tallyStatus ? (
              <p className="text-xs text-slate-600 dark:text-slate-300">{tallyStatus}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
