import { useEffect, useMemo, useState } from 'react';
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
  const bank = useMemo(() => ledgers.find((ledger) => ledger.isBank && !ledger.archived), [ledgers]);
  const [queue, setQueue] = useState<StatementMatchQueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [splitFor, setSplitFor] = useState<string>();
  const [splitCandidates, setSplitCandidates] = useState<SplitCandidate[]>([]);
  const [selectedVouchers, setSelectedVouchers] = useState<string[]>([]);

  useEffect(() => {
    if (!bank) return;
    let cancelled = false;
    setError(undefined);
    void suggestMatches(getDb(), workspaceId, { accountId: bank.id })
      .then((items) => {
        if (!cancelled) setQueue(items);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken, bank]);

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
      setNotice(`Matched ${line.description} to ${candidate.voucher.number}`);
      onChanged('Statement matched');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startSplit(line: StatementLine) {
    if (!bank) return;
    setBusy(true);
    setError(undefined);
    try {
      const candidates = await listSplitCandidates(getDb(), workspaceId, line.id, line.accountId ?? bank.id);
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
    setSelectedVouchers((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function confirmSplit(line: StatementLine) {
    const selected = splitCandidates.filter((candidate) =>
      selectedVouchers.includes(candidate.voucher.id),
    );
    setBusy(true);
    setError(undefined);
    try {
      await confirmStatementMatch(
        getDb(),
        workspaceId,
        line.id,
        selected.map((candidate) => ({
          voucherId: candidate.voucher.id,
          amountMinor: candidate.bankAmountMinor,
        })),
      );
      setNotice(`Matched ${line.description} across ${selected.length} vouchers`);
      setSplitFor(undefined);
      setSplitCandidates([]);
      setSelectedVouchers([]);
      onChanged('Statement split matched');
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
      setNotice('Statement line ignored');
      onChanged('Statement line ignored');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const suggested = queue.filter((item) => item.line.matchStatus === 'suggested').length;

  return (
    <section className="card">
      <div className="section-head">
        <h2>Reconcile</h2>
        <span className="muted small">
          {queue.length} open · {suggested} suggested · {bank?.name ?? 'no bank ledger'}
        </span>
      </div>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}

      {queue.length === 0 ? (
        <p className="muted">Everything imported is matched. Post or import more transactions.</p>
      ) : (
        <div className="stack">
          {queue.slice(0, 50).map(({ line, candidates }) => {
            const amount = lineAmount(line);
            const splitSelection = splitCandidates.filter((candidate) =>
              selectedVouchers.includes(candidate.voucher.id),
            );
            const splitTotal = splitSelection.reduce(
              (sum, candidate) => sum + candidate.bankAmountMinor,
              0,
            );
            return (
              <div key={line.id} className="reconcile-item">
                <div className="reconcile-head">
                  <div>
                    <strong>{line.description}</strong>
                    <div className="muted small">
                      {line.date}
                      {line.reference ? ` · ${line.reference}` : ''} · {line.matchStatus}
                      {line.matchConfidence !== undefined
                        ? ` · ${Math.round(line.matchConfidence * 100)}%`
                        : ''}
                    </div>
                  </div>
                  <div className={amount >= 0 ? 'num positive' : 'num negative'}>
                    {amount >= 0 ? '+' : ''}
                    {formatMinor(amount)}
                  </div>
                </div>

                {candidates.length > 0 ? (
                  <div className="candidate-list">
                    {candidates.map((candidate) => (
                      <div key={candidate.voucher.id} className="candidate">
                        <span>
                          {candidate.voucher.voucherType} {candidate.voucher.number} ·{' '}
                          {candidate.voucher.date}
                        </span>
                        <span className="muted small">
                          {Math.round(candidate.confidence * 100)}% · {candidate.reasons.join(', ')}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => void match(line, candidate)}
                        >
                          Match
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted small">No exact voucher match found.</p>
                )}

                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !bank}
                    onClick={() =>
                      splitFor === line.id ? setSplitFor(undefined) : void startSplit(line)
                    }
                  >
                    {splitFor === line.id ? 'Close split' : 'Split / manual'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void ignore(line)}
                  >
                    Ignore
                  </button>
                </div>

                {splitFor === line.id ? (
                  <div className="split-box">
                    <p className="muted small">
                      Select vouchers whose bank amounts add up to this line.
                      {' '}Selected {formatMinor(splitTotal)} of {formatMinor(amount)}.
                    </p>
                    {splitCandidates.length === 0 ? (
                      <p className="muted small">No candidate vouchers in the date window.</p>
                    ) : (
                      splitCandidates.map((candidate) => (
                        <label key={candidate.voucher.id} className="split-row">
                          <input
                            type="checkbox"
                            checked={selectedVouchers.includes(candidate.voucher.id)}
                            onChange={() => toggleVoucher(candidate.voucher.id)}
                          />
                          <span>
                            {candidate.voucher.voucherType} {candidate.voucher.number}
                          </span>
                          <span className="muted small">{candidate.voucher.date}</span>
                          <span className="num">{formatMinor(candidate.bankAmountMinor)}</span>
                        </label>
                      ))
                    )}
                    <button
                      type="button"
                      disabled={busy || splitTotal !== amount || selectedVouchers.length === 0}
                      onClick={() => void confirmSplit(line)}
                    >
                      Confirm split match
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
