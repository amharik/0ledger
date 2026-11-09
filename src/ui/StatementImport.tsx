import { useEffect, useMemo, useState } from 'react';
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
import { parseAlertText } from '@/core/ingest/email';
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
  const banks = useMemo(() => ledgers.filter((ledger) => ledger.isBank && !ledger.archived), [ledgers]);
  const expenses = useMemo(
    () =>
      ledgers
        .filter((ledger) => !ledger.archived && !ledger.isBank && !ledger.isTax && !ledger.isSystem)
        .sort((a, b) => (a.name === 'Purchases' ? -1 : b.name === 'Purchases' ? 1 : a.name.localeCompare(b.name))),
    [ledgers],
  );
  const [accountId, setAccountId] = useState('');
  const [defaultLedgerId, setDefaultLedgerId] = useState('');
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [results, setResults] = useState<StageImportResult[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string>();
  const [rows, setRows] = useState<StatementLine[]>([]);

  const activeBatch = batches.find((batch) => batch.id === activeBatchId);

  useEffect(() => {
    if (!accountId && banks[0]) setAccountId(banks[0].id);
    if (accountId && !banks.some((ledger) => ledger.id === accountId)) setAccountId(banks[0]?.id ?? '');
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
    setNotice(
      `Staged ${total} line${total === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} duplicate skipped` : ''}`,
    );
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    if (file.size > MAX_INGEST_BYTES) {
      setError('File is too large (max 25 MB).');
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
      onChanged(`Staged ${file.name}`);
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
    setNotice(undefined);
    try {
      const statement = parseTextStatement(text, { fileName: 'pasted.txt' });
      const staged = await stageImport(getDb(), {
        workspaceId,
        source: 'manual',
        statement,
        fileName: 'pasted.txt',
        ...(accountId ? { accountId } : {}),
      });
      accept([staged]);
      setText('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function capturePage() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tab = tabs[0];
      if (!tab?.id) throw new Error('No active tab found');
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          title: document.title,
          url: location.href,
          text: document.body?.innerText ?? '',
        }),
      });
      const page = results[0]?.result;
      if (!page) throw new Error('Could not read the active page');
      const snippet = page.text.slice(0, 200_000);
      const statement =
        parseAlertText({ text: snippet, subject: page.title, from: page.url }) ??
        parseTextStatement(snippet, { fileName: page.url });
      if (statement.rows.length === 0) {
        throw new Error('No bank alert or statement lines found on this page');
      }
      const staged = await stageImport(getDb(), {
        workspaceId,
        source: statement.kind === 'fastag' ? 'fastag' : 'email',
        statement,
        fileName: page.title.slice(0, 120) || 'webmail-capture',
        ...(accountId ? { accountId } : {}),
      });
      accept([staged]);
      onChanged('Captured page statement');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!activeBatchId || !accountId || !defaultLedgerId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await commitImportBatch(getDb(), workspaceId, activeBatchId, {
        accountId,
        defaultLedgerId,
        actor: 'sidepanel',
      });
      setNotice(`Posted ${result.committed} voucher${result.committed === 1 ? '' : 's'}${result.failed ? ` · ${result.failed} failed` : ''}`);
      if (result.errors.length) setError(result.errors.join('\n'));
      onChanged('Statement imported');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function discard(batchId: string) {
    if (!window.confirm('Discard this staged import?')) return;
    setBusy(true);
    setError(undefined);
    try {
      await discardImportBatch(getDb(), workspaceId, batchId);
      if (activeBatchId === batchId) setActiveBatchId(undefined);
      setNotice('Import discarded');
      onChanged('Import discarded');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function undo(batchId: string) {
    if (!window.confirm('Undo this import and delete its posted vouchers?')) return;
    setBusy(true);
    setError(undefined);
    try {
      const count = await undoImportBatch(getDb(), workspaceId, batchId);
      setNotice(`Undid ${count} voucher${count === 1 ? '' : 's'}`);
      onChanged('Import undone');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>Import statement</h2>
        <span className="muted small">CSV, XLSX, PDF, EML, FASTag text</span>
      </div>

      <div className="form-grid compact-grid">
        <label>
          Bank / FASTag ledger
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {banks.map((ledger) => (
              <option key={ledger.id} value={ledger.id}>
                {ledger.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default contra ledger
          <select
            value={defaultLedgerId}
            onChange={(event) => setDefaultLedgerId(event.target.value)}
          >
            {expenses.map((ledger) => (
              <option key={ledger.id} value={ledger.id}>
                {ledger.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          PDF password
          <input
            type="password"
            value={password}
            placeholder="optional"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>

      <label className="file-drop">
        <span>{busy ? 'Working…' : 'Choose statement file'}</span>
        <input
          type="file"
          accept=".csv,.xlsx,.xls,.pdf,.eml,.txt,text/csv,application/pdf"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void pickFile(file);
          }}
        />
      </label>

      <div className="capture-row">
        <button type="button" className="secondary" disabled={busy} onClick={() => void capturePage()}>
          Capture bank email tab
        </button>
        <span className="muted small">Open the bank email or statement page in the active tab.</span>
      </div>

      <details>
        <summary className="muted small">Or paste statement text</summary>
        <textarea
          rows={5}
          value={text}
          placeholder="Paste bank/FASTag text with dates and amounts…"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="button" className="secondary" disabled={busy || !text.trim()} onClick={() => void stagePasted()}>
          Stage pasted text
        </button>
      </details>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}

      {results.length > 1 ? (
        <div className="tabs">
          {results.map((result) => (
            <button
              type="button"
              key={result.batch.id}
              className={activeBatchId === result.batch.id ? 'tab active' : 'tab'}
              onClick={() => setActiveBatchId(result.batch.id)}
            >
              {result.batch.adapterId} ({result.batch.totalLines})
            </button>
          ))}
        </div>
      ) : null}

      {activeBatch ? (
        <div className="stack">
          <div>
            <strong>{activeBatch.fileName ?? 'Pasted statement'}</strong>
            <span className="muted small">
              {' '}
              · {activeBatch.adapterId ?? 'generic'} · {activeBatch.totalLines} lines ·{' '}
              {activeBatch.status}
            </span>
          </div>
          {(() => {
            const balance = verifyStatementBalance(rows);
            if (balance.checked === 0) return null;
            return balance.mismatches.length === 0 ? (
              <p className="muted small">✓ Balances reconcile across {balance.checked} line{balance.checked === 1 ? '' : 's'}.</p>
            ) : (
              <p className="negative small">
                {balance.mismatches.length} balance mismatch{balance.mismatches.length === 1 ? '' : 'es'} detected.
              </p>
            );
          })()}
          <div className="table-scroll import-preview">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Out</th>
                  <th className="num">In</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((row) => (
                  <tr key={row.id}>
                    <td>{row.date}</td>
                    <td>
                      {row.description}
                      {row.reference ? <span className="muted small"> · {row.reference}</span> : null}
                    </td>
                    <td className="num">{row.debitMinor ? formatMinor(row.debitMinor) : '—'}</td>
                    <td className="num">{row.creditMinor ? formatMinor(row.creditMinor) : '—'}</td>
                    <td className="muted small">{row.matchStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            {activeBatch.status === 'staged' || activeBatch.status === 'reviewing' ? (
              <>
                <button
                  type="button"
                  disabled={busy || !accountId || !defaultLedgerId}
                  onClick={() => void commit()}
                >
                  Post {activeBatch.totalLines} line{activeBatch.totalLines === 1 ? '' : 's'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void discard(activeBatch.id)}
                >
                  Discard
                </button>
              </>
            ) : null}
            {activeBatch.status === 'committed' ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void undo(activeBatch.id)}>
                Undo import
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {batches.length > 0 ? (
        <details>
          <summary className="muted small">Recent imports ({batches.length})</summary>
          <ul className="plain-list">
            {batches.slice(0, 20).map((batch) => (
              <li key={batch.id}>
                <button type="button" className="link-button" onClick={() => setActiveBatchId(batch.id)}>
                  {batch.fileName ?? batch.adapterId ?? 'Import'}
                </button>
                <span className="muted small">
                  {' '}
                  · {batch.status} · {batch.committedLines}/{batch.totalLines}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
