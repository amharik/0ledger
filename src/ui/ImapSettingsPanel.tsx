import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Mail,
  Pencil,
  Plug,
  Plus,
  Shield,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  MAIL_PROVIDER_PRESETS,
  deleteMailbox,
  getMailboxPassword,
  hydrateMailboxesFromDb,
  listMailboxes,
  saveMailbox,
  setDefaultMailbox,
  testMailConnectionDetailed,
  type ImapConfig,
  type MailPreset,
  type MailboxAccount,
  type MailboxProvider,
} from '@/core/desktop/mail-sync';
import type { Ledger } from '@/core/model';

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  onChanged?: ((message: string) => void) | undefined;
  onOpenImport?: (() => void) | undefined;
}

const PROVIDERS: MailboxProvider[] = ['gmail', 'outlook', 'zoho', 'yahoo', 'custom'];

const PRESET_OPTIONS: Array<{ value: MailPreset; label: string }> = [
  { value: 'bank', label: 'Bank alerts & statements' },
  { value: 'fastag', label: 'FASTag toll deductions' },
  { value: 'shopping', label: 'Shopping & cloud invoices' },
  { value: 'all', label: 'All financial messages' },
];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatLastSynced(iso?: string): string {
  if (!iso) return 'Never synced';
  try {
    const date = new Date(iso);
    return `Last synced ${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  } catch {
    return 'Synced recently';
  }
}

export function ImapSettingsPanel({ workspaceId, ledgers, onChanged, onOpenImport }: Props) {
  const [mailboxes, setMailboxes] = useState<MailboxAccount[]>(() => listMailboxes(workspaceId));
  const [editing, setEditing] = useState(false);
  const [isNew, setIsNew] = useState(true);
  const [editId, setEditId] = useState('');

  // Form state
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<MailboxProvider>('gmail');
  const [host, setHost] = useState('imap.gmail.com');
  const [port, setPort] = useState(993);
  const [tls, setTls] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mailboxFolder, setMailboxFolder] = useState('INBOX');
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [defaultPreset, setDefaultPreset] = useState<MailPreset>('bank');
  const [defaultDays, setDefaultDays] = useState(60);
  const [defaultLimit, setDefaultLimit] = useState(25);
  const [defaultBankLedgerId, setDefaultBankLedgerId] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [showServerDetails, setShowServerDetails] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Action state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const bankLedgers = useMemo(
    () =>
      ledgers
        .filter((ledger) => ledger.isBank && !ledger.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers],
  );

  const bankById = useMemo(
    () => new Map(bankLedgers.map((ledger) => [ledger.id, ledger.name])),
    [bankLedgers],
  );

  useEffect(() => {
    let cancelled = false;
    void hydrateMailboxesFromDb(getDb(), workspaceId).then((hydrated) => {
      if (!cancelled) setMailboxes(hydrated);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  function selectProvider(next: MailboxProvider) {
    setProvider(next);
    const preset = MAIL_PROVIDER_PRESETS[next];
    if (next !== 'custom') {
      setHost(preset.host);
      setPort(preset.port);
      setTls(preset.tls);
      setShowServerDetails(false);
    } else {
      setShowServerDetails(true);
    }
  }

  function openNewForm() {
    setIsNew(true);
    setEditId(`mbx_${Date.now()}`);
    setLabel('');
    setProvider('gmail');
    setHost(MAIL_PROVIDER_PRESETS.gmail.host);
    setPort(MAIL_PROVIDER_PRESETS.gmail.port);
    setTls(true);
    setUsername('');
    setPassword('');
    setShowPassword(false);
    setMailboxFolder('INBOX');
    setAvailableFolders([]);
    setDefaultPreset('bank');
    setDefaultDays(60);
    setDefaultLimit(25);
    setDefaultBankLedgerId(bankLedgers[0]?.id ?? '');
    setMakeDefault(mailboxes.length === 0);
    setShowServerDetails(false);
    setEditing(true);
    setError(undefined);
    setNotice(undefined);
  }

  async function openEditForm(acc: MailboxAccount) {
    setIsNew(false);
    setEditId(acc.id);
    setLabel(acc.label);
    setProvider(acc.provider);
    setHost(acc.host);
    setPort(acc.port);
    setTls(acc.tls ?? acc.port === 993);
    setUsername(acc.username);
    setPassword((await getMailboxPassword(workspaceId, acc.id)) ?? '');
    setShowPassword(false);
    setMailboxFolder(acc.mailbox || 'INBOX');
    setAvailableFolders([]);
    setDefaultPreset(acc.defaultPreset ?? 'bank');
    setDefaultDays(acc.defaultDays ?? 60);
    setDefaultLimit(acc.defaultLimit ?? 25);
    setDefaultBankLedgerId(acc.defaultBankLedgerId ?? '');
    setMakeDefault(Boolean(acc.isDefault));
    setShowServerDetails(acc.provider === 'custom');
    setEditing(true);
    setError(undefined);
    setNotice(undefined);
  }

  async function runConnectionTest(config: ImapConfig, targetKey: string) {
    if (!config.username.trim() || !config.password.trim()) {
      setError('Enter both your email address and app password before testing.');
      return;
    }
    setTestingId(targetKey);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await testMailConnectionDetailed(config, workspaceId);
      if (targetKey === 'form' && res.folders.length > 0) {
        setAvailableFolders(res.folders);
      }
      const countPart =
        typeof res.exists === 'number' ? ` (${res.exists.toLocaleString()} messages in ${res.mailbox})` : '';
      setNotice(`Connected to ${config.host} as ${config.username}${countPart}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTestingId(null);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);

    if (!username.trim() || !password.trim()) {
      setError('Email address and app password are required.');
      return;
    }
    if (!host.trim()) {
      setError('IMAP server host is required.');
      return;
    }

    const existing = mailboxes.find((m) => m.id === editId);
    const providerLabel = MAIL_PROVIDER_PRESETS[provider].label.split(' ')[0] ?? 'IMAP';
    const nextAccount: MailboxAccount = {
      id: editId,
      label: label.trim() || `${username.trim().split('@')[0] ?? 'Business'} (${providerLabel})`,
      provider,
      host: host.trim(),
      port: Number(port) || 993,
      tls,
      username: username.trim(),
      mailbox: mailboxFolder.trim() || 'INBOX',
      isDefault: makeDefault || mailboxes.length === 0,
      defaultPreset,
      defaultDays,
      defaultLimit,
      ...(defaultBankLedgerId ? { defaultBankLedgerId } : {}),
      ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };

    await saveMailbox(workspaceId, nextAccount, password.trim(), getDb());
    const refreshed = listMailboxes(workspaceId);
    setMailboxes(refreshed);
    setEditing(false);
    const msg = `Saved IMAP account "${nextAccount.label}".`;
    setNotice(msg);
    onChanged?.(msg);
  }

  function handleMakeDefault(id: string) {
    const updated = setDefaultMailbox(workspaceId, id, getDb());
    setMailboxes(updated);
    const chosen = updated.find((m) => m.id === id);
    if (chosen) {
      const msg = `"${chosen.label}" set as default import mailbox.`;
      setNotice(msg);
      onChanged?.(msg);
    }
  }

  async function handleConfirmDelete(acc: MailboxAccount) {
    await deleteMailbox(workspaceId, acc.id, getDb());
    setMailboxes(listMailboxes(workspaceId));
    setConfirmDeleteId(null);
    const msg = `Removed mailbox "${acc.label}".`;
    setNotice(msg);
    onChanged?.(msg);
  }

  async function testSavedAccount(acc: MailboxAccount) {
    const savedPassword = await getMailboxPassword(workspaceId, acc.id);
    if (!savedPassword) {
      setError('Enter this mailbox\'s app password in Edit before testing it.');
      return;
    }
    await runConnectionTest(
      {
        host: acc.host,
        port: acc.port,
        tls: acc.tls ?? acc.port === 993,
        username: acc.username,
        password: savedPassword,
        mailbox: acc.mailbox || 'INBOX',
      },
      acc.id,
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
            Email & IMAP accounts
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Configure mailboxes for automatic ledger ingestion from bank alerts, statements, FASTag
            tolls, and vendor invoices.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenImport && mailboxes.length > 0 ? (
            <button
              type="button"
              onClick={onOpenImport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span>Pull transactions</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : openNewForm())}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            {editing ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            <span>{editing ? 'Close form' : 'Add IMAP account'}</span>
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      ) : null}

      {/* Add / Edit IMAP Form */}
      {editing ? (
        <form
          onSubmit={handleSave}
          className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-[#111827]"
        >
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                {isNew ? 'Connect IMAP mailbox' : `Edit ${label || username}`}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Credentials are stored locally in this workspace and included in encrypted `.0ledger`
                backups.
              </p>
            </div>
          </div>

          {/* Provider selector */}
          <div className="mb-5">
            <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
              Email provider
            </div>
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) => {
                const active = provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => selectProvider(p)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      active
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/60 dark:text-indigo-300'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    {MAIL_PROVIDER_PRESETS[p].label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary credentials grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Account label
              </span>
              <input
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g., Business Banking & GST"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Email address
              </span>
              <input
                type="email"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
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
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="16-character app password"
                  required
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                IMAP folder
              </span>
              {availableFolders.length > 0 ? (
                <select
                  value={mailboxFolder}
                  onChange={(event) => setMailboxFolder(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {availableFolders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={mailboxFolder}
                  onChange={(event) => setMailboxFolder(event.target.value)}
                  placeholder="INBOX"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              )}
            </label>
          </div>

          {/* Server details (auto-shown for Custom, expandable for presets) */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowServerDetails((open) => !open)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {showServerDetails ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <span>
                IMAP server settings ({host || 'custom'}:{port} · {tls ? 'SSL/TLS' : 'STARTTLS'})
              </span>
            </button>

            {showServerDetails ? (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-4">
                <label className="block sm:col-span-2">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    IMAP host
                  </span>
                  <input
                    type="text"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="imap.example.com"
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
                    value={port}
                    onChange={(event) => setPort(Number(event.target.value) || 993)}
                    className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <div className="flex items-end pb-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={tls}
                      onChange={(event) => setTls(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>Implicit SSL/TLS</span>
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          {/* Persisted import defaults for this mailbox */}
          <div className="mt-5 border-t border-slate-100 pt-5 dark:border-slate-800">
            <div className="mb-3 text-xs font-semibold text-slate-700 dark:text-slate-200">
              Default import settings for this mailbox
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Default filter
                </span>
                <select
                  value={defaultPreset}
                  onChange={(event) => setDefaultPreset(event.target.value as MailPreset)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  {PRESET_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Lookback window
                </span>
                <select
                  value={defaultDays}
                  onChange={(event) => setDefaultDays(Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={15}>Last 15 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={60}>Last 60 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Max emails per pull
                </span>
                <select
                  value={defaultLimit}
                  onChange={(event) => setDefaultLimit(Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={10}>10 emails</option>
                  <option value={25}>25 emails</option>
                  <option value={50}>50 emails</option>
                  <option value={100}>100 emails</option>
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Assign to bank ledger
                </span>
                <select
                  value={defaultBankLedgerId}
                  onChange={(event) => setDefaultBankLedgerId(event.target.value)}
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

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={makeDefault}
                  onChange={(event) => setMakeDefault(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Use as default mailbox for email imports</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={testingId === 'form'}
                  onClick={() =>
                    void runConnectionTest(
                      {
                        host: host.trim(),
                        port: Number(port) || 993,
                        tls,
                        username: username.trim(),
                        password: password.trim(),
                        mailbox: mailboxFolder.trim() || 'INBOX',
                      },
                      'form',
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Plug className="h-4 w-4" />
                  <span>{testingId === 'form' ? 'Testing...' : 'Test connection'}</span>
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
                >
                  Save account
                </button>
              </div>
            </div>
          </div>

          {/* Collapsible App Password guide */}
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setShowHelp((open) => !open)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
            >
              {showHelp ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <span>Need a Gmail or Outlook App Password?</span>
            </button>
            {showHelp ? (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
                <li>
                  Enable 2-Step Verification on your Google or Microsoft account security settings.
                </li>
                <li>
                  Create a dedicated App Password (e.g., named <span className="font-mono">0ledger</span>)
                  at <span className="font-mono">myaccount.google.com/apppasswords</span>.
                </li>
                <li>
                  Paste the 16-character code into the App password field above and click Test
                  connection.
                </li>
              </ol>
            ) : null}
          </div>
        </form>
      ) : null}

      {/* Configured Accounts List */}
      {mailboxes.length === 0 && !editing ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center dark:border-slate-800 dark:bg-[#111827]">
          <Mail className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            No IMAP mailboxes connected
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
            Connect Gmail, Outlook, Zoho, or any custom IMAP inbox to automatically pull bank
            statements, UPI/NEFT alerts, FASTag tolls, and vendor bills into your ledger.
          </p>
          <button
            type="button"
            onClick={openNewForm}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            <span>Connect first mailbox</span>
          </button>
        </div>
      ) : mailboxes.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                  <th className="px-4 py-3">Mailbox</th>
                  <th className="px-4 py-3">Server & folder</th>
                  <th className="px-4 py-3">Pull defaults</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {mailboxes.map((acc) => {
                  const isConfirming = confirmDeleteId === acc.id;
                  const isTesting = testingId === acc.id;
                  const bankName = acc.defaultBankLedgerId
                    ? bankById.get(acc.defaultBankLedgerId)
                    : undefined;
                  const presetLabel =
                    PRESET_OPTIONS.find((p) => p.value === (acc.defaultPreset ?? 'bank'))?.label ??
                    'Bank alerts';

                  return (
                    <tr
                      key={acc.id}
                      className="transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                    >
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {acc.label}
                          </span>
                          {acc.isDefault ? (
                            <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                              · Default
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {acc.username} · {formatLastSynced(acc.lastSyncedAt)}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-600 dark:text-slate-300">
                        <div className="font-mono">
                          {acc.host}:{acc.port}
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400">
                          Folder: {acc.mailbox || 'INBOX'}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-600 dark:text-slate-300">
                        <div>
                          {presetLabel} · {acc.defaultDays ?? 60}d
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400">
                          Bank: {bankName ?? 'Auto-detect'}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        {isConfirming ? (
                          <div className="inline-flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => void handleConfirmDelete(acc)}
                              className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700"
                            >
                              Remove
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex flex-wrap items-center justify-end gap-3">
                            {!acc.isDefault ? (
                              <button
                                type="button"
                                onClick={() => handleMakeDefault(acc.id)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
                              >
                                <Star className="h-3.5 w-3.5" />
                                <span>Set default</span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              disabled={isTesting}
                              onClick={() => void testSavedAccount(acc)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 disabled:opacity-50 dark:text-slate-400 dark:hover:text-indigo-400"
                            >
                              <Plug className="h-3.5 w-3.5" />
                              <span>{isTesting ? 'Testing...' : 'Test'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void openEditForm(acc)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(acc.id)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>Remove</span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* Privacy & Storage Note */}
      <div className="flex items-start gap-2.5 text-xs text-slate-500 dark:text-slate-400">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <p>
          IMAP credentials are persisted locally in your workspace database and obfuscated with your
          workspace key. Messages are fetched on demand, deduplicated by UID and transaction
          reference, and archived as `.eml` audit attachments.
        </p>
      </div>
    </div>
  );
}
