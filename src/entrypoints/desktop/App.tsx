import { useEffect, useState } from 'react';
import { useWorkspace } from '@/ui/workspace';
import { OnboardingWizard } from '@/ui/OnboardingWizard';
import { FolderWatcherPanel } from '@/ui/FolderWatcherPanel';
import { MailSyncPanel } from '@/ui/MailSyncPanel';
import { CloseCockpit } from '@/ui/CloseCockpit';
import { MoneyInbox } from '@/ui/MoneyInbox';
import { Gstr2bReconPanel } from '@/ui/Gstr2bReconPanel';
import { TallyBridgePanel } from '@/ui/TallyBridgePanel';
import { LicenseSettingsPanel } from '@/ui/LicenseSettingsPanel';
import { StatementImport } from '@/ui/StatementImport';
import { InvoiceEntry } from '@/ui/InvoiceEntry';
import { ReportsPanel } from '@/ui/ReportsPanel';
import { StockReport } from '@/ui/StockReport';
import { ReconciliationPanel } from '@/ui/ReconciliationPanel';
import ChartOfAccounts from '@/ui/ChartOfAccounts';
import InterchangePanel from '@/ui/InterchangePanel';
import DrivePanel from '@/ui/DrivePanel';
import { EnginePanel } from '@/ui/EnginePanel';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { listParties, listStockItems, type PartyView } from '@/core/db/master-service';
import { bootstrapSqlite } from '@/core/db/sqlite-bootstrap';
import type { StockItem } from '@/core/model';
import { getDb } from '@/core/db/db';

type Tab =
  | 'cockpit'
  | 'inbox'
  | 'watcher'
  | 'mail'
  | 'import'
  | 'gstr2b'
  | 'tally'
  | 'invoicing'
  | 'recon'
  | 'reports'
  | 'accounts'
  | 'settings'
  | 'engine';

