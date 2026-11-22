import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Mail,
  Paperclip,
  Plug,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  MAIL_PROVIDER_PRESETS,
  decodePassword,
  encodePassword,
  hydrateMailboxesFromDb,
  listMailboxes,
  listRecentMailHistory,
  markMailboxSynced,
  saveMailbox,
  syncLocalMail,
  testMailConnectionDetailed,
  type ImapConfig,
  type MailPreset,
  type MailProgressPayload,
  type MailSyncHistoryEntry,
  type MailSyncReport,
  type MailboxAccount,
  type MailboxProvider,
} from '@/core/desktop/mail-sync';
import { formatMinor } from '@/core/money/money';
import type { Ledger } from '@/core/model';

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  refreshToken: number;
  onChanged: (message: string) => void;
  onOpenSettings: () => void;
  onOpenInbox: () => void;
}

const PRESETS: Array<{ id: MailPreset; label: string; hint: string }> = [
  { id: 'bank', label: 'Bank & statements', hint: 'UPI, NEFT, IMPS, card alerts & PDF statements' },
  { id: 'fastag', label: 'FASTag tolls', hint: 'NHAI / NETC toll deductions & recharges' },
  { id: 'shopping', label: 'Invoices & bills', hint: 'Cloud, SaaS, Amazon, Flipkart & receipts' },
  { id: 'all', label: 'All messages', hint: 'Scan every email in lookback window' },
  { id: 'custom', label: 'Custom filter', hint: 'Match specific sender or keyword' },
];

