import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  askCaForItem,
  buildCloseCockpit,
  generateCaPack,
  listCaPacks,
  updateCloseItem,
  type CaPackFileContent,
  type CloseCockpitData,
} from '@/core/autopilot';
import { formatMinor } from '@/core/money/money';
import type { CaPack, CloseItem } from '@/core/model';

interface Props {
  workspaceId: string;
  refreshToken: number;
  onChanged: (message: string) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function downloadFile(file: CaPackFileContent, period: string): void {
  const blob = new Blob([file.content], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `0ledger-${period}-${file.name}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function statusLabel(item: CloseItem): string {
  return item.status.replace('_', ' ');
}

export function CloseCockpit({ workspaceId, refreshToken, onChanged }: Props) {
  const [period, setPeriod] = useState(currentPeriod());
  const [cockpit, setCockpit] = useState<CloseCockpitData>();
  const [packs, setPacks] = useState<CaPack[]>([]);
  const [files, setFiles] = useState<CaPackFileContent[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    setFiles([]);
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void Promise.all([buildCloseCockpit(getDb(), workspaceId, period), listCaPacks(getDb(), workspaceId, period)])
      .then(([next, nextPacks]) => {
        if (cancelled) return;
        setCockpit(next);
        setPacks(nextPacks);
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
  }, [workspaceId, period, refreshToken]);

  async function mutate(item: CloseItem, action: 'ask' | 'resolve' | 'waive') {
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'ask') await askCaForItem(getDb(), workspaceId, item.id);
      else if (action === 'resolve') {
        await updateCloseItem(getDb(), workspaceId, item.id, { status: 'resolved' });
      } else {
        await updateCloseItem(getDb(), workspaceId, item.id, { status: 'waived' });
      }
      setNotice(action === 'ask' ? 'Question queued for CA pack' : action === 'resolve' ? 'Item resolved' : 'Item waived');
      onChanged('Close item updated');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await generateCaPack(getDb(), workspaceId, period);
      setFiles(result.files);
      setPacks((current) => [result.pack, ...current]);
      setNotice(`CA pack generated · readiness ${result.pack.readiness}/100`);
      onChanged('CA pack generated');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const readiness = cockpit?.readiness;
  const open = cockpit?.openItems ?? [];

  return (
    <section className="card">
      <div className="section-head">
        <h2>Close Cockpit</h2>
        <label className="inline-field">
          <span className="muted small">Month</span>
          <input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </label>
      </div>
      <p className="muted small">
        Review what is stopping a clean close, hand questions to your CA, then export one pack.
      </p>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}
      {loading ? <p className="muted">Checking close readiness…</p> : null}

      {cockpit && readiness ? (
        <>
          <div className="close-summary">
            <div className={`readiness readiness-${readiness.status}`}>
              <span className="muted small">Readiness</span>
              <strong>{readiness.score}/100</strong>
              <span>{readiness.status.replace('_', ' ')}</span>
            </div>
            <div className="close-kpis">
              <div>
                <span className="muted small">Bank lines</span>
                <strong>
                  {cockpit.cash.reconciledLines}/{cockpit.cash.totalLines} reconciled
                </strong>
              </div>
              <div>
                <span className="muted small">Statement net</span>
                <strong>{formatMinor(cockpit.cash.statementNetMinor)}</strong>
              </div>
              <div>
                <span className="muted small">Ledger net</span>
                <strong>{formatMinor(cockpit.cash.ledgerNetMinor)}</strong>
              </div>
              <div>
                <span className="muted small">Difference</span>
                <strong className={cockpit.cash.differenceMinor === 0 ? 'positive' : 'negative'}>
                  {formatMinor(cockpit.cash.differenceMinor)}
                </strong>
              </div>
              <div>
                <span className="muted small">Captured GST/TDS</span>
                <strong>{formatMinor(cockpit.tax.totalMinor)}</strong>
              </div>
              <div>
                <span className="muted small">Open items</span>
                <strong>{open.length}</strong>
              </div>
            </div>
          </div>

          {readiness.blockers.length > 0 ? (
            <div className="alert danger">
              <strong>Must fix before close</strong>
              <ul className="plain-list">
                {readiness.blockers.slice(0, 8).map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void generate()}>
              {busy ? 'Generating…' : 'Generate CA pack'}
            </button>
            <span className="muted small">
              Includes Tally XML, voucher lines, trial balance, party outstanding, tax and open
              items.
            </span>
          </div>

          {files.length > 0 ? (
            <div className="pack-files">
              <strong>Pack files</strong>
              <div className="pack-file-grid">
                {files.map((file) => (
                  <button
                    type="button"
                    className="ghost small-button"
                    key={file.name}
                    onClick={() => downloadFile(file, period)}
                  >
                    {file.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {cockpit.tax.entries.length > 0 ? (
            <details>
              <summary className="muted small">Captured tax summary ({cockpit.tax.entries.length})</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Ledger</th>
                      <th className="num">Amount</th>
                      <th className="num">Taxable value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cockpit.tax.entries.map((entry) => (
                      <tr key={`${entry.taxType}:${entry.ledgerName}`}>
                        <td>{entry.taxType}</td>
                        <td>{entry.ledgerName}</td>
                        <td className="num">{formatMinor(entry.amountMinor)}</td>
                        <td className="num">{formatMinor(entry.taxableValueMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}

          <div className="section-head">
            <h3>Close items</h3>
            <span className="muted small">{cockpit.items.length} total</span>
          </div>
          {open.length === 0 ? (
            <p className="muted">No open close items for this month.</p>
          ) : (
            <ul className="close-items">
              {open.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <div className="muted small">
                      {item.type.replace('_', ' ')} · owner {item.owner}
                      {item.amountMinor === undefined ? '' : ` · ${formatMinor(item.amountMinor)}`}
                      {item.status !== 'open' ? ` · ${statusLabel(item)}` : ''}
                    </div>
                    {item.evidence ? <div className="muted small">{item.evidence}</div> : null}
                    {item.note ? <div className="muted small">Note: {item.note}</div> : null}
                  </div>
                  <div className="row-actions">
                    {item.status !== 'asked_ca' ? (
                      <button
                        type="button"
                        className="ghost small-button"
                        disabled={busy}
                        onClick={() => void mutate(item, 'ask')}
                      >
                        Ask CA
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost small-button"
                      disabled={busy}
                      onClick={() => void mutate(item, 'resolve')}
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      className="ghost small-button"
                      disabled={busy}
                      onClick={() => void mutate(item, 'waive')}
                    >
                      Waive
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {packs.length > 0 ? (
            <details>
              <summary className="muted small">Generated packs ({packs.length})</summary>
              <ul className="plain-list">
                {packs.map((pack) => (
                  <li key={pack.id}>
                    <span>
                      {new Date(pack.generatedAt).toLocaleString()} · {pack.readiness}/100 ·{' '}
                      {pack.readinessStatus.replace('_', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
