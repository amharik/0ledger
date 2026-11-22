import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Inbox,
  Mail,
  Scale,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import { hydrateMailboxesFromDb } from '@/core/desktop/mail-sync';
import {
  askCaForItem,
  buildCloseCockpit,
  generateCaPack,
  listCaPacks,
  listExceptionQueue,
  updateCloseItem,
  type CaPackFileContent,
  type CloseCockpitData,
} from '@/core/autopilot';
import {
  balanceSheet,
  partyOutstanding,
  profitAndLoss,
  type BalanceSheet,
  type PartyOutstandingRow,
  type ProfitAndLoss,
} from '@/core/ledger/reports';
import { formatMinor } from '@/core/money/money';
import type { CaPack, CloseItem, Ledger, Voucher } from '@/core/model';

export interface OverviewNavigateTarget {
  section: 'activity' | 'reports' | 'books';
  subTab?: string;
}

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  hasGstin: boolean;
  enableTally: boolean;
  enableCaPack: boolean;
  refreshToken: number;
  onChanged: (message: string) => void;
  onNavigate: (target: OverviewNavigateTarget) => void;
  onOpenNewEntry: () => void;
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function readinessText(status: string): { label: string; colorClass: string } {
  if (status === 'ready') {
    return { label: 'Ready to close', colorClass: 'text-emerald-700 dark:text-emerald-400' };
  }
  if (status === 'needs_review') {
    return { label: 'Needs review', colorClass: 'text-amber-700 dark:text-amber-400' };
  }
  return { label: 'Action required', colorClass: 'text-red-700 dark:text-red-400' };
}

