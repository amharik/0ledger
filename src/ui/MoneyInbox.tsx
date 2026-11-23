import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  FileUp,
  Mail,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  approveMoneyEvent,
  autoPostEligibleEvents,
  captureStatementLines,
  ignoreMoneyEvent,
  listExceptionQueue,
  listMoneyEvents,
  reverseMoneyEvent,
  type MoneyEventQueueItem,
} from '@/core/autopilot';
import { ingestFile, stageImport } from '@/core/ingest';
import { parseTextStatement } from '@/core/ingest/parsers';
import { parseAlertText } from '@/core/ingest/email';
import { MAX_INGEST_BYTES } from '@/core/ingest/limits';
import { formatMinor } from '@/core/money/money';
import type { Ledger, MoneyEvent } from '@/core/model';
import { SourceEmailPreview } from './SourceEmailPreview';

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  refreshToken: number;
  onChanged: (message: string) => void;
}

type RiskFilter = 'all' | 'high' | 'medium' | 'low';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatEmailTime(occurredAt?: string): string {
  if (!occurredAt) return '';
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return '';
  return ` ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function riskTextColor(band: 'low' | 'medium' | 'high'): string {
  if (band === 'high') return 'text-red-700 dark:text-red-400';
  if (band === 'medium') return 'text-amber-700 dark:text-amber-400';
  return 'text-emerald-700 dark:text-emerald-400';
}

export function MoneyInbox({ workspaceId, ledgers, refreshToken, onChanged }: Props) {
  const banks = useMemo(
    () => ledgers.filter((ledger) => ledger.isBank && !ledger.archived),
    [ledgers],
  );
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
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmReverseId, setConfirmReverseId] = useState<string>();
  const [previewEvent, setPreviewEvent] = useState<MoneyEvent>();

  // Ingest drawer/panel state
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
    setError(undefined);
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
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshToken]);

  async function post(item: MoneyEventQueueItem) {
    const ledgerId = ledgerByEvent[item.event.id];
    if (!ledgerId) {
      setError('Select a category ledger before posting.');
      return;
    }
    if (!bankLedgerId) {
      setError('Select a bank ledger first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await approveMoneyEvent(getDb(), workspaceId, item.event.id, { ledgerId, bankLedgerId });
      onChanged(
        `Posted ${item.event.direction === 'out' ? 'payment' : 'receipt'} for ${formatMinor(item.event.amountMinor)}`,
      );
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
    try {
      await ignoreMoneyEvent(getDb(), workspaceId, item.event.id);
      onChanged('Ignored inbox event');
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reverse(event: MoneyEvent) {
    setBusy(true);
    setError(undefined);
    try {
      await reverseMoneyEvent(getDb(), workspaceId, event.id);
      setConfirmReverseId(undefined);
      onChanged('Reversed voucher and returned event to inbox');
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
    try {
      const result = await autoPostEligibleEvents(getDb(), workspaceId);
      onChanged(
        result.posted === 0
          ? 'No events met auto-post criteria (configure under Books → Rules)'
          : `Auto-posted ${result.posted} event${result.posted === 1 ? '' : 's'}`,
      );
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleFileUpload(file: File) {
    if (file.size > MAX_INGEST_BYTES) {
      setError('File exceeds the 25 MB limit.');
      return;
    }
    setBusy(true);
    setError(undefined);
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
      setPdfPassword('');
      setShowIngest(false);
      onChanged(
        `Extracted ${capturedCount} event${capturedCount === 1 ? '' : 's'} from ${file.name}`,
      );
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handlePasteAlert() {
    const text = pasteText.trim();
    if (!text) return;
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const statement =
        parseAlertText({ text, subject: 'Email Alert', from: 'alerts@bank.in' }) ??
        parseTextStatement(text, { fileName: 'pasted-alert.txt' });
      if (statement.rows.length === 0) {
        throw new Error('Could not recognize a date and amount from the pasted text.');
      }
      const staged = await stageImport(db, {
        workspaceId,
        source: statement.kind === 'fastag' ? 'fastag' : 'email',
        statement,
        fileName: 'pasted-alert.txt',
        ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
      });
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
      setPasteText('');
      setShowIngest(false);
      onChanged(
        `Extracted ${captured.created.length} event${captured.created.length === 1 ? '' : 's'} into inbox`,
      );
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadSampleAlerts() {
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const monthPrefix = new Date().toISOString().slice(0, 7);
      const sampleText = `Date,Description,Debit,Credit,Balance
${monthPrefix}-21,NEFT Cr from Infosys Client Services Inv 104,,85000.00,185000.00
${monthPrefix}-20,UPI/P2M/Swiggy Bangalore Office Pantry,1450.00,,183550.00
${monthPrefix}-19,IMPS Dr to Apex Cloud Hosting Vendor,32000.00,,151550.00
${monthPrefix}-18,NETBANKING Dr AWS Cloud Hosting Services,8900.00,,142650.00
${monthPrefix}-17,FASTag Toll Plaza Electronic City Bangalore,350.00,,142300.00`;

      const statement = parseTextStatement(sampleText, { fileName: 'sample-bank-alerts.csv' });
      const staged = await stageImport(db, {
        workspaceId,
        source: 'email',
        statement,
        fileName: 'sample-bank-alerts.csv',
        ...(bankLedgerId ? { accountId: bankLedgerId } : {}),
      });
      const captured = await captureStatementLines(db, workspaceId, staged.batch, staged.lines);
      setShowIngest(false);
      onChanged(`Loaded ${captured.created.length} sample bank events`);
      loadEvents();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (riskFilter !== 'all' && item.risk.band !== riskFilter) return false;
      if (!q) return true;
      return (
        item.event.narration.toLowerCase().includes(q) ||
        item.event.date.includes(q) ||
        item.event.source.toLowerCase().includes(q)
      );
    });
  }, [items, riskFilter, search]);

  const highRiskCount = items.filter((i) => i.risk.band === 'high').length;

  return (
    <div className="space-y-5">
      {/* Action & context toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400">
            <span className="whitespace-nowrap">Bank account</span>
            <select
              value={bankLedgerId}
              onChange={(e) => setBankLedgerId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-normal text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <div className="text-xs text-slate-500 dark:text-slate-400">
            <span className="num-tabular font-semibold text-slate-900 dark:text-slate-100">
              {items.length}
            </span>{' '}
            to review
            {highRiskCount > 0 ? (
              <span className="text-red-700 dark:text-red-400">
                {' '}
                · <span className="num-tabular">{highRiskCount}</span> high risk
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || items.length === 0}
            onClick={() => void runAutoPost()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Auto-post eligible
          </button>
          <button
            type="button"
            onClick={() => setShowIngest((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            {showIngest ? <X className="h-3.5 w-3.5" /> : <FileUp className="h-3.5 w-3.5" />}
            <span>{showIngest ? 'Close import' : 'Extract from file / text'}</span>
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* Expandable Extract Panel */}
      {showIngest ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Extract transactions into Money Inbox
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Upload a bank statement (CSV, XLSX, PDF), saved email (.eml), or paste SMS/email alert text. Parsed locally.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadSampleAlerts()}
              className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap dark:text-blue-400"
            >
              Load sample alerts
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-4 py-6 text-center transition-colors hover:border-blue-500 hover:bg-blue-50/30 dark:border-slate-700 dark:bg-slate-950/60 dark:hover:border-blue-500">
                <Upload className="h-5 w-5 text-slate-400" />
                <span className="mt-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                  {busy ? 'Extracting…' : 'Choose statement or email file'}
                </span>
                <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  CSV, XLSX, PDF, EML, or scanned receipt
                </span>
                <input
                  type="file"
                  className="hidden"
                  accept=".eml,.msg,.pdf,.csv,.xlsx,.xls,.txt,.png,.jpg,.jpeg"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void handleFileUpload(file);
                  }}
                />
              </label>

              <input
                type="password"
                placeholder="PDF password (optional, for encrypted bank statements)"
                value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            <div className="flex flex-col space-y-3">
              <textarea
                rows={4}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste bank alert email, SMS, or CSV lines here…"
                className="flex-1 rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy || !pasteText.trim()}
                  onClick={() => void handlePasteAlert()}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  Extract pasted text
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* Filter & Search Row */}
      {items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/80">
            {(['all', 'high', 'medium', 'low'] as RiskFilter[]).map((band) => (
              <button
                key={band}
                type="button"
                onClick={() => setRiskFilter(band)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap ${
                  riskFilter === band
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {band === 'all' ? 'All risk' : `${band} risk`}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter narration or date…"
              className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
        </div>
      ) : null}

      {/* Main Queue */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        {loading ? (
          <div className="space-y-3 p-6">
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
            <div className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
              Money inbox is clear
            </h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
              Drop a bank statement, saved email, or alert text to auto-categorize entries and post balanced vouchers in one click.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setShowIngest(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <FileUp className="h-4 w-4" />
                Extract from statement
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadSampleAlerts()}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Load sample bank events
              </button>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No pending items match your current filter.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {filteredItems.map((item) => {
              const confidence = Math.round(
                (item.suggestion?.confidence ?? item.event.confidence) * 100,
              );
              const isOut = item.event.direction === 'out';
              return (
                <li
                  key={item.event.id}
                  className="flex flex-col justify-between gap-4 px-5 py-4 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <span
                        className={`num-tabular text-sm font-semibold ${
                          isOut
                            ? 'text-slate-900 dark:text-slate-100'
                            : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {isOut ? '−' : '+'}
                        {formatMinor(item.event.amountMinor)}
                      </span>
                      <span className="num-tabular text-xs text-slate-500 dark:text-slate-400">
                        {item.event.date}
                        {formatEmailTime(item.event.occurredAt)}
                      </span>
                      <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                        ·
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {item.event.source}
                      </span>
                      <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                        ·
                      </span>
                      <span className={`text-xs font-medium capitalize ${riskTextColor(item.risk.band)}`}>
                        {item.risk.band} risk
                      </span>
                    </div>

                    <div className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">
                      {item.event.narration}
                    </div>

                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {item.risk.reasons.join(' · ')}
                      {item.suggestion?.taxHint ? ` · Check ${item.suggestion.taxHint}` : ''}
                      {confidence > 0 ? ` · ${confidence}% rule match` : ''}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
                    <select
                      aria-label={`Category for ${item.event.narration}`}
                      value={ledgerByEvent[item.event.id] ?? ''}
                      onChange={(e) =>
                        setLedgerByEvent((cur) => ({
                          ...cur,
                          [item.event.id]: e.target.value,
                        }))
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none sm:w-52 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    >
                      <option value="">Choose ledger…</option>
                      {categories.map((ledger) => (
                        <option key={ledger.id} value={ledger.id}>
                          {ledger.name}
                        </option>
                      ))}
                    </select>

                    {item.event.emailArchiveId || item.event.attachmentId ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPreviewEvent(item.event)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        Source
                      </button>
                    ) : null}

                    <button
                      type="button"
                      disabled={busy || !bankLedgerId || !ledgerByEvent[item.event.id]}
                      onClick={() => void post(item)}
                      className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Post
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void ignore(item)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                    >
                      Ignore
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Recently posted with inline reverse confirmation */}
      {posted.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recently posted from inbox
            </h3>
          </div>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {posted.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <span className="num-tabular text-xs text-slate-500 dark:text-slate-400">
                    {event.date}
                    {formatEmailTime(event.occurredAt)}
                  </span>
                  <span className="mx-2 text-slate-300 dark:text-slate-700">·</span>
                  <span className="num-tabular font-medium text-slate-900 dark:text-slate-100">
                    {formatMinor(event.amountMinor)}
                  </span>
                  <span className="mx-2 text-slate-300 dark:text-slate-700">·</span>
                  <span className="truncate text-slate-700 dark:text-slate-300">
                    {event.narration}
                  </span>
                  {event.emailArchiveId || event.attachmentId ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPreviewEvent(event)}
                      className="ml-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline disabled:opacity-40 dark:text-indigo-400"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      Source email
                    </button>
                  ) : null}
                </div>

                {confirmReverseId === event.id ? (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400">Reverse voucher?</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmReverseId(undefined)}
                      className="text-slate-500 hover:underline"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void reverse(event)}
                      className="rounded bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
                    >
                      Reverse
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmReverseId(event.id)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reverse
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {previewEvent ? (
        <SourceEmailPreview
          workspaceId={workspaceId}
          {...(previewEvent.emailArchiveId ? { emailArchiveId: previewEvent.emailArchiveId } : {})}
          {...(!previewEvent.emailArchiveId && previewEvent.attachmentId
            ? { attachmentId: previewEvent.attachmentId }
            : {})}
          onClose={() => setPreviewEvent(undefined)}
        />
      ) : null}
    </div>
  );
}