export default function App() {
  const { bundle, workspaces, loading, error, reload, selectWorkspace } = useWorkspace();
  const [activeTab, setActiveTab] = useState<Tab>('cockpit');
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [parties, setParties] = useState<PartyView[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);

  const workspaceId = bundle?.workspace.id;
  const ledgerList = bundle?.ledgers ?? [];

  useEffect(() => {
    void bootstrapSqlite().then(() => setRefreshToken((value) => value + 1));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const db = getDb();
    void Promise.all([listParties(db, workspaceId), listStockItems(db, workspaceId)]).then(
      ([p, s]) => {
        setParties(p);
        setStockItems(s);
      },
    );
  }, [workspaceId, refreshToken]);

  return (
    <div className="desktop-shell" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.75rem 1.5rem',
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.25rem' }}>0ledger</h1>
          <span className="badge positive">Desktop Edition</span>
          {bundle ? (
            <span className="muted small">
              Workspace: <strong>{bundle.workspace.name}</strong>
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {workspaces.length > 0 && bundle ? (
            <select
              value={bundle.workspace.id}
              onChange={(e) => {
                setShowNewCompany(false);
                void selectWorkspace(e.target.value);
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            className="secondary small-button"
            onClick={() => setShowNewCompany(true)}
          >
            + New Company
          </button>
          <button
            className="ghost small-button"
            onClick={() => {
              void reload();
              setRefreshToken((v) => v + 1);
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      {bundle && !showNewCompany ? (
        <nav
          style={{
            display: 'flex',
            gap: '0.5rem',
            padding: '0.5rem 1.5rem',
            background: 'var(--panel)',
            borderBottom: '1px solid var(--border)',
            overflowX: 'auto',
          }}
        >
          <button
            type="button"
            className={activeTab === 'cockpit' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('cockpit')}
          >
            Close Cockpit
          </button>
          <button
            type="button"
            className={activeTab === 'inbox' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('inbox')}
          >
            Money Inbox
          </button>
          <button
            type="button"
            className={activeTab === 'watcher' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('watcher')}
          >
            📁 Auto-Watcher & Vault
          </button>
          <button
            type="button"
            className={activeTab === 'mail' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('mail')}
          >
            📧 Local Mail Sync
          </button>
          <button
            type="button"
            className={activeTab === 'import' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('import')}
          >
            Statement Import
          </button>
          <button
            type="button"
            className={activeTab === 'gstr2b' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('gstr2b')}
          >
            GSTR-2B Recon (ITC)
          </button>
          <button
            type="button"
            className={activeTab === 'tally' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('tally')}
          >
            Tally Prime Bridge
          </button>
          <button
            type="button"
            className={activeTab === 'invoicing' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('invoicing')}
          >
            Invoices
          </button>
          <button
            type="button"
            className={activeTab === 'recon' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('recon')}
          >
            Bank Reconciliation
          </button>
          <button
            type="button"
            className={activeTab === 'reports' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('reports')}
          >
            Reports & P&L
          </button>
          <button
            type="button"
            className={activeTab === 'accounts' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('accounts')}
          >
            Chart of Accounts
          </button>
          <button
            type="button"
            className={activeTab === 'engine' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('engine')}
          >
            Engine & Sync
          </button>
          <button
            type="button"
            className={activeTab === 'settings' ? 'chip active' : 'chip'}
            onClick={() => setActiveTab('settings')}
          >
            Edition & Settings
          </button>
        </nav>
      ) : null}

      <main style={{ padding: '1.5rem', maxWidth: '1200px', width: '100%', margin: '0 auto', flex: 1 }}>
        {notice ? <div className="alert success">{notice}</div> : null}
        {error ? <div className="alert danger">{error}</div> : null}
        {loading ? <p className="muted">Loading workspace…</p> : null}

        {!loading && (!bundle || showNewCompany) ? (
          <OnboardingWizard
            onCompleted={(newId) => {
              setShowNewCompany(false);
              void selectWorkspace(newId);
              setRefreshToken((v) => v + 1);
            }}
            onCancel={bundle ? () => setShowNewCompany(false) : undefined}
          />
        ) : null}

        {bundle && !showNewCompany ? (
          <ErrorBoundary fallbackTitle="Panel Rendering Error">
            {activeTab === 'cockpit' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <CloseCockpit
                  workspaceId={bundle.workspace.id}
                  refreshToken={refreshToken}
                  onChanged={(msg) => {
                    setNotice(msg);
                    setRefreshToken((v) => v + 1);
                  }}
                />
              </div>
            ) : null}

            {activeTab === 'inbox' ? (
              <MoneyInbox
                workspaceId={bundle.workspace.id}
                ledgers={ledgerList}
                refreshToken={refreshToken}
                onChanged={(msg) => {
                  setNotice(msg);
                  setRefreshToken((v) => v + 1);
                }}
              />
            ) : null}

            {activeTab === 'watcher' ? (
              <FolderWatcherPanel
                workspaceId={bundle.workspace.id}
                companyName={bundle.workspace.name}
                onNotice={(msg) => {
                  setNotice(msg);
                  setRefreshToken((v) => v + 1);
                }}
              />
            ) : null}

            {activeTab === 'mail' ? (
              <ErrorBoundary fallbackTitle="Mail Sync Encountered an Issue">
                <MailSyncPanel
                  workspaceId={bundle.workspace.id}
                  onNotice={(msg) => {
                    setNotice(msg);
                    setRefreshToken((v) => v + 1);
                  }}
                />
              </ErrorBoundary>
            ) : null}

            {activeTab === 'import' ? (
              <StatementImport
                workspaceId={bundle.workspace.id}
                ledgers={ledgerList}
                refreshToken={refreshToken}
                onChanged={(msg) => {
                  setNotice(msg);
                  setRefreshToken((v) => v + 1);
                }}
              />
            ) : null}

            {activeTab === 'gstr2b' ? (
              <Gstr2bReconPanel
                workspaceId={bundle.workspace.id}
                refreshToken={refreshToken}
                onNotice={setNotice}
              />
            ) : null}

            {activeTab === 'tally' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <TallyBridgePanel workspaceId={bundle.workspace.id} onNotice={setNotice} />
                <InterchangePanel workspaceId={bundle.workspace.id} />
              </div>
            ) : null}

            {activeTab === 'invoicing' ? (
              <InvoiceEntry
                workspaceId={bundle.workspace.id}
                ledgers={ledgerList}
                parties={parties}
                stockItems={stockItems}
                onPosted={(msg) => {
                  setNotice(msg);
                  setRefreshToken((v) => v + 1);
                }}
              />
            ) : null}

            {activeTab === 'recon' ? (
              <ReconciliationPanel
                workspaceId={bundle.workspace.id}
                ledgers={ledgerList}
                refreshToken={refreshToken}
                onChanged={(msg) => {
                  setNotice(msg);
                  setRefreshToken((v) => v + 1);
                }}
              />
            ) : null}

            {activeTab === 'reports' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <ReportsPanel workspaceId={bundle.workspace.id} refreshToken={refreshToken} />
                <StockReport workspaceId={bundle.workspace.id} refreshToken={refreshToken} />
              </div>
            ) : null}

            {activeTab === 'accounts' ? (
              <ChartOfAccounts workspaceId={bundle.workspace.id} />
            ) : null}

            {activeTab === 'engine' ? (
              <EnginePanel workspaceId={bundle.workspace.id} />
            ) : null}

            {activeTab === 'settings' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <LicenseSettingsPanel
                  workspaceCreatedAt={bundle.workspace.createdAt}
                  onNotice={setNotice}
                />
                <DrivePanel workspaceId={bundle.workspace.id} />
              </div>
            ) : null}
          </ErrorBoundary>
        ) : null}
      </main>
    </div>
  );
}