export function OverviewDashboard({
  workspaceId,
  ledgers,
  hasGstin,
  enableTally,
  enableCaPack,
  refreshToken,
  onChanged,
  onNavigate,
  onOpenNewEntry,
}: Props) {
  const [period, setPeriod] = useState(currentPeriod());
  const [cockpit, setCockpit] = useState<CloseCockpitData>();
  const [pnl, setPnl] = useState<ProfitAndLoss>();
  const [bs, setBs] = useState<BalanceSheet>();
  const [parties, setParties] = useState<PartyOutstandingRow[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [mailboxCount, setMailboxCount] = useState(0);
  const [recentVouchers, setRecentVouchers] = useState<Voucher[]>([]);
  const [packs, setPacks] = useState<CaPack[]>([]);
  const [packFiles, setPackFiles] = useState<CaPackFileContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPackFiles([]);
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const db = getDb();
    void Promise.all([
      buildCloseCockpit(db, workspaceId, period),
      profitAndLoss(db, workspaceId),
      balanceSheet(db, workspaceId),
      partyOutstanding(db, workspaceId),
      listExceptionQueue(db, workspaceId),
      db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
      listCaPacks(db, workspaceId, period),
      hydrateMailboxesFromDb(db, workspaceId),
    ])
      .then(([nextCockpit, nextPnl, nextBs, nextParties, queue, vouchers, nextPacks, nextMailboxes]) => {
        if (cancelled) return;
        setCockpit(nextCockpit);
        setPnl(nextPnl);
        setBs(nextBs);
        setParties(nextParties);
        setInboxCount(queue.length);
        setMailboxCount(nextMailboxes.length);
        setRecentVouchers(
          vouchers
            .filter((v) => v.status === 'regular')
            .sort(
              (a, b) =>
                b.date.localeCompare(a.date) ||
                (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
            )
            .slice(0, 5),
        );
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

  async function mutateCloseItem(item: CloseItem, action: 'ask' | 'resolve' | 'waive') {
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      if (action === 'ask') {
        await askCaForItem(db, workspaceId, item.id);
        onChanged('Queued question for CA pack');
      } else if (action === 'resolve') {
        await updateCloseItem(db, workspaceId, item.id, { status: 'resolved' });
        onChanged('Close item resolved');
      } else {
        await updateCloseItem(db, workspaceId, item.id, { status: 'waived' });
        onChanged('Close item waived');
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleGeneratePack() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await generateCaPack(getDb(), workspaceId, period);
      setPackFiles(result.files);
      setPacks((current) => [result.pack, ...current]);
      onChanged(`CA pack ready (${result.files.length} files generated)`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const cashBankIds = new Set(ledgers.filter((l) => l.isBank || l.isCash).map((l) => l.id));
  const cashPositionMinor = (bs?.assets ?? [])
    .filter((row) => cashBankIds.has(row.ledgerId))
    .reduce((sum, row) => sum + row.amountMinor, 0);

  const receivablesMinor = parties
    .filter((p) => p.type === 'debtor' || p.outstandingMinor > 0)
    .reduce((sum, p) => sum + Math.max(0, p.outstandingMinor), 0);

  const payablesMinor = parties
    .filter((p) => p.type === 'creditor' || p.outstandingMinor < 0)
    .reduce((sum, p) => sum + Math.abs(Math.min(0, p.outstandingMinor)), 0);

  const netProfitMinor = pnl?.netProfitMinor ?? 0;
  const openItems = cockpit?.openItems ?? [];
  const readiness = cockpit?.readiness;
  const statusMeta = readiness ? readinessText(readiness.status) : undefined;

  return (
    <div className="space-y-8">
      {/* Header row with period selector */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Financial overview
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {enableCaPack
              ? 'Live cash position, quick actions, and monthly close readiness.'
              : 'Live cash position, quick actions, and recent bookkeeping activity.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span>Period</span>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="num-tabular rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* Primary KPI Strip (flat single-elevation grid separated by 1px borders) */}
      <section className="grid grid-cols-1 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Cash & bank balance
          </div>
          <div className="num-tabular mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {loading ? '—' : formatMinor(cashPositionMinor)}
          </div>
          <button
            type="button"
            onClick={() => onNavigate({ section: 'reports', subTab: 'balance' })}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            View balance sheet
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Net profit (YTD)
          </div>
          <div
            className={`num-tabular mt-2 text-2xl font-semibold ${
              netProfitMinor >= 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-red-700 dark:text-red-400'
            }`}
          >
            {loading ? '—' : formatMinor(netProfitMinor)}
          </div>
          <button
            type="button"
            onClick={() => onNavigate({ section: 'reports', subTab: 'pnl' })}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            Inspect P&amp;L
            <ArrowRight className="h-3 w-3" />
          </button>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Receivables / payables
          </div>
          <div className="num-tabular mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {loading ? '—' : formatMinor(receivablesMinor)}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              Owed: <span className="num-tabular">{formatMinor(payablesMinor)}</span>
            </span>
            <button
              type="button"
              onClick={() => onNavigate({ section: 'reports', subTab: 'parties' })}
              className="font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              Parties
            </button>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {enableCaPack ? `Close readiness (${period})` : `Bank matching (${period})`}
          </div>
          <div className="mt-2 flex items-baseline gap-2.5">
            {enableCaPack ? (
              <>
                <span className="num-tabular text-2xl font-semibold text-slate-900 dark:text-slate-100">
                  {loading || !readiness ? '—' : `${readiness.score}/100`}
                </span>
                {statusMeta ? (
                  <span className={`text-xs font-medium ${statusMeta.colorClass}`}>
                    {statusMeta.label}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="num-tabular text-2xl font-semibold text-slate-900 dark:text-slate-100">
                {loading || !cockpit
                  ? '—'
                  : `${cockpit.cash.reconciledLines}/${cockpit.cash.totalLines}`}
              </span>
            )}
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {cockpit
              ? `${cockpit.cash.reconciledLines}/${cockpit.cash.totalLines} bank lines matched`
              : 'Checking books…'}
          </div>
        </div>
      </section>

      {/* Quick Actions */}
      <section aria-labelledby="quick-actions-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2
              id="quick-actions-heading"
              className="text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              Quick actions
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Jump directly to your most frequent bookkeeping tasks.
            </p>
          </div>
        </div>

        <div
          className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
            hasGstin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'
          }`}
        >
          <button
            type="button"
            onClick={() => onNavigate({ section: 'activity', subTab: 'import' })}
            className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Mail className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <span>Import from Email</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {mailboxCount > 0
                  ? `${mailboxCount} IMAP account${mailboxCount === 1 ? '' : 's'} ready to fetch.`
                  : 'Pull bank alerts and statements via IMAP.'}
              </p>
            </div>
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate({ section: 'activity', subTab: 'inbox' })}
            className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Inbox className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span>Review Money Inbox</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {inboxCount > 0
                  ? `${inboxCount} transaction${inboxCount === 1 ? '' : 's'} waiting to categorize.`
                  : 'Inbox is clear. Categorize imported items here.'}
              </p>
            </div>
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate({ section: 'activity', subTab: 'reconcile' })}
            className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Scale className="h-4 w-4 text-slate-600 dark:text-slate-400" />
                <span>Reconcile Bank</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {cockpit && cockpit.cash.unreconciledLines > 0
                  ? `${cockpit.cash.unreconciledLines} statement line${cockpit.cash.unreconciledLines === 1 ? '' : 's'} need matching.`
                  : 'Verify bank statements against your ledger.'}
              </p>
            </div>
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate({ section: 'books', subTab: 'export' })}
            className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <Download className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>Export Books</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                Download Excel workbook, CSV reports, or an encrypted backup.
              </p>
            </div>
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          </button>

          {hasGstin ? (
            <button
              type="button"
              onClick={() => onNavigate({ section: 'reports', subTab: 'gstr2b' })}
              className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
            >
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  <FileSpreadsheet className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <span>Check GST Alerts</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  Spot GSTR-2B credit mismatches and missing vendor filings.
                </p>
              </div>
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            </button>
          ) : null}
        </div>
      </section>

      {/* Main Split: Month-End Close & CA Pack (if enabled) OR Cash & Book Health (Left 8 cols) + Recent Vouchers (Right 4 cols) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {enableCaPack ? (
          <section className="rounded-xl border border-slate-200 bg-white lg:col-span-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Month-end close &amp; CA pack
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {enableTally
                    ? 'Resolve blockers or flag questions for your CA, then export Tally XML, trial balance, and schedules in one pack.'
                    : 'Resolve blockers or flag questions for your CA, then export trial balance and schedules in one pack.'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => void handleGeneratePack()}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <Download className="h-4 w-4" />
                <span>{busy ? 'Generating…' : 'Generate CA pack'}</span>
              </button>
            </div>

          <div className="p-6 space-y-6">
            {cockpit ? (
              <div className="grid grid-cols-2 gap-4 border-b border-slate-200 pb-5 sm:grid-cols-4 dark:border-slate-800">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Statement net</div>
                  <div className="num-tabular mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {formatMinor(cockpit.cash.statementNetMinor)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Ledger bank net</div>
                  <div className="num-tabular mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {formatMinor(cockpit.cash.ledgerNetMinor)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Variance</div>
                  <div
                    className={`num-tabular mt-1 text-sm font-semibold ${
                      cockpit.cash.differenceMinor === 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {formatMinor(cockpit.cash.differenceMinor)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {hasGstin ? 'Captured GST/TDS' : 'Captured TDS / tax'}
                  </div>
                  <div className="num-tabular mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {formatMinor(cockpit.tax.totalMinor)}
                  </div>
                </div>
              </div>
            ) : null}

            {readiness && readiness.blockers.length > 0 ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/30">
                <div className="flex items-center gap-2 text-sm font-medium text-red-800 dark:text-red-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>Must resolve before closing</span>
                </div>
                <ul className="mt-2 space-y-1 pl-6 text-xs text-red-700 list-disc dark:text-red-300">
                  {readiness.blockers.slice(0, 6).map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {packFiles.length > 0 ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-emerald-900 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>CA pack ready for {period}</span>
                  </div>
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    Click any file to download
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {packFiles.map((file) => (
                    <button
                      key={file.name}
                      type="button"
                      onClick={() => downloadFile(file, period)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 transition-colors hover:bg-emerald-50 dark:border-emerald-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>{file.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Close checklist
                </h3>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {openItems.length} open {cockpit ? `· ${cockpit.items.length} total` : ''}
                </span>
              </div>

              {loading ? (
                <div className="mt-3 space-y-2">
                  <div className="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
                  <div className="h-12 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
                </div>
              ) : openItems.length === 0 ? (
                <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>No open close items for {period}. Your books are clean for handover.</span>
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                  {openItems.slice(0, 10).map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col justify-between gap-3 py-3.5 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {item.title}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{item.type.replace(/_/g, ' ')}</span>
                          <span aria-hidden="true">·</span>
                          <span>owner: {item.owner}</span>
                          {item.amountMinor !== undefined ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="num-tabular font-medium text-slate-700 dark:text-slate-300">
                                {formatMinor(item.amountMinor)}
                              </span>
                            </>
                          ) : null}
                          {item.status === 'asked_ca' ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-amber-700 dark:text-amber-400">
                                queued for CA
                              </span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.status !== 'asked_ca' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void mutateCloseItem(item, 'ask')}
                            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            Ask CA
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void mutateCloseItem(item, 'resolve')}
                          className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Resolve
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void mutateCloseItem(item, 'waive')}
                          className="px-2 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 disabled:opacity-50 whitespace-nowrap dark:text-slate-400 dark:hover:text-slate-200"
                        >
                          Waive
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {packs.length > 0 ? (
              <div className="border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                Last CA pack generated {new Date(packs[0]!.generatedAt).toLocaleString()} · readiness{' '}
                <span className="num-tabular font-medium">{packs[0]!.readiness}/100</span>
              </div>
            ) : null}
          </div>
        </section>
        ) : (
          <section className="rounded-xl border border-slate-200 bg-white lg:col-span-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Cash &amp; ledger check ({period})
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Compares imported bank statement totals with your recorded ledger entries so
                  nothing is missed.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate({ section: 'activity', subTab: 'reconcile' })}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Scale className="h-3.5 w-3.5" />
                <span>Open reconciliation</span>
              </button>
            </div>

            <div className="space-y-5 p-6">
              {cockpit ? (
                <div className="grid grid-cols-1 gap-4 border-b border-slate-200 pb-5 sm:grid-cols-3 dark:border-slate-800">
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Bank statement net
                    </div>
                    <div className="num-tabular mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                      {formatMinor(cockpit.cash.statementNetMinor)}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                      Total inflow minus outflow from imported statements
                    </p>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Ledger bank net
                    </div>
                    <div className="num-tabular mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                      {formatMinor(cockpit.cash.ledgerNetMinor)}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                      Total recorded in your bank accounts this month
                    </p>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">Difference</div>
                    <div
                      className={`num-tabular mt-1 text-base font-semibold ${
                        cockpit.cash.differenceMinor === 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {formatMinor(cockpit.cash.differenceMinor)}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                      {cockpit.cash.differenceMinor === 0
                        ? 'Bank and ledger match cleanly'
                        : 'Categorize or match remaining lines to zero out'}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <span>
                  {inboxCount > 0
                    ? `${inboxCount} imported transaction(s) waiting in Money inbox.`
                    : 'All imported transactions are categorized and posted.'}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate({ section: 'books', subTab: 'settings' })}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Need CA Pack &amp; close checklist? Enable in Settings
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Right column: Recent Ledger Entries */}
        <section className="rounded-xl border border-slate-200 bg-white lg:col-span-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Recent entries
            </h2>
            <button
              type="button"
              onClick={() => onNavigate({ section: 'activity', subTab: 'ledger' })}
              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
            >
              View all
            </button>
          </div>

          <div className="p-5">
            {loading ? (
              <div className="space-y-3">
                <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
                <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
                <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              </div>
            ) : recentVouchers.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  No vouchers posted yet.
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Post an invoice, payment, or categorize an event from the inbox.
                </p>
                <button
                  type="button"
                  onClick={onOpenNewEntry}
                  className="mt-4 inline-flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  Record first entry
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {recentVouchers.map((voucher) => (
                  <li key={voucher.id} className="py-3 first:pt-0 last:pb-0">
                    <button
                      type="button"
                      onClick={() => onNavigate({ section: 'activity', subTab: 'ledger' })}
                      className="block w-full text-left group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="num-tabular text-xs font-semibold text-slate-900 group-hover:text-blue-700 dark:text-slate-100 dark:group-hover:text-blue-400">
                          {voucher.number}
                        </span>
                        <span className="num-tabular text-xs text-slate-500 dark:text-slate-400">
                          {voucher.date}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-sm text-slate-700 dark:text-slate-300">
                        {voucher.narration || voucher.invoiceNumber || voucher.voucherType}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {voucher.voucherType}
                        {voucher.source !== 'manual' ? ` · ${voucher.source}` : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
