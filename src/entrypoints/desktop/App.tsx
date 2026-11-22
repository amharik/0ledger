import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Building2,
  CheckCircle2,
  FileUp,
  FolderSync,
  LayoutDashboard,
  Mail,
  Menu,
  Moon,
  Plus,
  Sun,
  X,
} from 'lucide-react';
import { getDb } from '@/core/db/db';
import { listParties, listStockItems, type PartyView } from '@/core/db/master-service';
import { bootstrapSqlite } from '@/core/db/sqlite-bootstrap';
import { listExceptionQueue } from '@/core/autopilot';
import type { StockItem } from '@/core/model';
import { useWorkspace } from '@/ui/workspace';
import { OnboardingWizard } from '@/ui/OnboardingWizard';
import { OverviewDashboard, type OverviewNavigateTarget } from '@/ui/OverviewDashboard';
import { QuickEntryDrawer } from '@/ui/QuickEntryDrawer';
import { MoneyInbox } from '@/ui/MoneyInbox';
import { LedgerRegister } from '@/ui/LedgerRegister';
import { ReconciliationPanel } from '@/ui/ReconciliationPanel';
import { StatementImport } from '@/ui/StatementImport';
import { EmailImportPanel } from '@/ui/EmailImportPanel';
import { FolderVaultPanel } from '@/ui/FolderVaultPanel';
import { ImapSettingsPanel } from '@/ui/ImapSettingsPanel';
import { ReportsPanel, type FinancialReportTab } from '@/ui/ReportsPanel';
import { Gstr2bReconPanel } from '@/ui/Gstr2bReconPanel';
import { StockReport } from '@/ui/StockReport';
import ChartOfAccounts from '@/ui/ChartOfAccounts';
import { ClassificationRulesPanel } from '@/ui/ClassificationRulesPanel';
import StockItemsPanel from '@/ui/StockItemsPanel';
import { BooksExportPanel } from '@/ui/BooksExportPanel';
import { WorkspaceSettingsPanel } from '@/ui/WorkspaceSettingsPanel';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

type Section = 'overview' | 'activity' | 'reports' | 'books';
type ActivityTab = 'inbox' | 'ledger' | 'reconcile' | 'import';
type ImportSourceMode = 'email' | 'files' | 'folder';
type ReportTab = FinancialReportTab | 'gstr2b' | 'stock';
type BooksTab = 'accounts' | 'rules' | 'stock-items' | 'imap' | 'export' | 'settings';

const THEME_STORAGE_KEY = '0ledger-theme';

const SECTION_LABELS: Record<Section, string> = {
  overview: 'Overview',
  activity: 'Activity',
  reports: 'Reports',
  books: 'Books',
};

const ACTIVITY_TABS: Array<{ id: ActivityTab; label: string }> = [
  { id: 'inbox', label: 'Money inbox' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'reconcile', label: 'Reconcile' },
  { id: 'import', label: 'Import' },
];

const REPORT_TABS: Array<{ id: ReportTab; label: string }> = [
  { id: 'pnl', label: 'Profit & Loss' },
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'trial', label: 'Trial Balance' },
  { id: 'parties', label: 'Parties & Aging' },
  { id: 'gstr2b', label: 'GST (2B)' },
  { id: 'stock', label: 'Stock' },
];

const BOOKS_TABS: Array<{ id: BooksTab; label: string }> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'rules', label: 'Rules' },
  { id: 'stock-items', label: 'Stock items' },
  { id: 'imap', label: 'Email & IMAP' },
  { id: 'export', label: 'Export & backup' },
  { id: 'settings', label: 'Settings' },
];

function isActivityTab(value: string | undefined): value is ActivityTab {
  return value === 'inbox' || value === 'ledger' || value === 'reconcile' || value === 'import';
}

function isReportTab(value: string | undefined): value is ReportTab {
  return (
    value === 'pnl' ||
    value === 'balance' ||
    value === 'trial' ||
    value === 'parties' ||
    value === 'gstr2b' ||
    value === 'stock'
  );
}

