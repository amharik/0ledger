import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  updateCompanyProfile,
  type WorkspaceBundle,
} from '@/core/db/workspace-service';
import {
  createLicenseKey,
  getLicenseState,
  verifyLicenseKey,
  type LicenseFeature,
  type LicenseState,
} from '@/core/license/license';
import {
  isNativeStoreAvailable,
  nativeStore,
  type ApplySummary,
  type IntegrityReport,
} from '@/core/db/native-store';
import { migrateWorkspaceToSqlite } from '@/core/db/migrate-to-sqlite';
import {
  mirrorAllWorkspaces,
  verifyWorkspace,
  type LedgerVerification,
} from '@/core/db/sqlite-mirror';
import { trialBalance } from '@/core/ledger/reports';
import type { DriveLink, Workspace } from '@/core/model';
import {
  GMAIL_SCOPES,
  buildAuthUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  fetchUserInfo,
  parseAuthRedirect,
  randomUrlSafe,
  revokeToken,
  type DriveTokens,
} from '@/core/drive/auth';
import { DEFAULT_GMAIL_QUERY, syncGmailStatements } from '@/core/ingest/gmail';
import { parseDriveFileId } from '@/core/drive/api';
import {
  archiveMonthToDrive,
  diffDriveSnapshot,
  ensureDriveLocation,
  readDriveSnapshot,
  restoreDriveSnapshot,
  syncWorkspaceToDrive,
  type RestoreMode,
  type SnapshotDiff,
} from '@/core/drive/sync';
import type { WorkbookSnapshot } from '@/core/template/snapshot';
import {
  clearDriveTokens,
  getDriveAccessToken,
  getDriveClientId,
  getDriveTokens,
  saveDriveClientId,
  saveDriveTokens,
} from '@/core/drive/token-store';

const LICENSE_STORAGE_KEY = '0ledger.license.key';

const FEATURE_LABELS: Array<{ id: LicenseFeature; label: string }> = [
  { id: 'gstr2b_reconciliation', label: 'GSTR-2B ITC reconciliation & vendor reminders' },
  { id: 'direct_tally_bridge', label: 'Direct Tally Prime live XML bridge' },
  { id: 'ocr_invoice_scanner', label: 'OCR bill & receipt scanner' },
  { id: 'unlimited_rules', label: 'Unlimited classification rules' },
  { id: 'priority_ca_pack', label: 'Priority monthly CA Pack builder' },
  { id: 'multi_client_cockpit', label: 'Multi-client CA Practice cockpit' },
];

const DRIVE_ORIGINS = [
  'https://www.googleapis.com/*',
  'https://sheets.googleapis.com/*',
  'https://oauth2.googleapis.com/*',
  'https://openidconnect.googleapis.com/*',
];
const GMAIL_ORIGINS = [...DRIVE_ORIGINS, 'https://gmail.googleapis.com/*'];

interface WorkspaceSettingsPanelProps {
  bundle: WorkspaceBundle;
  workspaces?: Workspace[] | undefined;
  onSelectWorkspace?: ((workspaceId: string) => void) | undefined;
  onAddCompany?: (() => void) | undefined;
  onChanged?: ((message: string) => void) | undefined;
}

interface LocalIntegrityResult {
  ok: boolean;
  vouchersChecked: number;
  ledgersCount: number;
  partiesCount: number;
  attachmentsCount: number;
  auditEventsCount: number;
  issues: string[];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function requestChromeOrigins(origins: string[]): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error('Google API host permissions were not granted.');
  }
}

