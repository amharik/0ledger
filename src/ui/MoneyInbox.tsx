import { useEffect, useMemo, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  approveMoneyEvent,
  autoPostEligibleEvents,
  ignoreMoneyEvent,
  listExceptionQueue,
  listMoneyEvents,
  reverseMoneyEvent,
  captureStatementLines,
  type MoneyEventQueueItem,
} from '@/core/autopilot';
import { ingestFile, stageImport } from '@/core/ingest';
import { parseTextStatement } from '@/core/ingest/parsers';
import { parseAlertText } from '@/core/ingest/email';
import { MAX_INGEST_BYTES } from '@/core/ingest/limits';
import { formatMinor } from '@/core/money/money';
import type { Ledger, MoneyEvent } from '@/core/model';

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  refreshToken: number;
  onChanged: (message: string) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sourceLabel(event: MoneyEvent): string {
  return `${event.source}${event.sourceRef ? ` · ${event.sourceRef}` : ''}`;
}

export function MoneyInbox({ workspaceId, ledgers, refreshToken, onChanged }: Props) {
  const banks = useMemo(() => ledgers.filter((ledger) => ledger.isBank && !ledger.archived), [ledgers]);
  const categories = useMemo(
    () =>
      ledgers
        .filter((ledger) => !ledger.isBank && !ledger.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers],
  );
  const [items, setItems] = useState<MoneyEventQueueItem[]>([]);
  const [posted, setPosted] = useState<MoneyEvent[]>([]);
  const [ledgerByEvent, setLedgerByEvent] = useState<Record<string, string>>({});
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(true);

  // Quick Ingest states
  const [showIngest, setShowIngest] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pdfPassword, setPdfPassword] = useState('');

  useEffect(() => {
    if (!bankLedgerId && banks[0]) setBankLedgerId(banks[0].id);
    if (bankLedgerId && !banks.some((ledger) => ledger.id === bankLedgerId)) {
      setBankLedgerId(banks[0]?.id ?? '');
    }
  }, [bankLedgerId, banks]);

  const loadEvents = () => {
    setLoading(true);
    void Promise.all([
      listExceptionQueue(getDb(), workspaceId),
      listMoneyEvents(getDb(), workspaceId, { limit: 300 }),
    ])
      .then(([queue, events]) => {
        setItems(queue);
        setPosted(events.filter((event) => event.status === 'posted').slice(0, 12));
        setLedgerByEvent((current) => {
          const next = { ...current };
          for (const item of queue) {
            if (!next[item.event.id]) next[item.event.id] = item.suggestion?.ledgerId ?? '';
          }
          return next;
        });
      })
      .catch((cause) => {
        setError(errorMessage(cause));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    loadEvents();
  }, [workspaceId, refreshToken]);

  async function post(item: MoneyEventQueueItem) {
    const ledgerId = ledgerByEvent[item.event.id];
    if (!ledgerId) {
      setError('Choose a category for this event first.');
      return;
    }
    if (!bankLedgerId) {
      setError('Choose the bank ledger for this event first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await approveMoneyEvent(getDb(), workspaceId, item.event.id, { ledgerId, bankLedgerId });
      setNotice(`Posted ${item.event.direction === 'out' ? 'payment' : 'receipt'} for ${formatMinor(item.event.amountMinor)}`);
      onChanged('Event posted');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function ignore(item: MoneyEventQueueItem) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await ignoreMoneyEvent(getDb(), workspaceId, item.event.id);
      setNotice('Event ignored');
      onChanged('Event ignored');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reverse(event: MoneyEvent) {
    if (!window.confirm('Reverse this posted voucher and return the event to the inbox?')) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await reverseMoneyEvent(getDb(), workspaceId, event.id);
      setNotice('Reversed voucher');
      onChanged('Event reversed');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runAutoPost() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await autoPostEligibleEvents(getDb(), workspaceId);
      setNotice(
        result.posted === 0
          ? 'No events met the auto-post rules. Check Settings → Autopilot rules.'
          : `Auto-posted ${result.posted} event${result.posted === 1 ? '' : 's'}`,
      );
      onChanged('Auto-post checked');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  // Handle direct file upload (EML email, PDF, CSV, XLSX, PNG/JPG scan)
  async function handleFileUpload(file: File) {
    if (file.size > MAX_INGEST_BYTES) {
      setError('File is too large (max 25 MB).');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const db = getDb();
      const bytes = await file.arrayBuffer();
      const stagedList = await ingestFile(
        db,
        workspaceId,
        {
          fileName: file.name,
          mimeType: file.type,
          bytes,
          ...(pdfPassword ? { password: pdfPassword } : {}),
        },
        { ...(bankLedgerId ? { accountId: bankLedgerId } : {}) },
      );
      let capturedCount = 0;
      for (const staged of stagedList) {
        const res = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
        capturedCount += res.created.length;
      }
      setNotice(`Extracted ${capturedCount} transaction${capturedCount === 1 ? '' : 's'} from ${file.name} into Money Inbox!`);
      setPdfPassword('');
      setShowIngest(false);
      onChanged('File ingested into inbox');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  // Handle direct paste of bank alert email or SMS
  async function handlePasteAlert() {
    const text = pasteText.trim();
    if (!text) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const db = getDb();
      const statement =
        parseAlertText({ text, subject: 'Email Alert', from: 'alerts@bank.in' }) ??
        parseTextStatement(text, { fileName: 'pasted-email.txt' });

      if (statement.rows.length === 0) {
        throw new Error('No transaction details or amounts could be recognized from the pasted text.');
      }
      const staged = await stageImport(db, {
        workspaceId,
        source: statement.kind === 'fastag' ? 'fastag' : 'email',
        statement,
        fileName: 'pasted-email.txt',
        ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
      });
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
      setNotice(`Extracted ${captured.created.length} event${captured.created.length === 1 ? '' : 's'} from pasted text into Money Inbox!`);
      setPasteText('');
      setShowIngest(false);
      onChanged('Pasted alert ingested into inbox');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  // Load sample bank & email alerts
  async function loadSampleAlerts() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const db = getDb();
      const sampleText = `Date,Description,Debit,Credit,Balance
2026-11-21,NEFT Cr from Infosys Client Services Inv 104,,85000.00,185000.00
2026-11-20,UPI/P2M/Swiggy Bangalore Office Pantry,1450.00,,183550.00
2026-11-19,IMPS Dr to Apex Software Solutions - Vendor Payment,32000.00,,151550.00
2026-11-18,NETBANKING Dr AWS Cloud Hosting Services,8900.00,,142650.00
2026-11-17,FASTag Toll Plaza Electronic City Bangalore,350.00,,142300.00`;

      const statement = parseTextStatement(sampleText, { fileName: 'sample-email-statement.csv' });
      const staged = await stageImport(db, {
        workspaceId,
        source: 'email',
        statement,
        fileName: 'sample-email-statement.csv',
        ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
      });
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
      setNotice(`Loaded ${captured.created.length} sample bank & email events into Money Inbox!`);
      onChanged('Sample events loaded');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const highRisk = items.filter((item) => item.risk.band === 'high').length;

  return (
    <section className="card">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Money Inbox</h2>
          <p className="muted small" style={{ margin: '0.25rem 0 0 0' }}>
            Extracted bank and email events wait here for Autopilot matching and one-click posting.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="secondary small-button"
            onClick={() => setShowIngest((v) => !v)}
          >
            {showIngest ? 'Close Ingest Panel' : '📥 Extract from Email / Statement'}
          </button>
          <span className={`badge ${highRisk ? 'danger-badge' : ''}`}>
            {items.length} to review{highRisk ? ` · ${highRisk} high risk` : ''}
          </span>
        </div>
      </div>

      {showIngest ? (
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--accent)',
            borderRadius: '8px',
            padding: '1.25rem',
            margin: '1rem 0',
          }}
        >
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>
            📥 Extract Transactions into Money Inbox
          </h3>
          <p className="muted small" style={{ margin: '0 0 1rem 0' }}>
            Upload raw email (.eml), statement PDF/CSV/Excel, or paste email notification text. All extraction happens locally.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            {/* File Upload Box */}
            <div style={{ borderRight: '1px solid var(--border)', paddingRight: '1.5rem' }}>
              <strong>Option 1: Drop or Pick Statement / Email File</strong>
              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <input
                  type="file"
                  accept=".eml,.msg,.pdf,.csv,.xlsx,.xls,.txt,.png,.jpg,.jpeg"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFileUpload(f);
                  }}
                />
                <input
                  type="password"
                  placeholder="PDF password (if protected statement)"
                  value={pdfPassword}
                  onChange={(e) => setPdfPassword(e.target.value)}
                  style={{ padding: '0.4rem', fontSize: '0.85rem' }}
                />
                <span className="muted small">Supports .eml (saved from Gmail/Outlook), PDF, CSV, Excel, and scanned bills</span>
              </div>
            </div>

            {/* Paste Box */}
            <div>
              <strong>Option 2: Paste Bank Alert Email / SMS</strong>
              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <textarea
                  rows={3}
                  placeholder="Paste alert email or SMS (e.g. 'INR 4,500.00 debited from A/C XX1234 on 21-Nov-26 for UPI/Zomato...')"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem' }}
                />
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={busy || !pasteText.trim()}
                  onClick={() => void handlePasteAlert()}
                >
                  Extract & Add to Inbox
                </button>
              </div>
            </div>
          </div>

          <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem', textAlign: 'right' }}>
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => void loadSampleAlerts()}
            >
              ✨ Load Sample Indian Bank & Email Alerts
            </button>
          </div>
        </div>
      ) : null}

      <div className="form-grid compact-grid" style={{ marginTop: '1rem' }}>
        <label>
          Post to bank ledger
          <select value={bankLedgerId} onChange={(event) => setBankLedgerId(event.target.value)}>
            {banks.map((ledger) => (
              <option key={ledger.id} value={ledger.id}>
                {ledger.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Auto-post
          <button type="button" className="secondary" disabled={busy || items.length === 0} onClick={() => void runAutoPost()}>
            Post eligible now
          </button>
        </label>
      </div>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}
      {loading ? <p className="muted">Loading events…</p> : null}

      {!loading && items.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '2.5rem 1.5rem',
            background: 'var(--panel)',
            border: '1px dashed var(--border)',
            borderRadius: '8px',
            margin: '1.5rem 0',
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📬</div>
          <h3 style={{ margin: '0 0 0.5rem 0' }}>Your Money Inbox is Clear!</h3>
          <p className="muted" style={{ maxWidth: '480px', margin: '0 auto 1.25rem auto' }}>
            Extract transactions from bank statements or notification emails to let Autopilot match rules and post vouchers.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={() => setShowIngest(true)}
            >
              📥 Extract from Email / Statement
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void loadSampleAlerts()}
            >
              ✨ Load Sample Bank Events
            </button>
          </div>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="inbox-list" style={{ marginTop: '1.25rem' }}>
          {items.map((item) => {
            const confidence = Math.round((item.suggestion?.confidence ?? item.event.confidence) * 100);
            return (
              <li key={item.event.id} className={`inbox-item risk-${item.risk.band}`}>
                <div className="inbox-main">
                  <div>
                    <strong>
                      {item.event.direction === 'out' ? 'Out' : 'In'} · {formatMinor(item.event.amountMinor)}
                    </strong>
                    <span className="muted small"> · {item.event.date}</span>
                  </div>
                  <div>{item.event.narration}</div>
                  <div className="muted small">{sourceLabel(item.event)}</div>
                  <div className={`risk-line risk-text-${item.risk.band}`}>
                    {item.risk.band.toUpperCase()} risk · {item.risk.reasons.join(' · ')}
                    {item.suggestion?.taxHint ? ` · ${item.suggestion.taxHint} review` : ''}
                  </div>
                </div>
                <div className="inbox-actions">
                  <select
                    aria-label={`Category for ${item.event.narration}`}
                    value={ledgerByEvent[item.event.id] ?? ''}
                    onChange={(event) =>
                      setLedgerByEvent((current) => ({
                        ...current,
                        [item.event.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose category…</option>
                    {categories.map((ledger) => (
                      <option key={ledger.id} value={ledger.id}>
                        {ledger.name}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">
                    {confidence > 0 ? `${confidence}% match` : 'No rule match'}
                  </span>
                  <div className="row-actions">
                    <button type="button" disabled={busy || !bankLedgerId} onClick={() => void post(item)}>
                      Post
                    </button>
                    <button type="button" className="ghost" disabled={busy} onClick={() => void ignore(item)}>
                      Ignore
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {posted.length > 0 ? (
        <details style={{ marginTop: '1.5rem' }}>
          <summary className="muted small">Recently posted ({posted.length})</summary>
          <ul className="plain-list">
            {posted.map((event) => (
              <li key={event.id}>
                <span>
                  {event.date} · {formatMinor(event.amountMinor)} · {event.narration.slice(0, 80)}
                </span>
                <button
                  type="button"
                  className="ghost small-button"
                  disabled={busy}
                  onClick={() => void reverse(event)}
                >
                  Reverse
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
