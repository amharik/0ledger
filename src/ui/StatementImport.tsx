import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Inbox, RotateCcw, Trash2, Upload } from 'lucide-react';
import { getDb } from '@/core/db/db';
import type { ImportBatch, Ledger, StatementLine } from '@/core/model';
import {
  commitImportBatch,
  discardImportBatch,
  ingestFile,
  listImportBatches,
  listStatementLines,
  stageImport,
  undoImportBatch,
  verifyStatementBalance,
  type StageImportResult,
} from '@/core/ingest';
import { parseTextStatement } from '@/core/ingest/parsers';
import { MAX_INGEST_BYTES } from '@/core/ingest/limits';
import { captureStatementLines } from '@/core/autopilot';
import { formatMinor } from '@/core/money/money';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  refreshToken: number;
  onChanged: (message: string) => void;
}

export function StatementImport({ workspaceId, ledgers, refreshToken, onChanged }: Props) {
  const banks = useMemo(
    () => ledgers.filter((ledger) => ledger.isBank && !ledger.archived),
    [ledgers],
  );
  const expenses = useMemo(
    () =>
      ledgers
        .filter((ledger) => !ledger.archived && !ledger.isBank && !ledger.isTax && !ledger.isSystem)
        .sort((a, b) =>
          a.name === 'Purchases'
            ? -1
            : b.name === 'Purchases'
              ? 1
              : a.name.localeCompare(b.name),
        ),
    [ledgers],
  );

  const [accountId, setAccountId] = useState('');
  const [defaultLedgerId, setDefaultLedgerId] = useState('');
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<StageImportResult[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string>();
  const [rows, setRows] = useState<StatementLine[]>([]);
  const [confirmAction, setConfirmAction] = useState<'discard' | 'undo' | null>(null);
  const [acknowledgeMismatch, setAcknowledgeMismatch] = useState(false);

  const activeBatch = batches.find((batch) => batch.id === activeBatchId);

  useEffect(() => {
    if (!accountId && banks[0]) setAccountId(banks[0].id);
    if (accountId && !banks.some((ledger) => ledger.id === accountId)) {
      setAccountId(banks[0]?.id ?? '');
    }
  }, [accountId, banks]);

  useEffect(() => {
    if (!defaultLedgerId && expenses[0]) setDefaultLedgerId(expenses[0].id);
    if (defaultLedgerId && !expenses.some((ledger) => ledger.id === defaultLedgerId)) {
      setDefaultLedgerId(expenses[0]?.id ?? '');
    }
  }, [defaultLedgerId, expenses]);

  useEffect(() => {
    let cancelled = false;
    void listImportBatches(getDb(), workspaceId).then((list) => {
      if (!cancelled) setBatches(list);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken, results]);

  useEffect(() => {
    setConfirmAction(null);
    setAcknowledgeMismatch(false);
    if (!activeBatchId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    void listStatementLines(getDb(), activeBatchId).then((list) => {
      if (!cancelled) setRows(list);
    });
    return () => {
      cancelled = true;
    };
  }, [activeBatchId, refreshToken, results]);

  function accept(result: StageImportResult[]) {
    setResults(result);
    setActiveBatchId(result[result.length - 1]?.batch.id);
    const total = result.reduce((sum, item) => sum + item.batch.totalLines, 0);
    const duplicates = result.reduce((sum, item) => sum + item.duplicates, 0);
    onChanged(
      `Staged ${total} line${total === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} duplicate skipped` : ''}`,
    );
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    if (file.size > MAX_INGEST_BYTES) {
      setError('File exceeds the 25 MB limit.');
      setBusy(false);
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const staged = await ingestFile(
        getDb(),
        workspaceId,
        {
          fileName: file.name,
          mimeType: file.type,
          bytes,
          ...(password ? { password } : {}),
        },
        { ...(accountId ? { accountId } : {}) },
      );
      accept(staged);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function stagePasted() {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const statement = parseTextStatement(text, { fileName: 'pasted-statement.txt' });
      const staged = await stageImport(getDb(), {
        workspaceId,
        source: 'manual',
        statement,
        fileName: 'pasted-statement.txt',
        ...(accountId ? { accountId } : {}),
      });
      accept([staged]);
      setText('');
      setShowPaste(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendToInbox() {
    if (!activeBatch) return;
    if (balanceCheck && balanceCheck.mismatches.length > 0 && !acknowledgeMismatch) {
      setError('Review and acknowledge the balance mismatch before sending this batch to the Inbox.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await captureStatementLines(getDb(), workspaceId, activeBatch, rows);
      onChanged(
        `Sent ${result.created.length} event${result.created.length === 1 ? '' : 's'} to Money Inbox`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!activeBatchId || !accountId || !defaultLedgerId) return;
    if (balanceCheck && balanceCheck.mismatches.length > 0 && !acknowledgeMismatch) {
      setError('Review and acknowledge the balance mismatch before posting this batch.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await commitImportBatch(getDb(), workspaceId, activeBatchId, {
        accountId,
        defaultLedgerId,
        actor: 'desktop',
      });
      if (result.errors.length) setError(result.errors.join('\n'));
      onChanged(`Posted ${result.committed} voucher${result.committed === 1 ? '' : 's'}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function discard(batchId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await discardImportBatch(getDb(), workspaceId, batchId);
      if (activeBatchId === batchId) setActiveBatchId(undefined);
      setConfirmAction(null);
      onChanged('Staged import discarded');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function undo(batchId: string) {
    setBusy(true);
    setError(undefined);
    try {
      const count = await undoImportBatch(getDb(), workspaceId, batchId);
      setConfirmAction(null);
      onChanged(`Undid ${count} posted voucher${count === 1 ? '' : 's'}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const balanceCheck = activeBatch
    ? verifyStatementBalance(rows, {
        ...(activeBatch.openingBalanceMinor === undefined
          ? {}
          : { openingBalanceMinor: activeBatch.openingBalanceMinor }),
        ...(activeBatch.closingBalanceMinor === undefined
          ? {}
          : { closingBalanceMinor: activeBatch.closingBalanceMinor }),
      })
    : undefined;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Import bank or FASTag statement
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Upload CSV, Excel, PDF, or saved .eml files. Verify running balances before posting or sending to Inbox.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowPaste((v) => !v)}
            className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            {showPaste ? 'Hide paste box' : 'Or paste raw statement text'}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              Bank / FASTag account
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {banks.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              Default contra ledger (for bulk post)
            </label>
            <select
              value={defaultLedgerId}
              onChange={(e) => setDefaultLedgerId(e.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {expenses.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              PDF password <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="If statement PDF is protected"
              className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
        </div>

        <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 py-8 text-center transition-colors hover:border-blue-500 hover:bg-blue-50/30 dark:border-slate-700 dark:bg-slate-950/60 dark:hover:border-blue-500">
          <Upload className="h-5 w-5 text-slate-400" />
          <span className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
            {busy ? 'Reading statement…' : 'Choose statement file to stage'}
          </span>
          <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Supports HDFC, ICICI, SBI, Axis, Kotak, FASTag CSV/XLSX/PDF, and .eml files up to 25 MB
          </span>
          <input
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls,.pdf,.eml,.txt,text/csv,application/pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              void pickFile(file);
            }}
          />
        </label>

        {showPaste ? (
          <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste CSV or bank statement text with dates and amounts…"
              className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void stagePasted()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              Stage pasted statement
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : null}
      </section>

      {/* Active Staged Batch Preview */}
      {activeBatch ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {activeBatch.fileName ?? 'Pasted statement'}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {activeBatch.adapterId ?? 'generic'} ·{' '}
                <span className="num-tabular">{activeBatch.totalLines}</span> lines ·{' '}
                {activeBatch.status}
              </p>
            </div>

            {balanceCheck && (balanceCheck.checked > 0 || balanceCheck.expectedClosingMinor !== undefined) ? (
              <div className="flex items-center gap-1.5 text-xs">
                {balanceCheck.mismatches.length === 0 ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-emerald-700 dark:text-emerald-400">
                      Running balance verified ({balanceCheck.checked} checks)
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-red-700 dark:text-red-400">
                    {balanceCheck.mismatches.length} balance mismatch
                    {balanceCheck.mismatches.length === 1 ? '' : 'es'} detected
                  </span>
                )}
              </div>
            ) : null}
          </div>

          {balanceCheck && balanceCheck.mismatches.length > 0 ? (
            <div className="border-b border-red-200 bg-red-50 px-6 py-4 text-xs dark:border-red-900/50 dark:bg-red-950/30">
              <p className="font-semibold text-red-800 dark:text-red-300">
                Balance check failed. Review the exact rows before posting.
              </p>
              <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
                {balanceCheck.mismatches.map((mismatch) => (
                  <li key={`${mismatch.kind}-${mismatch.lineNo}`}>
                    Row {mismatch.lineNo}
                    {mismatch.page ? ` · page ${mismatch.page}` : ''}
                    {` · ${mismatch.date} · ${mismatch.description}`}
                    {` · expected ${formatMinor(mismatch.expectedMinor)}`}
                    {` · actual ${formatMinor(mismatch.actualMinor)}`}
                    {` · difference ${formatMinor(mismatch.differenceMinor)}`}
                  </li>
                ))}
              </ul>
              {balanceCheck.expectedClosingMinor !== undefined && balanceCheck.closingMinor !== undefined ? (
                <p className="mt-2 text-red-700 dark:text-red-300">
                  Opening {balanceCheck.openingMinor !== undefined ? formatMinor(balanceCheck.openingMinor) : '—'} +
                  credits {formatMinor(balanceCheck.totalCreditsMinor)} − debits{' '}
                  {formatMinor(balanceCheck.totalDebitsMinor)} ={' '}
                  {formatMinor(balanceCheck.expectedClosingMinor)}; statement closing is{' '}
                  {formatMinor(balanceCheck.closingMinor)}.
                </p>
              ) : null}
              <label className="mt-3 flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
                <input
                  type="checkbox"
                  checked={acknowledgeMismatch}
                  onChange={(event) => setAcknowledgeMismatch(event.target.checked)}
                />
                I reviewed this mismatch and want to proceed anyway.
              </label>
            </div>
          ) : null}

          <div className="max-h-80 overflow-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Description</th>
                  <th className="px-4 py-2.5 text-right">Out</th>
                  <th className="px-4 py-2.5 text-right">In</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {rows.slice(0, 100).map((row) => (
                  <tr key={row.id}>
                    <td className="num-tabular whitespace-nowrap px-4 py-2.5 text-xs text-slate-600 dark:text-slate-400">
                      {row.date}
                    </td>
                    <td className="max-w-md truncate px-4 py-2.5 text-xs text-slate-900 dark:text-slate-100">
                      {row.description}
                      {row.reference ? (
                        <span className="ml-1.5 text-slate-400">· {row.reference}</span>
                      ) : null}
                    </td>
                    <td className="num-tabular whitespace-nowrap px-4 py-2.5 text-right text-xs text-slate-900 dark:text-slate-100">
                      {row.debitMinor ? formatMinor(row.debitMinor) : '—'}
                    </td>
                    <td className="num-tabular whitespace-nowrap px-4 py-2.5 text-right text-xs text-emerald-700 dark:text-emerald-400">
                      {row.creditMinor ? formatMinor(row.creditMinor) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">
                      {row.matchStatus}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-800">
            {confirmAction ? (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-red-700 dark:text-red-400">
                  {confirmAction === 'discard'
                    ? 'Discard this staged batch?'
                    : 'Undo this import and remove its posted vouchers?'}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmAction(null)}
                  className="text-slate-500 hover:underline"
                >
                  Keep
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void (confirmAction === 'discard'
                      ? discard(activeBatch.id)
                      : undo(activeBatch.id))
                  }
                  className="rounded bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700"
                >
                  Confirm
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                {activeBatch.status === 'staged' || activeBatch.status === 'reviewing' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy || (balanceCheck?.mismatches.length ?? 0) > 0 && !acknowledgeMismatch}
                      onClick={() => void sendToInbox()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
                    >
                      <Inbox className="h-3.5 w-3.5" />
                      Send {activeBatch.totalLines} to Money Inbox
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !accountId ||
                        !defaultLedgerId ||
                        ((balanceCheck?.mismatches.length ?? 0) > 0 && !acknowledgeMismatch)
                      }
                      onClick={() => void commit()}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      Bulk post directly
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmAction('discard')}
                      className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Discard
                    </button>
                  </>
                ) : null}

                {activeBatch.status === 'committed' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmAction('undo')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3.5 py-2 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:bg-slate-900 dark:text-red-400"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Undo import
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* Recent Batches List */}
      {batches.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Import history ({batches.length})
            </h3>
          </div>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {batches.slice(0, 15).map((batch) => (
              <li key={batch.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <button
                  type="button"
                  onClick={() => setActiveBatchId(batch.id)}
                  className="truncate text-left font-medium text-blue-700 hover:underline dark:text-blue-400"
                >
                  {batch.fileName ?? batch.adapterId ?? 'Imported statement'}
                </button>
                <span className="num-tabular shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {batch.status} · {batch.committedLines}/{batch.totalLines} posted
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