export function WorkspaceSettingsPanel({
  bundle,
  workspaces = [],
  onSelectWorkspace,
  onAddCompany,
  onChanged,
}: WorkspaceSettingsPanelProps) {
  const workspaceId = bundle.workspace.id;
  const native = isNativeStoreAvailable();
  const hasChromeIdentity = typeof chrome !== 'undefined' && Boolean(chrome.identity);

  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  // 1. Company profile state
  const [legalName, setLegalName] = useState(bundle.company.legalName);
  const [tradeName, setTradeName] = useState(bundle.company.tradeName ?? '');
  const [gstin, setGstin] = useState(bundle.company.gstin ?? '');
  const [pan, setPan] = useState(bundle.company.pan ?? '');
  const [stateName, setStateName] = useState(bundle.company.state ?? '');
  const [pincode, setPincode] = useState(bundle.company.pincode ?? '');
  const [address, setAddress] = useState(bundle.company.address ?? '');
  const [booksBegin, setBooksBegin] = useState(bundle.company.booksBegin);
  const [enableTally, setEnableTally] = useState(Boolean(bundle.company.settings.enableTally));
  const [enableCaPack, setEnableCaPack] = useState(Boolean(bundle.company.settings.enableCaPack));
  const [savingCompany, setSavingCompany] = useState(false);

  // 2. Edition & License state
  const [licenseState, setLicenseState] = useState<LicenseState | null>(null);
  const [licenseInput, setLicenseInput] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);

  // 3. Storage Engine & Device Sync state
  const [engineVersion, setEngineVersion] = useState<string>();
  const [deviceId, setDeviceId] = useState<string>();
  const [schemaVersion, setSchemaVersion] = useState<number>();
  const [integrity, setIntegrity] = useState<IntegrityReport>();
  const [verification, setVerification] = useState<LedgerVerification>();
  const [localIntegrity, setLocalIntegrity] = useState<LocalIntegrityResult>();
  const [syncKey, setSyncKey] = useState<string>();
  const [envelopeOut, setEnvelopeOut] = useState('');
  const [envelopeIn, setEnvelopeIn] = useState('');
  const [backupPath, setBackupPath] = useState('0ledger-backup.sqlite3');
  const [engineBusy, setEngineBusy] = useState(false);

  // 4. Google Drive & Sheets Sync state (collapsible)
  const [showDrive, setShowDrive] = useState(false);
  const [clientId, setClientId] = useState('');
  const [driveEmail, setDriveEmail] = useState<string>();
  const [tokens, setTokens] = useState<DriveTokens>();
  const [driveLink, setDriveLink] = useState<DriveLink>();
  const [webViewLink, setWebViewLink] = useState<string>();
  const [driveBusy, setDriveBusy] = useState(false);
  const [diff, setDiff] = useState<SnapshotDiff>();
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot>();
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [archivePeriod, setArchivePeriod] = useState(monthKey());
  const [externalRef, setExternalRef] = useState('');
  const [gmailQuery, setGmailQuery] = useState(DEFAULT_GMAIL_QUERY);

  const hasGmailScope = Boolean(tokens?.scope?.includes('gmail.readonly'));

  // Sync company form when workspace changes
  useEffect(() => {
    setLegalName(bundle.company.legalName);
    setTradeName(bundle.company.tradeName ?? '');
    setGstin(bundle.company.gstin ?? '');
    setPan(bundle.company.pan ?? '');
    setStateName(bundle.company.state ?? '');
    setPincode(bundle.company.pincode ?? '');
    setAddress(bundle.company.address ?? '');
    setBooksBegin(bundle.company.booksBegin);
    setEnableTally(Boolean(bundle.company.settings.enableTally));
    setEnableCaPack(Boolean(bundle.company.settings.enableCaPack));
  }, [bundle]);

  const refreshLicense = useCallback(async () => {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LICENSE_STORAGE_KEY) : null;
    const state = await getLicenseState(stored ?? undefined, bundle.workspace.createdAt);
    setLicenseState(state);
  }, [bundle.workspace.createdAt]);

  const refreshDrive = useCallback(async () => {
    const db = getDb();
    const [storedClient, storedTokens, links] = await Promise.all([
      getDriveClientId(),
      getDriveTokens(),
      db.driveLinks.where('workspaceId').equals(workspaceId).toArray(),
    ]);
    setClientId(storedClient ?? '');
    setTokens(storedTokens);
    setDriveEmail(storedTokens?.email);
    setDriveLink(links.find((item) => item.kind === 'sheets'));
  }, [workspaceId]);

  const runBrowserIntegrity = useCallback(async () => {
    const db = getDb();
    const [ledgers, vouchers, lines, parties, attachments, auditEvents] = await Promise.all([
      db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
      db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
      db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
      db.parties.where('workspaceId').equals(workspaceId).toArray(),
      db.attachments.where('workspaceId').equals(workspaceId).toArray(),
      db.auditEvents.where('workspaceId').equals(workspaceId).toArray(),
    ]);
    const regularVouchers = vouchers.filter((v) => v.status === 'regular');
    const ledgerIds = new Set(ledgers.map((l) => l.id));
    const linesByVoucher = new Map<string, typeof lines>();
    for (const line of lines) {
      const group = linesByVoucher.get(line.voucherId) ?? [];
      group.push(line);
      linesByVoucher.set(line.voucherId, group);
    }

    const issues: string[] = [];
    for (const voucher of regularVouchers) {
      const vLines = linesByVoucher.get(voucher.id) ?? [];
      const sum = vLines.reduce((acc, l) => acc + l.amountMinor, 0);
      if (sum !== 0) {
        issues.push(`Voucher ${voucher.number} is unbalanced by ${sum} paise.`);
      }
      for (const l of vLines) {
        if (!ledgerIds.has(l.ledgerId)) {
          issues.push(`Voucher ${voucher.number} references missing ledger ${l.ledgerId}.`);
        }
      }
    }

    const tb = await trialBalance(db, workspaceId);
    if (!tb.balanced) {
      issues.push(
        `Trial balance difference detected (debits ${tb.totalDebitMinor}, credits ${tb.totalCreditMinor}).`,
      );
    }

    const result: LocalIntegrityResult = {
      ok: issues.length === 0,
      vouchersChecked: regularVouchers.length,
      ledgersCount: ledgers.length,
      partiesCount: parties.length,
      attachmentsCount: attachments.length,
      auditEventsCount: auditEvents.length,
      issues,
    };
    setLocalIntegrity(result);
    return result;
  }, [workspaceId]);

  useEffect(() => {
    void refreshLicense();
    void refreshDrive();
    if (native) {
      void Promise.all([
        nativeStore.engineVersion(),
        nativeStore.deviceId(),
        nativeStore.schemaVersion(),
      ])
        .then(([engine, device, schema]) => {
          setEngineVersion(engine);
          setDeviceId(device);
          setSchemaVersion(schema);
        })
        .catch((cause) => setError(errorMessage(cause)));
    } else {
      void runBrowserIntegrity();
    }
  }, [native, refreshLicense, refreshDrive, runBrowserIntegrity]);

  function notify(msg: string) {
    setError(undefined);
    setNotice(msg);
    onChanged?.(msg);
  }

  // --- Company Profile ---
  async function handleSaveCompany(event: FormEvent) {
    event.preventDefault();
    setSavingCompany(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await updateCompanyProfile(getDb(), bundle.company.id, {
        legalName,
        tradeName,
        gstin,
        pan,
        state: stateName,
        pincode,
        address,
        booksBegin,
        enableTally,
        enableCaPack,
      });
      notify('Company profile and workflow preferences updated.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingCompany(false);
    }
  }

  // --- License ---
  async function handleActivateLicense(event: FormEvent) {
    event.preventDefault();
    if (!licenseInput.trim()) return;
    setLicenseBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const payload = await verifyLicenseKey(licenseInput);
      if (!payload) {
        setError('Invalid or expired license key.');
        return;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LICENSE_STORAGE_KEY, licenseInput.trim());
      }
      setLicenseInput('');
      await refreshLicense();
      notify(`Activated ${payload.tier.replace('_', ' ')} edition for ${payload.licensee}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLicenseBusy(false);
    }
  }

  async function handleClearLicense() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LICENSE_STORAGE_KEY);
    }
    await refreshLicense();
    notify('License key removed. Reverted to default edition.');
  }

  async function handleGenerateDemoKey(tier: 'pro' | 'ca_practice') {
    const key = await createLicenseKey({
      licensee: tier === 'ca_practice' ? 'CA Practice Demo' : 'Owner Pro Demo',
      email: 'demo@0ledger.app',
      tier,
      issuedAt: new Date().toISOString().slice(0, 10),
      expiresAt: '2030-12-31',
      maxWorkspaces: tier === 'ca_practice' ? 100 : 10,
    });
    setLicenseInput(key);
    setNotice(`Generated demo ${tier.replace('_', ' ')} key. Click Activate key to apply.`);
  }

  // --- Engine ---
  async function runEngineAction(action: () => Promise<string | void>) {
    setEngineBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const msg = await action();
      if (msg) setNotice(msg);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setEngineBusy(false);
    }
  }

  // --- Google Drive ---
  async function withDriveToken<T>(
    action: (token: string) => Promise<T>,
    origins: string[] = DRIVE_ORIGINS,
  ): Promise<T> {
    await requestChromeOrigins(origins);
    const token = await getDriveAccessToken();
    if (!token) throw new Error('Connect Google Drive first.');
    return action(token);
  }

  async function handleConnectDrive(withGmail = false) {
    setDriveBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await requestChromeOrigins(withGmail ? GMAIL_ORIGINS : DRIVE_ORIGINS);
      const trimmed = clientId.trim();
      if (!trimmed) throw new Error('Enter your Google OAuth client ID first.');
      await saveDriveClientId(trimmed);
      if (typeof chrome === 'undefined' || !chrome.identity) {
        throw new Error(
          'Google Drive OAuth uses chrome.identity and requires the browser extension runtime. Use IMAP email sync and encrypted .0ledger backups in standalone web mode.',
        );
      }
      const pair = await createPkcePair();
      const state = randomUrlSafe(24);
      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl = buildAuthUrl({
        clientId: trimmed,
        redirectUri,
        challenge: pair.challenge,
        state,
        ...(withGmail ? { scopes: GMAIL_SCOPES } : {}),
      });
      const redirect = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true,
      });
      if (!redirect) throw new Error('Google authorization was cancelled.');
      const result = parseAuthRedirect(redirect);
      if (result.state !== state) throw new Error('Google authorization state mismatch.');
      const exchanged = await exchangeAuthorizationCode({
        clientId: trimmed,
        code: result.code,
        verifier: pair.verifier,
        redirectUri,
      });
      const user = await fetchUserInfo(exchanged.accessToken);
      const nextTokens: DriveTokens = {
        ...exchanged,
        ...(user.email ? { email: user.email } : {}),
      };
      await saveDriveTokens(nextTokens);
      setTokens(nextTokens);
      setDriveEmail(user.email);
      if (withGmail) {
        notify('Gmail read-only access enabled.');
      } else {
        const synced = await syncWorkspaceToDrive(getDb(), workspaceId, {
          token: nextTokens.accessToken,
          force: true,
        });
        setWebViewLink(synced.webViewLink);
        notify(`Connected${user.email ? ` as ${user.email}` : ''} and synced workbook.`);
      }
      await refreshDrive();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleDisconnectDrive() {
    setDriveBusy(true);
    setError(undefined);
    try {
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token) await revokeToken(token).catch(() => undefined);
      await clearDriveTokens();
      setTokens(undefined);
      setDriveEmail(undefined);
      setDiff(undefined);
      setSnapshot(undefined);
      notify('Google Drive disconnected.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleDriveSyncNow() {
    setDriveBusy(true);
    setError(undefined);
    try {
      const res = await withDriveToken((token) =>
        syncWorkspaceToDrive(getDb(), workspaceId, { token, force: true }),
      );
      setWebViewLink(res.webViewLink);
      notify(res.skipped ? 'Workbook already up to date.' : `Synced ${res.sheets} sheets to Drive.`);
      await refreshDrive();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleDriveCompare() {
    setDriveBusy(true);
    setError(undefined);
    try {
      const res = await withDriveToken(async (token) => {
        const location = await ensureDriveLocation(getDb(), workspaceId, token);
        const remote = await readDriveSnapshot(token, location.workbook.id);
        const comparison = await diffDriveSnapshot(getDb(), workspaceId, remote);
        return { remote, comparison, webViewLink: location.workbook.webViewLink };
      });
      setSnapshot(res.remote);
      setDiff(res.comparison);
      setWebViewLink(res.webViewLink);
      setConfirmRestore(false);
      setNotice(
        `Drive comparison: ${res.comparison.changed} changed, ${res.comparison.remoteOnly} Drive only, ${res.comparison.localOnly} local only.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleReadExternalSheet() {
    setDriveBusy(true);
    setError(undefined);
    try {
      const fileId = parseDriveFileId(externalRef);
      if (!fileId) throw new Error('Paste a valid Google Sheets URL or file ID.');
      const res = await withDriveToken(async (token) => {
        const remote = await readDriveSnapshot(token, fileId);
        const comparison = await diffDriveSnapshot(getDb(), workspaceId, remote);
        return { remote, comparison };
      });
      setSnapshot(res.remote);
      setDiff(res.comparison);
      setConfirmRestore(false);
      setNotice(
        `External workbook inspected: ${res.comparison.changed} changed, ${res.comparison.remoteOnly} remote only.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleRestoreDrive() {
    if (!snapshot) return;
    if (restoreMode === 'replace' && !confirmRestore) {
      setError('Confirm replace mode before overwriting local workspace data.');
      return;
    }
    setDriveBusy(true);
    setError(undefined);
    try {
      const res = await restoreDriveSnapshot(getDb(), workspaceId, snapshot, restoreMode);
      setConfirmRestore(false);
      setDiff(undefined);
      setSnapshot(undefined);
      notify(`Restored ${res.restored} records from Google Drive (${res.mode}).`);
      await refreshDrive();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleArchiveMonth() {
    setDriveBusy(true);
    setError(undefined);
    try {
      if (!/^\d{4}-\d{2}$/.test(archivePeriod)) throw new Error('Choose a valid YYYY-MM month.');
      const res = await withDriveToken((token) =>
        archiveMonthToDrive(getDb(), workspaceId, archivePeriod, { token }),
      );
      notify(`Archived ${res.file.name} to Google Drive.`);
      await refreshDrive();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  async function handleSyncGmailApi() {
    setDriveBusy(true);
    setError(undefined);
    try {
      const res = await withDriveToken(
        (token) =>
          syncGmailStatements(getDb(), workspaceId, {
            accessToken: token,
            query: gmailQuery.trim() || DEFAULT_GMAIL_QUERY,
            maxResults: 25,
          }),
        GMAIL_ORIGINS,
      );
      const lines = res.batches.reduce((sum, b) => sum + b.batch.totalLines, 0);
      notify(`Gmail API: scanned ${res.messages} messages, staged ${lines} statement lines.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDriveBusy(false);
    }
  }

  const tierTitle = !licenseState
    ? 'Loading...'
    : licenseState.isTrial
      ? 'Pro Trial (1 Year)'
      : licenseState.tier === 'ca_practice'
        ? 'CA Practice'
        : licenseState.tier === 'pro'
          ? 'Pro Active'
          : 'Community Free';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
          Workspace settings
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Manage company tax identity, product edition, local storage integrity, and optional cloud
          mirrors.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      {/* Section 0: Companies & Workspaces */}
      {(onAddCompany || workspaces.length > 0) ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Companies on this device
                </h3>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Each company keeps its own separate ledger, bank accounts, rules, and reports.
              </p>
            </div>
            {onAddCompany ? (
              <button
                type="button"
                onClick={onAddCompany}
                className="inline-flex items-center justify-center gap-1.5 self-start rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add new company</span>
              </button>
            ) : null}
          </div>

          {workspaces.length > 1 && onSelectWorkspace ? (
            <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Switch active company ({workspaces.length} available)
              </span>
              <select
                aria-label="Switch active company"
                value={bundle.workspace.id}
                onChange={(e) => onSelectWorkspace(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none sm:w-72 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Section 1: Company Profile */}
      <form
        onSubmit={handleSaveCompany}
        className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              Company profile & optional workflows
            </h3>
          </div>
          <span className="num-tabular text-xs text-slate-500 dark:text-slate-400">
            {bundle.company.currency} · FY starts month {bundle.company.settings.fyStartMonth}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Legal name
            </span>
            <input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              required
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Registered business or proprietor name printed on reports and statements.
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Trade name (optional)
            </span>
            <input
              value={tradeName}
              onChange={(e) => setTradeName(e.target.value)}
              placeholder="Operating brand name"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Customer-facing brand name if different from your legal name.
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              GSTIN (optional · 15 chars)
            </span>
            <input
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="27ABCDE1234F1Z5"
              maxLength={15}
              className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              15-character Goods & Services Tax number. Adding a GSTIN unlocks GSTR-2B
              reconciliation and GST invoice fields; leave blank if unregistered.
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              PAN (optional · 10 chars)
            </span>
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="ABCDE1234F"
              maxLength={10}
              className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm uppercase text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              10-character Permanent Account Number used for income tax and TDS filings.
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              State
            </span>
            <input
              value={stateName}
              onChange={(e) => setStateName(e.target.value)}
              placeholder="Maharashtra"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Home state for determining local vs inter-state billing when GST is active.
            </span>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Books begin
            </span>
            <input
              type="date"
              value={booksBegin}
              onChange={(e) => setBooksBegin(e.target.value)}
              required
              className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Start of your accounting year (typically April 1). Earlier balances belong in account
              opening balances.
            </span>
          </label>
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Registered address
            </span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street, city"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Pincode
            </span>
            <input
              value={pincode}
              onChange={(e) => setPincode(e.target.value)}
              placeholder="400001"
              maxLength={6}
              className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
        </div>

        {/* Optional Workflows: Tally & CA Pack */}
        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="mb-3">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              Optional accounting workflows
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              Kept off by default to keep day-to-day bookkeeping clean. Enable only what your
              business or accountant uses.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-3 transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
              <input
                type="checkbox"
                checked={enableTally}
                onChange={(e) => setEnableTally(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>
                <span className="block text-xs font-medium text-slate-800 dark:text-slate-200">
                  Enable Tally integration
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
                  Unlocks Tally XML export/import, readiness checks, and the Tally Prime live
                  bridge in Export & backup.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-3 transition hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
              <input
                type="checkbox"
                checked={enableCaPack}
                onChange={(e) => setEnableCaPack(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>
                <span className="block text-xs font-medium text-slate-800 dark:text-slate-200">
                  Enable CA Pack & month-end close
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
                  Unlocks the monthly close checklist, Ask CA queue, and CA handover pack
                  generator on your Overview.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={savingCompany}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {savingCompany ? 'Saving...' : 'Save company profile'}
          </button>
        </div>
      </form>

      {/* Section 2: Product Edition & License */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                Product edition & license
              </h3>
            </div>
            {licenseState ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-800 dark:text-slate-200">{tierTitle}</span>
                {licenseState.licensee ? ` · ${licenseState.licensee}` : ''}
                {licenseState.isTrial && licenseState.trialDaysRemaining !== undefined
                  ? ` · ${licenseState.trialDaysRemaining} trial days remaining`
                  : ''}
                {licenseState.expiresAt ? ` · Valid until ${licenseState.expiresAt}` : ''}
              </p>
            ) : null}
          </div>

          {licenseState && !licenseState.isTrial && licenseState.tier !== 'community' ? (
            <button
              type="button"
              onClick={() => void handleClearLicense()}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Clear license key
            </button>
          ) : null}
        </div>

        <form onSubmit={handleActivateLicense} className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={licenseInput}
              onChange={(e) => setLicenseInput(e.target.value)}
              placeholder="Paste offline license key (0L-PRO-... or 0L-CA_PRACTICE-...)"
              className="num-tabular flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={licenseBusy || !licenseInput.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {licenseBusy ? 'Verifying...' : 'Activate key'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-500 dark:text-slate-400">Try locally:</span>
            <button
              type="button"
              onClick={() => void handleGenerateDemoKey('pro')}
              className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Generate demo Pro key
            </button>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <button
              type="button"
              onClick={() => void handleGenerateDemoKey('ca_practice')}
              className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Generate demo CA Practice key
            </button>
          </div>
        </form>

        {licenseState ? (
          <div className="mt-4 grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-slate-800">
            {FEATURE_LABELS.map((item) => {
              const enabled = licenseState.enabledFeatures.includes(item.id);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-1 text-xs"
                >
                  <span className="text-slate-700 dark:text-slate-300">{item.label}</span>
                  <span
                    className={
                      enabled
                        ? 'inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-400 dark:text-slate-500'
                    }
                  >
                    {enabled ? <Check className="h-3.5 w-3.5" /> : null}
                    <span>{enabled ? 'Enabled' : 'Locked'}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {/* Section 3: Storage Engine, Integrity & Device Sync */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                {native ? 'Portable SQLite engine & device sync' : 'Local storage & ledger integrity'}
              </h3>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {native
                ? 'SQLite is the authoritative store on this device. Pair mobile or desktop devices using sealed sync envelopes.'
                : 'Your books live locally in IndexedDB on this browser. Run double-entry integrity checks at any time.'}
            </p>
          </div>
          {!native ? (
            <button
              type="button"
              disabled={engineBusy}
              onClick={() =>
                void runEngineAction(async () => {
                  const res = await runBrowserIntegrity();
                  return res.ok
                    ? `Verified ${res.vouchersChecked} regular voucher(s) — trial balance is in equilibrium.`
                    : `Found ${res.issues.length} ledger integrity issue(s).`;
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Run integrity check</span>
            </button>
          ) : null}
        </div>

        {!native && localIntegrity ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-5 dark:border-slate-800">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Status</div>
                <div
                  className={`mt-0.5 text-sm font-semibold ${
                    localIntegrity.ok
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {localIntegrity.ok ? 'Balanced' : 'Attention'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Vouchers</div>
                <div className="num-tabular mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {localIntegrity.vouchersChecked}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Ledgers</div>
                <div className="num-tabular mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {localIntegrity.ledgersCount}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Parties</div>
                <div className="num-tabular mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {localIntegrity.partiesCount}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Audit events</div>
                <div className="num-tabular mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {localIntegrity.auditEventsCount}
                </div>
              </div>
            </div>

            {localIntegrity.issues.length > 0 ? (
              <ul className="space-y-1 text-xs text-rose-700 dark:text-rose-300">
                {localIntegrity.issues.map((issue, idx) => (
                  <li key={`${issue}-${idx}`}>{issue}</li>
                ))}
              </ul>
            ) : null}

            <p className="text-xs text-slate-500 dark:text-slate-400">
              Native SQLite mirroring and encrypted device-to-device sync envelopes activate
              automatically inside the Tauri desktop app. To move books between browsers, use{' '}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Export & backup
              </span>
              .
            </p>
          </div>
        ) : null}

        {native ? (
          <div className="space-y-5 border-t border-slate-100 pt-4 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Engine version</div>
                <div className="num-tabular mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {engineVersion ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Schema version</div>
                <div className="num-tabular mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {schemaVersion ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Device ID</div>
                <div className="num-tabular mt-0.5 truncate text-xs font-medium text-slate-900 dark:text-slate-100">
                  {deviceId ?? '—'}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={engineBusy}
                onClick={() =>
                  void runEngineAction(async () => {
                    const summary = await migrateWorkspaceToSqlite(getDb(), workspaceId);
                    return `Migrated ${summary.workspaces} workspace(s), ${summary.ledgers} ledgers, ${summary.vouchers} vouchers.`;
                  })
                }
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Migrate to SQLite
              </button>
              <button
                type="button"
                disabled={engineBusy}
                onClick={() =>
                  void runEngineAction(async () => {
                    const res = await verifyWorkspace(getDb(), workspaceId);
                    setVerification(res);
                    return res.ok
                      ? 'SQLite and local cache match.'
                      : `${res.issues.length} divergence(s) found.`;
                  })
                }
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Verify SQLite vs cache
              </button>
              <button
                type="button"
                disabled={engineBusy}
                onClick={() =>
                  void runEngineAction(async () => {
                    const summary = await mirrorAllWorkspaces(getDb());
                    return summary
                      ? `Mirrored ${summary.workspaces} workspace(s), ${summary.vouchers} vouchers.`
                      : 'Native store unavailable.';
                  })
                }
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Mirror all workspaces
              </button>
              <button
                type="button"
                disabled={engineBusy}
                onClick={() =>
                  void runEngineAction(async () => {
                    const report = await nativeStore.integrityCheck(workspaceId);
                    setIntegrity(report);
                    return report.ok
                      ? `Verified ${report.checkedVouchers} vouchers and ${report.checkedAuditEvents} audit events.`
                      : `${report.issues.length} integrity issue(s) found.`;
                  })
                }
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Run audit-chain integrity
              </button>
            </div>

            {integrity ? (
              <div className="text-xs">
                <span
                  className={
                    integrity.ok
                      ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                      : 'font-semibold text-rose-700 dark:text-rose-400'
                  }
                >
                  {integrity.ok ? 'Audit-chain OK' : 'Integrity issues found'}
                </span>
                {integrity.issues.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-rose-700 dark:text-rose-300">
                    {integrity.issues.map((issue, idx) => (
                      <li key={`${issue.code}-${idx}`}>
                        {issue.code}: {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {verification ? (
              <div className="text-xs">
                <span
                  className={
                    verification.ok
                      ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                      : 'font-semibold text-rose-700 dark:text-rose-400'
                  }
                >
                  {verification.ok ? 'SQLite matches cache' : 'SQLite divergence detected'}
                </span>
                {verification.issues.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-rose-700 dark:text-rose-300">
                    {verification.issues.map((issue, idx) => (
                      <li key={`${issue}-${idx}`}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {/* SQLite snapshot backup */}
            <div className="flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row dark:border-slate-800">
              <input
                value={backupPath}
                onChange={(e) => setBackupPath(e.target.value)}
                placeholder="0ledger-backup.sqlite3"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={engineBusy || !backupPath.trim()}
                onClick={() =>
                  void runEngineAction(async () => {
                    await nativeStore.backupTo(backupPath.trim());
                    return `SQLite snapshot written to ${backupPath.trim()}.`;
                  })
                }
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Back up SQLite snapshot
              </button>
            </div>

            {/* Device-to-device sealed sync */}
            <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Device-to-device sealed sync
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={engineBusy}
                  onClick={() =>
                    void runEngineAction(async () => {
                      const key = await nativeStore.generateSyncKey();
                      setSyncKey(key);
                      return 'Generated new pairing sync key.';
                    })
                  }
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Generate sync key
                </button>
                <button
                  type="button"
                  disabled={engineBusy || !syncKey}
                  onClick={() =>
                    void runEngineAction(async () => {
                      const env = await nativeStore.exportSyncEnvelope(syncKey as string, 0);
                      setEnvelopeOut(env);
                      return 'Exported sealed sync envelope.';
                    })
                  }
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Export changes
                </button>
                <button
                  type="button"
                  disabled={engineBusy || !syncKey || !envelopeIn.trim()}
                  onClick={() =>
                    void runEngineAction(async () => {
                      const summary: ApplySummary = await nativeStore.importSyncEnvelope(
                        syncKey as string,
                        envelopeIn.trim(),
                      );
                      return `Applied ${summary.applied}, ignored ${summary.ignored}, skipped ${summary.skipped}.`;
                    })
                  }
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  Apply received changes
                </button>
              </div>
              {syncKey ? (
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                    Pairing sync key
                  </span>
                  <input
                    value={syncKey}
                    readOnly
                    className="num-tabular w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  />
                </label>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                    Outgoing envelope
                  </span>
                  <textarea
                    value={envelopeOut}
                    readOnly
                    rows={3}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                    Incoming envelope
                  </span>
                  <textarea
                    value={envelopeIn}
                    onChange={(e) => setEnvelopeIn(e.target.value)}
                    rows={3}
                    placeholder="Paste sealed envelope from paired device..."
                    className="w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* Section 4: Collapsible Google Drive, Sheets & Gmail Mirror */}
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        <button
          type="button"
          onClick={() => setShowDrive((open) => !open)}
          className="flex w-full items-center justify-between px-5 py-4 text-left"
        >
          <div className="flex items-center gap-2.5">
            <Cloud className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <div>
              <div className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                Google Drive & Sheets mirror (optional)
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {tokens
                  ? `Connected${driveEmail ? ` as ${driveEmail}` : ''}`
                  : 'Mirror your workbook to Google Sheets, compare diffs, or archive monthly XLSX.'}
              </div>
            </div>
          </div>
          {showDrive ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
        </button>

        {showDrive ? (
          <div className="space-y-5 border-t border-slate-100 px-5 py-5 dark:border-slate-800">
            {!hasChromeIdentity ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Google Drive PKCE OAuth uses <span className="font-mono">chrome.identity</span> in
                the browser extension runtime. In standalone web mode, use{' '}
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Email & IMAP
                </span>{' '}
                for automated statement sync and{' '}
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Export & backup
                </span>{' '}
                for Excel workbooks and encrypted backups.
              </p>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block flex-1">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Google OAuth client ID
                </span>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="1234567890-abc.apps.googleusercontent.com"
                  disabled={Boolean(tokens)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>

              {tokens ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={driveBusy}
                    onClick={() => void handleDriveSyncNow()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${driveBusy ? 'animate-spin' : ''}`} />
                    <span>Sync now</span>
                  </button>
                  <button
                    type="button"
                    disabled={driveBusy}
                    onClick={() => void handleDriveCompare()}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    Compare
                  </button>
                  <button
                    type="button"
                    disabled={driveBusy}
                    onClick={() => void handleDisconnectDrive()}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={driveBusy}
                  onClick={() => void handleConnectDrive(false)}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {driveBusy ? 'Connecting...' : 'Connect Google Drive'}
                </button>
              )}
            </div>

            {driveLink ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  File ID: <span className="font-mono">{driveLink.fileId}</span>
                </span>
                {driveLink.lastSyncedAt ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Last sync {driveLink.lastSyncedAt.slice(0, 16).replace('T', ' ')}</span>
                  </>
                ) : null}
                {webViewLink ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <a
                      href={webViewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <span>Open in Drive</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </>
                ) : null}
              </div>
            ) : null}

            {/* External Workbook & Monthly Archive & Optional Gmail API */}
            <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 lg:grid-cols-3 dark:border-slate-800">
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Compare external Sheets URL
                </div>
                <input
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  disabled={driveBusy || !tokens}
                  onClick={() => void handleReadExternalSheet()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Read external workbook
                </button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Monthly XLSX archive
                </div>
                <input
                  type="month"
                  value={archivePeriod}
                  onChange={(e) => setArchivePeriod(e.target.value)}
                  className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  disabled={driveBusy || !tokens}
                  onClick={() => void handleArchiveMonth()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Archive month to Drive
                </button>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Gmail API read-only sync
                </div>
                <input
                  value={gmailQuery}
                  onChange={(e) => setGmailQuery(e.target.value)}
                  disabled={!hasGmailScope}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                {hasGmailScope ? (
                  <button
                    type="button"
                    disabled={driveBusy}
                    onClick={() => void handleSyncGmailApi()}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    Import Gmail statements
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={driveBusy || !tokens}
                    onClick={() => void handleConnectDrive(true)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    Enable Gmail read-only
                  </button>
                )}
              </div>
            </div>

            {/* Diff & Restore table */}
            {diff ? (
              <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Drive snapshot comparison
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-2 pr-4 font-medium">Table</th>
                        <th className="px-3 py-2 text-right font-medium">Drive</th>
                        <th className="px-3 py-2 text-right font-medium">Local</th>
                        <th className="px-3 py-2 text-right font-medium">Changed</th>
                        <th className="px-3 py-2 text-right font-medium">Drive only</th>
                        <th className="py-2 pl-3 text-right font-medium">Local only</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {Object.entries(diff.tables)
                        .filter(
                          ([, row]) => row.changed > 0 || row.remoteOnly > 0 || row.localOnly > 0,
                        )
                        .map(([table, row]) => (
                          <tr key={table}>
                            <td className="py-2 pr-4 font-medium text-slate-800 dark:text-slate-200">
                              {table}
                            </td>
                            <td className="num-tabular px-3 py-2 text-right">{row.remote}</td>
                            <td className="num-tabular px-3 py-2 text-right">{row.local}</td>
                            <td className="num-tabular px-3 py-2 text-right">{row.changed}</td>
                            <td className="num-tabular px-3 py-2 text-right">{row.remoteOnly}</td>
                            <td className="num-tabular py-2 pl-3 text-right">{row.localOnly}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={restoreMode}
                    onChange={(e) => {
                      setRestoreMode(e.target.value as RestoreMode);
                      setConfirmRestore(false);
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="merge">Merge Drive into local</option>
                    <option value="replace">Replace local workspace</option>
                  </select>
                  {restoreMode === 'replace' ? (
                    <label className="flex items-center gap-1.5 text-xs text-rose-700 dark:text-rose-300">
                      <input
                        type="checkbox"
                        checked={confirmRestore}
                        onChange={(e) => setConfirmRestore(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-rose-600"
                      />
                      <span>Confirm overwriting local rows</span>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    disabled={driveBusy}
                    onClick={() => void handleRestoreDrive()}
                    className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Restore from Drive
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