function isBooksTab(value: string | undefined): value is BooksTab {
  return (
    value === 'accounts' ||
    value === 'rules' ||
    value === 'stock-items' ||
    value === 'imap' ||
    value === 'export' ||
    value === 'settings'
  );
}

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const { bundle, workspaces, loading, error, reload, selectWorkspace } = useWorkspace();

  const [section, setSection] = useState<Section>('overview');
  const [activityTab, setActivityTab] = useState<ActivityTab>('inbox');
  const [importMode, setImportMode] = useState<ImportSourceMode>('email');
  const [reportTab, setReportTab] = useState<ReportTab>('pnl');
  const [booksTab, setBooksTab] = useState<BooksTab>('accounts');

  const [showNewCompany, setShowNewCompany] = useState(false);
  const [entryDrawerOpen, setEntryDrawerOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);

  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [parties, setParties] = useState<PartyView[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [pendingInboxCount, setPendingInboxCount] = useState(0);

  const workspaceId = bundle?.workspace.id;
  const ledgerList = bundle?.ledgers ?? [];

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Auto-dismiss toast banner
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Bootstrap native SQLite mirror when available
  useEffect(() => {
    void bootstrapSqlite().then(() => setRefreshToken((value) => value + 1));
  }, []);

  // Load workspace master lists & live inbox badge count
  useEffect(() => {
    if (!workspaceId) return;
    const db = getDb();
    let cancelled = false;
    void Promise.all([
      listParties(db, workspaceId),
      listStockItems(db, workspaceId),
      listExceptionQueue(db, workspaceId).catch(() => []),
    ]).then(([nextParties, nextStock, nextQueue]) => {
      if (cancelled) return;
      setParties(nextParties);
      setStockItems(nextStock);
      setPendingInboxCount(nextQueue.length);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken]);

  const handleDataChanged = useCallback(
    (message: string) => {
      setNotice(message);
      setRefreshToken((v) => v + 1);
      void reload();
    },
    [reload],
  );

  const handleNavigate = useCallback((target: OverviewNavigateTarget) => {
    setSection(target.section);
    if (target.section === 'activity' && isActivityTab(target.subTab)) {
      setActivityTab(target.subTab);
    } else if (target.section === 'reports' && isReportTab(target.subTab)) {
      setReportTab(target.subTab);
    } else if (target.section === 'books' && isBooksTab(target.subTab)) {
      setBooksTab(target.subTab);
    }
    setMobileMenuOpen(false);
  }, []);

  const currentSubLabel =
    section === 'activity'
      ? ACTIVITY_TABS.find((t) => t.id === activityTab)?.label
      : section === 'reports'
        ? REPORT_TABS.find((t) => t.id === reportTab)?.label
        : section === 'books'
          ? BOOKS_TABS.find((t) => t.id === booksTab)?.label
          : undefined;

  // Onboarding or Create Company view
  if (!loading && (!bundle || showNewCompany)) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-slate-900 dark:bg-[#0B0F19] dark:text-slate-50">
        <header className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">
            0ledger
          </div>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label="Toggle color theme"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-[#111827] dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </header>
        <main className="mx-auto max-w-5xl px-4 pb-16 pt-4 sm:px-6">
          <OnboardingWizard
            onCompleted={(newId) => {
              setShowNewCompany(false);
              setSection('overview');
              void selectWorkspace(newId);
              setRefreshToken((v) => v + 1);
            }}
            onCancel={bundle ? () => setShowNewCompany(false) : undefined}
          />
        </main>
      </div>
    );
  }

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between">
      <div>
        {/* Wordmark */}
        <div className="flex h-14 items-center justify-between border-b border-slate-200 px-5 dark:border-slate-800">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">
            0ledger
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Company switcher */}
        {bundle ? (
          <div className="border-b border-slate-200 px-4 py-3.5 dark:border-slate-800">
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              <Building2 className="h-3.5 w-3.5" />
              <span>Company</span>
            </label>
            <select
              aria-label="Active company"
              value={bundle.workspace.id}
              onChange={(event) => {
                setShowNewCompany(false);
                void selectWorkspace(event.target.value);
                setMobileMenuOpen(false);
              }}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-medium text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setShowNewCompany(true);
                setMobileMenuOpen(false);
              }}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add company</span>
            </button>
          </div>
        ) : null}

        {/* 4 Outcome-Driven Destinations */}
        <nav aria-label="Primary navigation" className="space-y-1 px-3 py-4">
          <button
            type="button"
            onClick={() => {
              setSection('overview');
              setMobileMenuOpen(false);
            }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              section === 'overview'
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
            }`}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            <span>Overview</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSection('activity');
              setMobileMenuOpen(false);
            }}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
              section === 'activity'
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
            }`}
          >
            <span className="flex items-center gap-3">
              <ArrowLeftRight className="h-4 w-4 shrink-0" />
              <span>Activity</span>
            </span>
            {pendingInboxCount > 0 ? (
              <span className="num-tabular text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                {pendingInboxCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => {
              setSection('reports');
              setMobileMenuOpen(false);
            }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              section === 'reports'
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
            }`}
          >
            <BarChart3 className="h-4 w-4 shrink-0" />
            <span>Reports</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSection('books');
              setMobileMenuOpen(false);
            }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              section === 'books'
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100'
            }`}
          >
            <BookOpen className="h-4 w-4 shrink-0" />
            <span>Books</span>
          </button>
        </nav>
      </div>

      {/* Footer: Theme toggle + local-first note */}
      <div className="space-y-3 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800/60"
        >
          <span>{theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</span>
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
        <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
          Stored on this device
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#F8FAFC] text-slate-900 dark:bg-[#0B0F19] dark:text-slate-50">
      {/* Desktop Left Sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-[#111827]">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/40 backdrop-blur-[1px]"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-[80vw] bg-white shadow-xl dark:bg-[#111827]">
            {sidebarContent}
          </aside>
        </div>
      ) : null}

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Header Bar (56px) */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-8 dark:border-slate-800 dark:bg-[#111827]/90">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {bundle ? (
                <>
                  <span className="hidden truncate text-slate-500 sm:inline dark:text-slate-400">
                    {bundle.workspace.name}
                  </span>
                  <span className="hidden text-slate-300 sm:inline dark:text-slate-600">/</span>
                </>
              ) : null}
              <span className="font-display font-semibold text-slate-900 dark:text-slate-50">
                {SECTION_LABELS[section]}
              </span>
              {currentSubLabel ? (
                <>
                  <span className="text-slate-300 dark:text-slate-600">/</span>
                  <span className="truncate text-slate-600 dark:text-slate-300">
                    {currentSubLabel}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          {bundle ? (
            <button
              type="button"
              onClick={() => setEntryDrawerOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-xs transition hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              <span>New entry</span>
            </button>
          ) : null}
        </header>

        {/* Sub-tab bar for Activity, Reports, and Books */}
        {bundle && section !== 'overview' ? (
          <div className="border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8 dark:border-slate-800 dark:bg-[#111827]">
            <div className="mx-auto flex max-w-6xl gap-6 overflow-x-auto">
              {section === 'activity'
                ? ACTIVITY_TABS.map((tab) => {
                    const active = activityTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActivityTab(tab.id)}
                        className={`relative shrink-0 py-3 text-sm font-medium transition ${
                          active
                            ? 'text-indigo-600 dark:text-indigo-400'
                            : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <span>{tab.label}</span>
                          {tab.id === 'inbox' && pendingInboxCount > 0 ? (
                            <span className="num-tabular text-xs font-semibold">
                              ({pendingInboxCount})
                            </span>
                          ) : null}
                        </span>
                        {active ? (
                          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-600 dark:bg-indigo-400" />
                        ) : null}
                      </button>
                    );
                  })
                : null}

              {section === 'reports'
                ? REPORT_TABS.map((tab) => {
                    const active = reportTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setReportTab(tab.id)}
                        className={`relative shrink-0 py-3 text-sm font-medium transition ${
                          active
                            ? 'text-indigo-600 dark:text-indigo-400'
                            : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                        }`}
                      >
                        {tab.label}
                        {active ? (
                          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-600 dark:bg-indigo-400" />
                        ) : null}
                      </button>
                    );
                  })
                : null}

              {section === 'books'
                ? BOOKS_TABS.map((tab) => {
                    const active = booksTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setBooksTab(tab.id)}
                        className={`relative shrink-0 py-3 text-sm font-medium transition ${
                          active
                            ? 'text-indigo-600 dark:text-indigo-400'
                            : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                        }`}
                      >
                        {tab.label}
                        {active ? (
                          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-600 dark:bg-indigo-400" />
                        ) : null}
                      </button>
                    );
                  })
                : null}
            </div>
          </div>
        ) : null}

        {/* Workspace Canvas */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {error ? (
            <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="py-20 text-center text-sm text-slate-500 dark:text-slate-400">
              Loading your ledger...
            </div>
          ) : null}

          {bundle ? (
            <ErrorBoundary fallbackTitle="Something went wrong rendering this view">
              {section === 'overview' ? (
                <OverviewDashboard
                  workspaceId={bundle.workspace.id}
                  ledgers={ledgerList}
                  refreshToken={refreshToken}
                  onChanged={handleDataChanged}
                  onNavigate={handleNavigate}
                  onOpenNewEntry={() => setEntryDrawerOpen(true)}
                />
              ) : null}

              {section === 'activity' ? (
                <>
                  {activityTab === 'inbox' ? (
                    <MoneyInbox
                      workspaceId={bundle.workspace.id}
                      ledgers={ledgerList}
                      refreshToken={refreshToken}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {activityTab === 'ledger' ? (
                    <LedgerRegister
                      workspaceId={bundle.workspace.id}
                      ledgers={ledgerList}
                      refreshToken={refreshToken}
                      onChanged={handleDataChanged}
                      onOpenNewEntry={() => setEntryDrawerOpen(true)}
                    />
                  ) : null}
                  {activityTab === 'reconcile' ? (
                    <ReconciliationPanel
                      workspaceId={bundle.workspace.id}
                      ledgers={ledgerList}
                      refreshToken={refreshToken}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {activityTab === 'import' ? (
                    <div className="space-y-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
                            Import transactions
                          </h2>
                          <p className="text-sm text-slate-500 dark:text-slate-400">
                            Pull bank alerts, statements, and bills automatically from IMAP email,
                            or upload statement files directly.
                          </p>
                        </div>
                        <div
                          role="tablist"
                          aria-label="Import source"
                          className="inline-flex self-start rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-[#111827]"
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={importMode === 'email'}
                            onClick={() => setImportMode('email')}
                            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                              importMode === 'email'
                                ? 'bg-indigo-600 text-white'
                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                            }`}
                          >
                            <Mail className="h-3.5 w-3.5" />
                            <span>Email (IMAP)</span>
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={importMode === 'files'}
                            onClick={() => setImportMode('files')}
                            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                              importMode === 'files'
                                ? 'bg-indigo-600 text-white'
                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                            }`}
                          >
                            <FileUp className="h-3.5 w-3.5" />
                            <span>Statement files</span>
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={importMode === 'folder'}
                            onClick={() => setImportMode('folder')}
                            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                              importMode === 'folder'
                                ? 'bg-indigo-600 text-white'
                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                            }`}
                          >
                            <FolderSync className="h-3.5 w-3.5" />
                            <span>Folder vault</span>
                          </button>
                        </div>
                      </div>

                      {importMode === 'email' ? (
                        <EmailImportPanel
                          workspaceId={bundle.workspace.id}
                          ledgers={ledgerList}
                          refreshToken={refreshToken}
                          onChanged={handleDataChanged}
                          onOpenSettings={() => {
                            setSection('books');
                            setBooksTab('imap');
                          }}
                          onOpenInbox={() => {
                            setSection('activity');
                            setActivityTab('inbox');
                          }}
                        />
                      ) : importMode === 'files' ? (
                        <StatementImport
                          workspaceId={bundle.workspace.id}
                          ledgers={ledgerList}
                          refreshToken={refreshToken}
                          onChanged={handleDataChanged}
                        />
                      ) : (
                        <FolderVaultPanel
                          workspaceId={bundle.workspace.id}
                          companyName={bundle.company.legalName}
                          onChanged={handleDataChanged}
                          onOpenInbox={() => {
                            setSection('activity');
                            setActivityTab('inbox');
                          }}
                        />
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}

              {section === 'reports' ? (
                <>
                  {reportTab === 'pnl' ||
                  reportTab === 'balance' ||
                  reportTab === 'trial' ||
                  reportTab === 'parties' ? (
                    <ReportsPanel
                      workspaceId={bundle.workspace.id}
                      refreshToken={refreshToken}
                      activeTab={reportTab}
                      onTabChange={(next) => setReportTab(next)}
                    />
                  ) : null}
                  {reportTab === 'gstr2b' ? (
                    <Gstr2bReconPanel
                      workspaceId={bundle.workspace.id}
                      refreshToken={refreshToken}
                      onNotice={(msg) => setNotice(msg)}
                    />
                  ) : null}
                  {reportTab === 'stock' ? (
                    <StockReport workspaceId={bundle.workspace.id} refreshToken={refreshToken} />
                  ) : null}
                </>
              ) : null}

              {section === 'books' ? (
                <>
                  {booksTab === 'accounts' ? (
                    <ChartOfAccounts
                      workspaceId={bundle.workspace.id}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {booksTab === 'rules' ? (
                    <ClassificationRulesPanel
                      workspaceId={bundle.workspace.id}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {booksTab === 'stock-items' ? (
                    <StockItemsPanel
                      workspaceId={bundle.workspace.id}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {booksTab === 'imap' ? (
                    <ImapSettingsPanel
                      workspaceId={bundle.workspace.id}
                      ledgers={ledgerList}
                      onChanged={handleDataChanged}
                      onOpenImport={() => {
                        setSection('activity');
                        setActivityTab('import');
                        setImportMode('email');
                      }}
                    />
                  ) : null}
                  {booksTab === 'export' ? (
                    <BooksExportPanel
                      workspaceId={bundle.workspace.id}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                  {booksTab === 'settings' ? (
                    <WorkspaceSettingsPanel
                      bundle={bundle}
                      onChanged={handleDataChanged}
                    />
                  ) : null}
                </>
              ) : null}
            </ErrorBoundary>
          ) : null}
        </main>
      </div>

      {/* Global Slide-over New Entry Drawer */}
      {bundle ? (
        <QuickEntryDrawer
          open={entryDrawerOpen}
          workspaceId={bundle.workspace.id}
          ledgers={ledgerList}
          parties={parties}
          stockItems={stockItems}
          onClose={() => setEntryDrawerOpen(false)}
          onPosted={(message) => {
            setEntryDrawerOpen(false);
            handleDataChanged(message);
          }}
        />
      ) : null}

      {/* Auto-dismissing Toast Banner */}
      {notice ? (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 flex max-w-md items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(undefined)}
            aria-label="Dismiss notification"
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
