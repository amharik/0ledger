import { useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Split } from 'lucide-react';
import { getDb } from '@/core/db/db';
import type { Ledger, StatementLine } from '@/core/model';
import {
  confirmStatementMatch,
  ignoreStatementLine,
  listSplitCandidates,
  suggestMatches,
  type MatchCandidate,
  type SplitCandidate,
  type StatementMatchQueueItem,
} from '@/core/ledger/reconciliation';
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

export function ReconciliationPanel({ workspaceId, ledgers, refreshToken, onChanged }: Props) {
  const banks = useMemo(
    () => ledgers.filter((ledger) => ledger.isBank && !ledger.archived),
    [ledgers],
  );
  const [bankId, setBankId] = useState('');
  const [queue, setQueue] = useState<StatementMatchQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [splitFor, setSplitFor] = useState<string>();
  const [splitCandidates, setSplitCandidates] = useState<SplitCandidate[]>([]);
  const [selectedVouchers, setSelectedVouchers] = useState<string[]>([]);

  useEffect(() => {
    if (!bankId && banks[0]) setBankId(banks[0].id);
    if (bankId && !banks.some((b) => b.id === bankId)) setBankId(banks[0]?.id ?? '');
  }, [bankId, banks]);

  useEffect(() => {
    if (!bankId) {
      setQueue([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void suggestMatches(getDb(), workspaceId, { accountId: bankId })
      .then((items) => {
        if (!cancelled) setQueue(items);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken, bankId]);

  function lineAmount(line: StatementLine): number {
    return line.creditMinor - line.debitMinor;
  }

  async function match(line: StatementLine, candidate: MatchCandidate) {
    setBusy(true);
    setError(undefined);
    try {
      await confirmStatementMatch(getDb(), workspaceId, line.id, [
        {
          voucherId: candidate.voucher.id,
          amountMinor: lineAmount(line),
          method: candidate.method,
          confidence: candidate.confidence,
        },
      ]);
      onChanged(`Matched statement line to ${candidate.voucher.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startSplit(line: StatementLine) {
    if (!bankId) return;
    setBusy(true);
    setError(undefined);
    try {
      const candidates = await listSplitCandidates(
        getDb(),
        workspaceId,
        line.id,
        line.accountId ?? bankId,
      );
      setSplitFor(line.id);
      setSplitCandidates(candidates);
      setSelectedVouchers([]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleVoucher(id: string) {
    setSelectedVouchers((cur) => (cur.includes(id) ? cur.filter((v) => v !== id) : [...cur, id]));
  }

  async function confirmSplit(line: StatementLine) {
    const selected = splitCandidates.filter((c) => selectedVouchers.includes(c.voucher.id));
    setBusy(true);
    setError(undefined);
    try {
      await confirmStatementMatch(
        getDb(),
        workspaceId,
        line.id,
        selected.map((c) => ({
          voucherId: c.voucher.id,
          amountMinor: c.bankAmountMinor,
        })),
      );
      setSplitFor(undefined);
      setSplitCandidates([]);
      setSelectedVouchers([]);
      onChanged(`Split-matched across ${selected.length} vouchers`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function ignore(line: StatementLine) {
    setBusy(true);
    setError(undefined);
    try {
      await ignoreStatementLine(getDb(), workspaceId, line.id);
      onChanged('Statement line ignored');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const suggestedCount = queue.filter((i) => i.line.matchStatus === 'suggested').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400">
            <span>Bank ledger</span>
            <select
              value={bankId}
              onChange={(e) => setBankId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-normal text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {banks.length === 0 ? <option value="">No bank ledger</option> : null}
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            <span className="num-tabular font-semibold text-slate-900 dark:text-slate-100">
              {queue.length}
            </span>{' '}
            open · <span className="num-tabular">{suggestedCount}</span> suggested
          </span>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? (
          <div className="space-y-3 p-6">
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : queue.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
              All bank lines reconciled
            </h3>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Every imported statement line for this bank account is matched with a voucher.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {queue.slice(0, 50).map(({ line, candidates }) => {
              const amount = lineAmount(line);
              const splitSelection = splitCandidates.filter((c) =>
                selectedVouchers.includes(c.voucher.id),
              );
              const splitTotal = splitSelection.reduce((sum, c) => sum + c.bankAmountMinor, 0);

              return (
                <li key={line.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {line.description}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        <span className="num-tabular">{line.date}</span>
                        {line.reference ? ` · ${line.reference}` : ''} · {line.matchStatus}
                        {line.matchConfidence !== undefined
                          ? ` · ${Math.round(line.matchConfidence * 100)}%`
                          : ''}
                      </div>
                    </div>

                    <div
                      className={`num-tabular text-sm font-semibold ${
                        amount >= 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {amount >= 0 ? '+' : ''}
                      {formatMinor(amount)}
                    </div>
                  </div>

                  {candidates.length > 0 ? (
                    <div className="space-y-1.5 rounded-lg bg-slate-50 p-3 dark:bg-slate-950/60">
                      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        Suggested voucher matches
                      </div>
                      {candidates.map((candidate) => (
                        <div
                          key={candidate.voucher.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-1 text-xs"
                        >
                          <div className="text-slate-800 dark:text-slate-200">
                            <span className="num-tabular font-semibold">
                              {candidate.voucher.voucherType} {candidate.voucher.number}
                            </span>
                            <span className="mx-1.5 text-slate-400">·</span>
                            <span className="num-tabular text-slate-500">
                              {candidate.voucher.date}
                            </span>
                            <span className="mx-1.5 text-slate-400">·</span>
                            <span className="text-slate-500">
                              {Math.round(candidate.confidence * 100)}% ({candidate.reasons.join(', ')})
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void match(line, candidate)}
                            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Confirm match
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      No exact voucher match found. Post the entry in Inbox or match manually via split.
                    </p>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={busy || !bankId}
                      onClick={() =>
                        splitFor === line.id ? setSplitFor(undefined) : void startSplit(line)
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                    >
                      <Split className="h-3.5 w-3.5" />
                      {splitFor === line.id ? 'Close manual match' : 'Manual / split match'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void ignore(line)}
                      className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      Ignore line
                    </button>
                  </div>

                  {splitFor === line.id ? (
                    <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                      <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                        <span>Select vouchers whose bank legs sum to this statement line</span>
                        <span className="num-tabular font-medium">
                          {formatMinor(splitTotal)} / {formatMinor(amount)}
                        </span>
                      </div>
                      {splitCandidates.length === 0 ? (
                        <p className="text-xs text-slate-500">No candidate vouchers in window.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {splitCandidates.map((c) => (
                            <label
                              key={c.voucher.id}
                              className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-xs hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                            >
                              <div className="flex items-center gap-2.5">
                                <input
                                  type="checkbox"
                                  checked={selectedVouchers.includes(c.voucher.id)}
                                  onChange={() => toggleVoucher(c.voucher.id)}
                                  className="h-4 w-4 rounded border-slate-300"
                                />
                                <span className="font-medium text-slate-800 dark:text-slate-200">
                                  {c.voucher.voucherType} {c.voucher.number}
                                </span>
                                <span className="num-tabular text-slate-500">{c.voucher.date}</span>
                              </div>
                              <span className="num-tabular font-medium text-slate-900 dark:text-slate-100">
                                {formatMinor(c.bankAmountMinor)}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={busy || splitTotal !== amount || selectedVouchers.length === 0}
                        onClick={() => void confirmSplit(line)}
                        className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40 dark:bg-blue-600 dark:hover:bg-blue-500"
                      >
                        Confirm split match
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