const QUICK_PROVIDERS: MailboxProvider[] = ['gmail', 'outlook', 'zoho', 'yahoo', 'custom'];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatSyncTime(iso?: string): string {
  if (!iso) return 'Not synced yet';
  try {
    const d = new Date(iso);
    return `Last pulled ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  } catch {
    return 'Synced recently';
  }
}

export function EmailImportPanel({
  workspaceId,
  ledgers,
  refreshToken,
  onChanged,
  onOpenSettings,
  onOpenInbox,
}: Props) {
  const [mailboxes, setMailboxes] = useState<MailboxAccount[]>(() => listMailboxes(workspaceId));
  const [selectedId, setSelectedId] = useState<string>('');
  const [history, setHistory] = useState<MailSyncHistoryEntry[]>([]);

  // Pull controls
  const [preset, setPreset] = useState<MailPreset>('bank');
  const [customSearch, setCustomSearch] = useState('');
  const [days, setDays] = useState(60);
  const [limit, setLimit] = useState(25);
  const [bankLedgerId, setBankLedgerId] = useState('');

  // Inline quick-setup state (shown only when zero mailboxes exist)
  const [quickProvider, setQuickProvider] = useState<MailboxProvider>('gmail');
  const [quickHost, setQuickHost] = useState('imap.gmail.com');
  const [quickPort, setQuickPort] = useState(993);
  const [quickEmail, setQuickEmail] = useState('');
  const [quickPassword, setQuickPassword] = useState('');
  const [showQuickPass, setShowQuickPass] = useState(false);

  // Execution state
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<MailProgressPayload | null>(null);
  const [report, setReport] = useState<MailSyncReport | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const bankLedgers = useMemo(
    () =>
      ledgers
        .filter((ledger) => ledger.isBank && !ledger.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers],
  );

  const loadState = useCallback(async () => {
    const db = getDb();
    const [hydrated, recent] = await Promise.all([
      hydrateMailboxesFromDb(db, workspaceId),
      listRecentMailHistory(db, 12),
    ]);
    setMailboxes(hydrated);
    setHistory(recent);
    setSelectedId((current) => {
      if (current && hydrated.some((m) => m.id === current)) return current;
      return hydrated.find((m) => m.isDefault)?.id ?? hydrated[0]?.id ?? '';
    });
  }, [workspaceId]);

  useEffect(() => {
    void loadState();
  }, [loadState, refreshToken]);

  const activeAccount = useMemo(
    () => mailboxes.find((m) => m.id === selectedId) ?? mailboxes.find((m) => m.isDefault) ?? mailboxes[0],
    [mailboxes, selectedId],
  );

  // Apply persisted defaults whenever the active mailbox changes
  useEffect(() => {
    if (!activeAccount) {
      if (!bankLedgerId && bankLedgers[0]) setBankLedgerId(bankLedgers[0].id);
      return;
    }
    setPreset(activeAccount.defaultPreset ?? 'bank');
    setDays(activeAccount.defaultDays ?? 60);
    setLimit(activeAccount.defaultLimit ?? 25);
    setBankLedgerId(activeAccount.defaultBankLedgerId ?? bankLedgers[0]?.id ?? '');
  }, [activeAccount, bankLedgers]);

  function handleQuickProvider(next: MailboxProvider) {
    setQuickProvider(next);
    if (next !== 'custom') {
      setQuickHost(MAIL_PROVIDER_PRESETS[next].host);
      setQuickPort(MAIL_PROVIDER_PRESETS[next].port);
    }
  }

  async function handleQuickConnect(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setStatusMessage(undefined);

    if (!quickEmail.trim() || !quickPassword.trim()) {
      setError('Enter your email address and app password to connect.');
      return;
    }

    const host = quickHost.trim() || MAIL_PROVIDER_PRESETS[quickProvider].host;
    const port = Number(quickPort) || 993;
    const config: ImapConfig = {
      host,
      port,
      tls: port === 993,
      username: quickEmail.trim(),
      password: quickPassword.trim(),
      mailbox: 'INBOX',
    };

    setTesting(true);
    try {
      const testRes = await testMailConnectionDetailed(config);
      const providerName = MAIL_PROVIDER_PRESETS[quickProvider].label.split(' ')[0] ?? 'IMAP';
      const created: MailboxAccount = {
        id: `mbx_${Date.now()}`,
        label: `${quickEmail.trim().split('@')[0] ?? 'Business'} (${providerName})`,
        provider: quickProvider,
        host,
        port,
        tls: port === 993,
        username: quickEmail.trim(),
        passwordCipher: encodePassword(quickPassword.trim(), workspaceId),
        mailbox: testRes.mailbox || 'INBOX',
        isDefault: true,
        defaultPreset: 'bank',
        defaultDays: 60,
        defaultLimit: 25,
        ...(bankLedgerId ? { defaultBankLedgerId: bankLedgerId } : {}),
        createdAt: new Date().toISOString(),
      };

      saveMailbox(workspaceId, created, quickPassword.trim(), getDb());
      setQuickPassword('');
      await loadState();
      setSelectedId(created.id);
      const msg = `Connected ${created.username}. Ready to pull transactions.`;
      setStatusMessage(msg);
      onChanged(msg);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTesting(false);
    }
  }

  async function handleTestActive() {
    if (!activeAccount) return;
    setTesting(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const res = await testMailConnectionDetailed({
        host: activeAccount.host,
        port: activeAccount.port,
        tls: activeAccount.tls ?? activeAccount.port === 993,
        username: activeAccount.username,
        password: decodePassword(activeAccount.passwordCipher, workspaceId),
        mailbox: activeAccount.mailbox || 'INBOX',
      });
      const countPart =
        typeof res.exists === 'number' ? ` · ${res.exists.toLocaleString()} messages in ${res.mailbox}` : '';
      setStatusMessage(`Connected to ${activeAccount.host}${countPart}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTesting(false);
    }
  }

  async function pullAccounts(targets: MailboxAccount[]) {
    if (targets.length === 0) return;
    setSyncing(true);
    setError(undefined);
    setStatusMessage(undefined);
    setReport(null);

    const combined: MailSyncReport = {
      fetched: 0,
      newMessages: 0,
      transactionsCreated: 0,
      attachmentsCreated: 0,
      items: [],
      skipped: [],
      errors: [],
    };

    try {
      const db = getDb();
      for (let i = 0; i < targets.length; i += 1) {
        const account = targets[i]!;
        const plainPassword = decodePassword(account.passwordCipher, workspaceId);
        if (!account.username.trim() || !plainPassword.trim()) {
          combined.errors.push(`${account.label}: missing credentials. Update in IMAP settings.`);
          continue;
        }

        const config: ImapConfig = {
          host: account.host,
          port: account.port,
          tls: account.tls ?? account.port === 993,
          username: account.username,
          password: plainPassword,
          mailbox: account.mailbox || 'INBOX',
        };

        const isSingle = targets.length === 1;
        const effectivePreset = isSingle ? preset : (account.defaultPreset ?? preset);
        const effectiveDays = isSingle ? days : (account.defaultDays ?? days);
        const effectiveLimit = isSingle ? limit : (account.defaultLimit ?? limit);
        const effectiveBank = isSingle ? bankLedgerId : (account.defaultBankLedgerId ?? bankLedgerId);

        const res = await syncLocalMail(
          db,
          workspaceId,
          config,
          {
            preset: effectivePreset,
            days: effectiveDays,
            limit: effectiveLimit,
            ...(effectivePreset === 'custom' && customSearch.trim()
              ? { custom_search: customSearch.trim() }
              : {}),
          },
          effectiveBank || undefined,
          (p) => {
            setProgress({
              ...p,
              message:
                targets.length > 1
                  ? `[${account.label}] ${p.message}`
                  : p.message,
            });
          },
        );

        markMailboxSynced(workspaceId, account.id, db);
        combined.fetched += res.fetched;
        combined.newMessages += res.newMessages;
        combined.transactionsCreated += res.transactionsCreated;
        combined.attachmentsCreated += res.attachmentsCreated;
        combined.items.push(...res.items);
        combined.skipped.push(...res.skipped);
        combined.errors.push(...res.errors);
      }

      setReport(combined);
      await loadState();

      if (combined.transactionsCreated > 0) {
        onChanged(
          `Pulled ${combined.transactionsCreated} transaction(s) from email into Money inbox.`,
        );
      } else if (combined.fetched === 0) {
        setStatusMessage('No matching emails found for the selected filter and lookback window.');
      } else {
        setStatusMessage(
          `Scanned ${combined.fetched} email(s). All were already processed or contained no new transactions.`,
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSyncing(false);
    }
  }

  // First-run seamless quick-connect screen when no IMAP account exists yet
  if (mailboxes.length === 0) {
    return (
      <div className="space-y-5">
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        ) : null}

        <form
          onSubmit={handleQuickConnect}
          className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  Connect your inbox to pull ledgers automatically
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                0ledger reads bank alerts, e-statements, FASTag tolls, and vendor bills via IMAP,
                archives each `.eml` proof, and queues transactions in your Money inbox.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Advanced IMAP settings</span>
            </button>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {QUICK_PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => handleQuickProvider(p)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  quickProvider === p
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/60 dark:text-indigo-300'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {MAIL_PROVIDER_PRESETS[p].label}
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Email address
              </span>
              <input
                type="email"
                value={quickEmail}
                onChange={(event) => setQuickEmail(event.target.value)}
                placeholder="accounts@company.in"
                required
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                App password
              </span>
              <div className="relative">
                <input
                  type={showQuickPass ? 'text' : 'password'}
                  value={quickPassword}
                  onChange={(event) => setQuickPassword(event.target.value)}
                  placeholder="16-character app password"
                  required
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => setShowQuickPass((v) => !v)}
                  aria-label={showQuickPass ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showQuickPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Default bank ledger
              </span>
              <select
                value={bankLedgerId}
                onChange={(event) => setBankLedgerId(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">Auto-detect</option>
                {bankLedgers.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {quickProvider === 'custom' ? (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  IMAP server host
                </span>
                <input
                  type="text"
                  value={quickHost}
                  onChange={(event) => setQuickHost(event.target.value)}
                  placeholder="imap.yourdomain.com"
                  required
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Port
                </span>
                <input
                  type="number"
                  value={quickPort}
                  onChange={(event) => setQuickPort(Number(event.target.value) || 993)}
                  className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Saved locally to your workspace settings. Use a Google or Microsoft App Password.
            </p>
            <button
              type="submit"
              disabled={testing}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              <Plug className="h-4 w-4" />
              <span>{testing ? 'Verifying...' : 'Test & connect mailbox'}</span>
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {statusMessage ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      ) : null}

      {/* Main Pull Card */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        {/* Connected mailbox header bar */}
        <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Mail className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
            {mailboxes.length > 1 ? (
              <select
                aria-label="Select IMAP mailbox"
                value={activeAccount?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
                disabled={syncing}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {mailboxes.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label} ({acc.username})
                  </option>
                ))}
              </select>
            ) : (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {activeAccount?.label}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {activeAccount?.username} · {activeAccount?.mailbox || 'INBOX'} ·{' '}
                  {formatSyncTime(activeAccount?.lastSyncedAt)}
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              disabled={testing || syncing}
              onClick={() => void handleTestActive()}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-indigo-600 disabled:opacity-50 dark:text-slate-400 dark:hover:text-indigo-400"
            >
              <Plug className="h-3.5 w-3.5" />
              <span>{testing ? 'Testing...' : 'Test'}</span>
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Manage IMAP accounts</span>
            </button>
          </div>
        </div>

        {/* Filter presets & pull parameters */}
        <div className="space-y-4 p-5">
          <div>
            <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
              What to pull
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {PRESETS.map((item) => {
                const active = preset === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={syncing}
                    onClick={() => setPreset(item.id)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition ${
                      active
                        ? 'border-indigo-600 bg-indigo-50/80 dark:border-indigo-500 dark:bg-indigo-950/50'
                        : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <div
                      className={`text-xs font-semibold ${
                        active
                          ? 'text-indigo-700 dark:text-indigo-300'
                          : 'text-slate-800 dark:text-slate-200'
                      }`}
                    >
                      {item.label}
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {item.hint}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {preset === 'custom' ? (
            <div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Search sender or subject keyword
                </span>
                <input
                  type="text"
                  value={customSearch}
                  onChange={(event) => setCustomSearch(event.target.value)}
                  placeholder="e.g., hdfcbank, aws-billing, fastag"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
            </div>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-end sm:justify-between dark:border-slate-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                  Lookback
                </span>
                <select
                  value={days}
                  disabled={syncing}
                  onChange={(event) => setDays(Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={15}>Last 15 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={60}>Last 60 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                  Max emails
                </span>
                <select
                  value={limit}
                  disabled={syncing}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={10}>10 emails</option>
                  <option value={25}>25 emails</option>
                  <option value={50}>50 emails</option>
                  <option value={100}>100 emails</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                  Bank account
                </span>
                <select
                  value={bankLedgerId}
                  disabled={syncing}
                  onChange={(event) => setBankLedgerId(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="">Auto-detect</option>
                  {bankLedgers.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {mailboxes.length > 1 ? (
                <button
                  type="button"
                  disabled={syncing || testing}
                  onClick={() => void pullAccounts(mailboxes)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <span>Pull all ({mailboxes.length})</span>
                </button>
              ) : null}
              <button
                type="button"
                disabled={syncing || testing || !activeAccount}
                onClick={() => activeAccount && void pullAccounts([activeAccount])}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs transition hover:bg-indigo-700 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                <span>{syncing ? 'Pulling...' : 'Pull transactions'}</span>
              </button>
            </div>
          </div>

          {/* Calm Progress Strip */}
          {syncing && progress ? (
            <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {progress.message}
                </span>
                <span className="num-tabular text-slate-500 dark:text-slate-400">
                  {progress.percent}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all duration-300 dark:bg-indigo-400"
                  style={{ width: `${Math.max(progress.percent, 6)}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* Pull Execution Results */}
      {report ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                Pull summary
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Transactions are staged in Money inbox for review and one-click posting.
              </p>
            </div>
            {report.transactionsCreated > 0 ? (
              <button
                type="button"
                onClick={onOpenInbox}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-indigo-700"
              >
                <span>Review in Money inbox</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 border-b border-slate-200 sm:grid-cols-4 sm:divide-y-0 dark:divide-slate-800 dark:border-slate-800">
            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Emails scanned</div>
              <div className="num-tabular mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {report.fetched}
              </div>
            </div>
            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Transactions pulled</div>
              <div className="num-tabular mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                {report.transactionsCreated}
              </div>
            </div>
            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">EML proofs archived</div>
              <div className="num-tabular mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {report.attachmentsCreated}
              </div>
            </div>
            <div className="px-5 py-3.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Skipped / duplicate</div>
              <div className="num-tabular mt-1 text-lg font-semibold text-slate-500 dark:text-slate-400">
                {report.skipped.length}
              </div>
            </div>
          </div>

          {report.items.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Email & sender</th>
                    <th className="px-4 py-2.5">Reference</th>
                    <th className="px-4 py-2.5 text-right">Amount</th>
                    <th className="px-4 py-2.5 text-right">Audit proof</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {report.items.map((item, idx) => (
                    <tr
                      key={`${item.uid}-${idx}`}
                      className="transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <td className="num-tabular whitespace-nowrap px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                        {item.date}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {item.subject}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {item.sender}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                        {item.transactionId ?? 'Auto-deduped'}
                      </td>
                      <td
                        className={`num-tabular whitespace-nowrap px-4 py-3 text-right font-semibold ${
                          item.direction === 'in'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        {item.direction === 'in' ? '+' : '-'}
                        {formatMinor(item.amountMinor)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-slate-500 dark:text-slate-400">
                        {item.attachmentPath ? (
                          <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
                            <Paperclip className="h-3.5 w-3.5" />
                            <span>.eml saved</span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {report.errors.length > 0 ? (
            <div className="border-t border-slate-200 px-5 py-3 text-xs text-rose-600 dark:border-slate-800 dark:text-rose-400">
              <div className="font-medium">Errors ({report.errors.length})</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {report.errors.map((err, i) => (
                  <li key={`${i}-${err}`}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Recent Sync History */}
      {history.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Recently processed emails
            </h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {history.slice(0, 8).map((entry) => (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-4 px-5 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-800 dark:text-slate-200">
                    {entry.subject}
                  </div>
                  <div className="mt-0.5 text-slate-500 dark:text-slate-400">
                    <span className="num-tabular">{entry.date || '—'}</span> · UID{' '}
                    <span className="num-tabular">{entry.uid}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right font-medium text-slate-600 dark:text-slate-300">
                  {entry.txns > 0 ? (
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {entry.txns} txn{entry.txns === 1 ? '' : 's'} pulled
                    </span>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500">No ledger data</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
