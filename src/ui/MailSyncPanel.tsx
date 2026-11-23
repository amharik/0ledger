import { useState, useEffect, useRef } from 'react';
import { getDb } from '@/core/db/db';
import {
  listMailboxes,
  saveMailbox,
  deleteMailbox,
  getActiveMailbox,
  syncLocalMail,
  testMailConnection,
  getMailboxPassword,
  type MailboxAccount,
  type ImapConfig,
  type MailPreset,
  type MailSyncReport,
  type MailProgressPayload,
} from '@/core/desktop/mail-sync';
import type { Ledger } from '@/core/model';

interface Props {
  workspaceId: string;
  onNotice: (msg: string) => void;
}

const PROVIDER_PRESETS: Record<string, { host: string; port: number }> = {
  gmail: { host: 'imap.gmail.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993 },
  custom: { host: '', port: 993 },
};

export function MailSyncPanel({ workspaceId, onNotice }: Props) {
  const [mailboxes, setMailboxes] = useState<MailboxAccount[]>(() => {
    try {
      return listMailboxes(workspaceId);
    } catch (err) {
      console.warn('Failed to list mailboxes:', err);
      return [];
    }
  });
  const [selectedMailboxId, setSelectedMailboxId] = useState<string>(() => {
    try {
      const active = getActiveMailbox(workspaceId);
      return active?.id || '';
    } catch {
      return '';
    }
  });

  // Editor modal/card state
  const [editing, setEditing] = useState<boolean>(false);
  const [editLabel, setEditLabel] = useState<string>('');
  const [editProvider, setEditProvider] = useState<'gmail' | 'outlook' | 'zoho' | 'yahoo' | 'custom'>('gmail');
  const [editHost, setEditHost] = useState<string>('imap.gmail.com');
  const [editPort, setEditPort] = useState<number>(993);
  const [editUsername, setEditUsername] = useState<string>('');
  const [editPassword, setEditPassword] = useState<string>('');
  const [editMailbox, setEditMailbox] = useState<string>('INBOX');
  const [isEditNew, setIsEditNew] = useState<boolean>(true);
  const [editTargetId, setEditTargetId] = useState<string>('');

  // Sync controls
  const [preset, setPreset] = useState<MailPreset>('bank');
  const [days, setDays] = useState<number>(60);
  const [limit, setLimit] = useState<number>(25);
  const [selectedBankLedgerId, setSelectedBankLedgerId] = useState<string>('');
  const [bankLedgers, setBankLedgers] = useState<Ledger[]>([]);

  // Execution state
  const [testing, setTesting] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [progress, setProgress] = useState<MailProgressPayload | null>(null);
  const [report, setReport] = useState<MailSyncReport | null>(null);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<string>();

  // Live activity logs & console
  const [activityLogs, setActivityLogs] = useState<Array<{
    id: string;
    timestamp: string;
    stage: string;
    message: string;
    isError?: boolean;
  }>>([]);
  const [showLogs, setShowLogs] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const addLog = (stage: string, message: string, isError = false) => {
    const time = new Date().toLocaleTimeString();
    setActivityLogs((prev) => [
      ...prev.slice(-99),
      {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: time,
        stage,
        message,
        isError,
      },
    ]);
  };

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [activityLogs]);

  // Reload bank ledgers
  useEffect(() => {
    const db = getDb();
    db.ledgers
      .where('workspaceId')
      .equals(workspaceId)
      .and((l) => l.isBank && !l.archived)
      .toArray()
      .then((ledgers) => {
        setBankLedgers(ledgers);
        if (ledgers.length > 0 && !selectedBankLedgerId) {
          setSelectedBankLedgerId(ledgers[0]!.id);
        }
      })
      .catch(() => {});
  }, [workspaceId, selectedBankLedgerId]);

  const activeAccount = mailboxes.find((m) => m.id === selectedMailboxId) || mailboxes[0];

  const handleProviderSelect = (p: 'gmail' | 'outlook' | 'yahoo' | 'custom') => {
    setEditProvider(p);
    const presetConfig = PROVIDER_PRESETS[p];
    if (presetConfig && p !== 'custom') {
      setEditHost(presetConfig.host);
      setEditPort(presetConfig.port);
    }
  };

  const openAddMailbox = () => {
    setIsEditNew(true);
    setEditTargetId(`mbx_${Date.now()}`);
    setEditLabel('Business Mailbox');
    setEditProvider('gmail');
    setEditHost('imap.gmail.com');
    setEditPort(993);
    setEditUsername('');
    setEditPassword('');
    setEditMailbox('INBOX');
    setEditing(true);
    setError(undefined);
    setTestResult(undefined);
  };

  const openEditMailbox = async (acc: MailboxAccount) => {
    setIsEditNew(false);
    setEditTargetId(acc.id);
    setEditLabel(acc.label);
    setEditProvider(acc.provider);
    setEditHost(acc.host);
    setEditPort(acc.port);
    setEditUsername(acc.username);
    setEditPassword((await getMailboxPassword(workspaceId, acc.id)) ?? '');
    setEditMailbox(acc.mailbox || 'INBOX');
    setEditing(true);
    setError(undefined);
    setTestResult(undefined);
  };

  const handleSaveMailbox = async () => {
    if (!editUsername.trim() || !editPassword.trim()) {
      setError('Please provide both the email address and app password.');
      return;
    }
    const updated: MailboxAccount = {
      id: editTargetId,
      label: editLabel.trim() || `${editUsername} (${editProvider})`,
      provider: editProvider,
      host: editHost.trim() || 'imap.gmail.com',
      port: editPort || 993,
      username: editUsername.trim(),
      mailbox: editMailbox.trim() || 'INBOX',
      isDefault: mailboxes.length === 0 || (!isEditNew && activeAccount?.id === editTargetId),
      createdAt: new Date().toISOString(),
    };
    await saveMailbox(workspaceId, updated, editPassword.trim());
    const refreshed = listMailboxes(workspaceId);
    setMailboxes(refreshed);
    setSelectedMailboxId(updated.id);
    setEditing(false);
    setError(undefined);
    onNotice(`Mailbox "${updated.label}" saved locally.`);
  };

  const handleDeleteMailbox = async (id: string) => {
    if (confirm('Are you sure you want to remove this mailbox configuration?')) {
      await deleteMailbox(workspaceId, id);
      const refreshed = listMailboxes(workspaceId);
      setMailboxes(refreshed);
      if (refreshed.length > 0) {
        setSelectedMailboxId(refreshed[0]!.id);
      }
      onNotice('Mailbox removed.');
    }
  };

  async function handleTest() {
    setTesting(true);
    setError(undefined);
    setTestResult(undefined);
    const host = editing ? editHost : activeAccount?.host || 'imap.gmail.com';
    const port = editing ? editPort : activeAccount?.port || 993;
    const username = editing ? editUsername : activeAccount?.username || '';
    addLog('testing', `Testing connection to ${host}:${port} as ${username}...`);
    try {
      const password = editing
        ? editPassword
        : activeAccount
          ? ((await getMailboxPassword(workspaceId, activeAccount.id)) ?? '')
          : '';
      const config: ImapConfig = {
        host,
        port,
        username,
        password,
        mailbox: editing ? editMailbox : activeAccount?.mailbox || 'INBOX',
      };

      if (!config.username.trim() || !config.password.trim()) {
        throw new Error('Please enter both your email address and app password.');
      }
      await testMailConnection(config, workspaceId);
      const msg = `✅ Connection successful! Authenticated with ${config.host} as ${config.username}.`;
      setTestResult(msg);
      addLog('testing', msg);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setError(err);
      addLog('error', `Connection test failed: ${err}`, true);
    } finally {
      setTesting(false);
    }
  }

  async function handleSync() {
    if (!activeAccount) {
      openAddMailbox();
      return;
    }
    const plainPassword = await getMailboxPassword(workspaceId, activeAccount.id);
    if (!activeAccount.username.trim() || !plainPassword?.trim()) {
      await openEditMailbox(activeAccount);
      setError('Please configure credentials for this mailbox first.');
      return;
    }

    setSyncing(true);
    setError(undefined);
    setTestResult(undefined);
    setProgress({
      stage: 'connecting',
      current: 0,
      total: 100,
      percent: 5,
      message: `Connecting to ${activeAccount.host}:${activeAccount.port}...`,
    });
    addLog(
      'connecting',
      `Connecting to ${activeAccount.host}:${activeAccount.port} for ${activeAccount.username} (Preset: ${preset}, Lookback: ${days} days)...`,
    );

    try {
      const db = getDb();
      const config: ImapConfig = {
        host: activeAccount.host,
        port: activeAccount.port,
        username: activeAccount.username,
        password: plainPassword,
        mailbox: activeAccount.mailbox || 'INBOX',
      };

      const res = await syncLocalMail(
        db,
        workspaceId,
        config,
        {
          preset,
          days,
          limit,
        },
        selectedBankLedgerId || undefined,
        (p) => {
          setProgress(p);
          addLog(p.stage, p.message);
        },
      );

      setReport(res);
      if (res.transactionsCreated > 0) {
        const msg = `Extracted ${res.transactionsCreated} transaction(s) and archived ${res.attachmentsCreated} .eml audit proof(s)!`;
        onNotice(msg);
        addLog('complete', msg);
      } else if (res.fetched === 0) {
        const msg = 'No matching emails found for this filter.';
        onNotice(msg);
        addLog('complete', msg);
      } else {
        const msg = `Fetched ${res.fetched} email(s). All were already processed or contained no recognized alert data.`;
        onNotice(msg);
        addLog('complete', msg);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      addLog('error', `Sync error: ${errMsg}`, true);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="card">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>📧 Local Mail Sync & Audit-Proof Ingestion</h2>
          <p className="muted small" style={{ margin: '0.25rem 0 0 0' }}>
            Sync FASTag tolls, bank alerts & shopping invoices directly from your inbox. Saves .eml audit proof to vault & dedupes by transaction ID.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="ghost small-button"
            disabled={testing || syncing || (!activeAccount && !editing)}
            onClick={() => void handleTest()}
          >
            {testing ? 'Testing…' : '🔌 Test Connection'}
          </button>
          <button
            type="button"
            className="secondary small-button"
            disabled={syncing || testing || (!activeAccount && !editing)}
            onClick={() => void handleSync()}
          >
            {syncing ? '⚡ Syncing…' : '⚡ Sync Mail Now'}
          </button>
        </div>
      </div>

      {testResult ? <div className="alert success" style={{ marginTop: '1rem' }}>{testResult}</div> : null}
      {error ? <div className="alert danger" style={{ marginTop: '1rem' }}>{error}</div> : null}

      {/* Running Progress Loader & Live Activity Console */}
      {(syncing || activityLogs.length > 0) ? (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: syncing ? 'rgba(59, 130, 246, 0.05)' : 'var(--panel)',
            border: syncing ? '1px solid #3b82f6' : '1px solid var(--border)',
            borderRadius: '8px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              {syncing ? (
                <span
                  style={{
                    display: 'inline-block',
                    width: '12px',
                    height: '12px',
                    border: '2px solid rgba(59, 130, 246, 0.3)',
                    borderTopColor: '#3b82f6',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              ) : (
                <span style={{ fontSize: '1rem' }}>📜</span>
              )}
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: syncing ? 'var(--accent)' : 'inherit' }}>
                {syncing
                  ? `🔄 Mail Ingestion: ${progress?.stage ? progress.stage.toUpperCase() : 'IN PROGRESS'}`
                  : 'Mail Sync Activity Log'}
              </span>
              {syncing && progress ? (
                <span className="badge info" style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }}>
                  {progress.percent}%
                </span>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                type="button"
                className="ghost small-button"
                onClick={() => setShowLogs((v) => !v)}
                style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
              >
                {showLogs ? 'Hide Console' : `Show Console (${activityLogs.length})`}
              </button>
              {activityLogs.length > 0 && !syncing ? (
                <button
                  type="button"
                  className="ghost small-button"
                  onClick={() => setActivityLogs([])}
                  style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                >
                  Clear Log
                </button>
              ) : null}
            </div>
          </div>

          {/* Animated Progress Bar */}
          {syncing && progress ? (
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ width: '100%', height: '8px', background: 'rgba(0,0,0,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.max(progress.percent, 5)}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #3b82f6, #10b981)',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <p className="muted small" style={{ margin: '0.35rem 0 0 0', fontStyle: 'italic' }}>
                {progress.message}
              </p>
            </div>
          ) : null}

          {/* Live Activity Console */}
          {showLogs && activityLogs.length > 0 ? (
            <div
              ref={logContainerRef}
              style={{
                marginTop: '0.5rem',
                background: '#090d16',
                color: '#cbd5e1',
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                fontSize: '0.75rem',
                padding: '0.75rem',
                borderRadius: '6px',
                maxHeight: '180px',
                overflowY: 'auto',
                lineHeight: '1.6',
                boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.4)',
              }}
            >
              {activityLogs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    color: log.isError
                      ? '#f87171'
                      : log.stage === 'complete'
                        ? '#4ade80'
                        : log.stage === 'testing'
                          ? '#a78bfa'
                          : '#e2e8f0',
                  }}
                >
                  <span style={{ opacity: 0.45, flexShrink: 0 }}>[{log.timestamp}]</span>
                  <span
                    style={{
                      flexShrink: 0,
                      textTransform: 'uppercase',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      opacity: 0.75,
                      padding: '0 0.3rem',
                      borderRadius: '3px',
                      background: 'rgba(255,255,255,0.08)',
                      height: 'fit-content',
                    }}
                  >
                    {log.stage}
                  </span>
                  <span style={{ wordBreak: 'break-word' }}>{log.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 1. Multi-Mailbox Management Header & Selector */}
      <div style={{ marginTop: '1.25rem', background: 'var(--panel)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h4 style={{ margin: 0, fontSize: '0.95rem' }}>1. Connected Mailboxes</h4>
          <button type="button" className="ghost small-button" onClick={openAddMailbox}>
            ➕ Add Mailbox
          </button>
        </div>

        {mailboxes.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', border: '1px dashed var(--border)', borderRadius: '6px' }}>
            <p className="muted" style={{ margin: '0 0 0.75rem 0' }}>No email accounts connected yet.</p>
            <button type="button" className="secondary small-button" onClick={openAddMailbox}>
              Connect Your First Mailbox
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {mailboxes.map((acc) => (
              <div
                key={acc.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.4rem 0.75rem',
                  borderRadius: '20px',
                  background: selectedMailboxId === acc.id ? 'var(--accent)' : 'var(--bg)',
                  color: selectedMailboxId === acc.id ? '#fff' : 'inherit',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
                onClick={() => setSelectedMailboxId(acc.id)}
              >
                <span>{acc.provider === 'gmail' ? '🇬' : acc.provider === 'outlook' ? '🇴' : '✉️'}</span>
                <strong>{acc.label}</strong>
                <span style={{ opacity: 0.75, fontSize: '0.75rem' }}>({acc.username})</span>
                <button
                  type="button"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: '0 2px',
                    opacity: 0.8,
                  }}
                  title="Edit mailbox"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openEditMailbox(acc);
                  }}
                >
                  ✏️
                </button>
                {mailboxes.length > 1 ? (
                  <button
                    type="button"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: '0 2px',
                      opacity: 0.8,
                    }}
                    title="Delete mailbox"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteMailbox(acc.id);
                    }}
                  >
                    🗑️
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* Mailbox Editor Form (Modal or Expandable) */}
        {editing ? (
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'var(--bg)',
              border: '1px solid var(--accent)',
              borderRadius: '6px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h5 style={{ margin: 0 }}>{isEditNew ? 'Add New Mailbox' : `Edit Mailbox: ${editLabel}`}</h5>
              <button type="button" className="ghost small-button" onClick={() => setEditing(false)}>
                ✕ Close
              </button>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                type="button"
                className={editProvider === 'gmail' ? 'chip active' : 'chip'}
                onClick={() => handleProviderSelect('gmail')}
              >
                Gmail / Google Workspace
              </button>
              <button
                type="button"
                className={editProvider === 'outlook' ? 'chip active' : 'chip'}
                onClick={() => handleProviderSelect('outlook')}
              >
                Microsoft 365 / Outlook
              </button>
              <button
                type="button"
                className={editProvider === 'yahoo' ? 'chip active' : 'chip'}
                onClick={() => handleProviderSelect('yahoo')}
              >
                Yahoo Mail
              </button>
              <button
                type="button"
                className={editProvider === 'custom' ? 'chip active' : 'chip'}
                onClick={() => handleProviderSelect('custom')}
              >
                Custom IMAP
              </button>
            </div>

            <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <label>
                Account Label
                <input
                  type="text"
                  placeholder="e.g. HDFC & FASTag Alerts"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>

              <label>
                Email Address
                <input
                  type="email"
                  placeholder="e.g. accounts@mycompany.in"
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>

              <label>
                App Password (persisted encrypted locally)
                <input
                  type="password"
                  placeholder="e.g. abcd efgh ijkl mnop"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>

              <label>
                Mailbox Folder
                <input
                  type="text"
                  placeholder="INBOX"
                  value={editMailbox}
                  onChange={(e) => setEditMailbox(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                />
              </label>
            </div>

            {editProvider === 'custom' ? (
              <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginTop: '0.75rem' }}>
                <label>
                  IMAP Server Host
                  <input
                    type="text"
                    value={editHost}
                    onChange={(e) => setEditHost(e.target.value)}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                  />
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    value={editPort}
                    onChange={(e) => setEditPort(Number(e.target.value) || 993)}
                    style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
                  />
                </label>
              </div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" className="ghost small-button" disabled={testing} onClick={() => void handleTest()}>
                {testing ? 'Testing…' : '🔌 Test Credentials'}
              </button>
              <button type="button" className="secondary small-button" onClick={() => void handleSaveMailbox()}>
                💾 Save Mailbox
              </button>
            </div>

            <details style={{ marginTop: '0.75rem' }}>
              <summary className="muted small" style={{ cursor: 'pointer' }}>
                💡 How to generate a Google App Password (takes 30 seconds)
              </summary>
              <div className="muted small" style={{ marginTop: '0.5rem', lineHeight: '1.5' }}>
                1. Navigate to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Google App Passwords</a>.<br />
                2. Enter an app name like <code>0ledger Desktop</code> and click <strong>Create</strong>.<br />
                3. Copy the 16-character code and paste it into the password box above. Passwords are saved encrypted with your workspace key on-device.
              </div>
            </details>
          </div>
        ) : null}
      </div>

      {/* 2. Target Preset & Filters */}
      <div style={{ marginTop: '1.25rem', background: 'var(--panel)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
        <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>2. Search Filter & Target Preset</h4>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
          <button
            type="button"
            className={preset === 'bank' ? 'chip active' : 'chip'}
            onClick={() => setPreset('bank')}
            style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}
          >
            🏦 Bank Alerts & E-Statements
          </button>
          <button
            type="button"
            className={preset === 'fastag' ? 'chip active' : 'chip'}
            onClick={() => setPreset('fastag')}
            style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}
          >
            🏷️ FASTag Toll Deductions
          </button>
          <button
            type="button"
            className={preset === 'shopping' ? 'chip active' : 'chip'}
            onClick={() => setPreset('shopping')}
            style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}
          >
            🛍️ Shopping & Cloud Invoices
          </button>
          <button
            type="button"
            className={preset === 'all' ? 'chip active' : 'chip'}
            onClick={() => setPreset('all')}
            style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}
          >
            🔄 All Accounting Messages
          </button>
        </div>

        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Lookback:
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={15}>Last 15 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Max emails:
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={10}>10 emails</option>
              <option value={25}>25 emails</option>
              <option value={50}>50 emails</option>
              <option value={100}>100 emails</option>
            </select>
          </label>

          {bankLedgers.length > 0 ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Assign to Bank A/c:
              <select value={selectedBankLedgerId} onChange={(e) => setSelectedBankLedgerId(e.target.value)}>
                <option value="">Auto-detect / unassigned</option>
                {bankLedgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {/* 3. Sync Execution Report & Extracted Transactions Table */}
      {report ? (
        <div
          style={{
            marginTop: '1.25rem',
            padding: '1rem',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
          }}
        >
          <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Sync Execution Summary</h4>
          <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem', flexWrap: 'wrap' }}>
            <span>Fetched: <strong>{report.fetched}</strong></span>
            <span>New Emails: <strong style={{ color: 'var(--accent)' }}>{report.newMessages}</strong></span>
            <span>Transactions Created: <strong style={{ color: '#10b981' }}>{report.transactionsCreated}</strong></span>
            <span>EML Proofs Archived: <strong style={{ color: '#3b82f6' }}>{report.attachmentsCreated}</strong></span>
            <span>Skipped: <strong>{report.skipped.length}</strong></span>
          </div>

          {report.items.length > 0 ? (
            <div style={{ marginTop: '1rem' }}>
              <h5 style={{ margin: '0 0 0.5rem 0', fontSize: '0.85rem' }}>Extracted Transactions & Attached Proofs</h5>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', opacity: 0.8 }}>
                      <th style={{ padding: '0.4rem 0.5rem' }}>Date</th>
                      <th style={{ padding: '0.4rem 0.5rem' }}>Subject / Sender</th>
                      <th style={{ padding: '0.4rem 0.5rem' }}>Txn ID / Ref</th>
                      <th style={{ padding: '0.4rem 0.5rem', textAlign: 'right' }}>Amount</th>
                      <th style={{ padding: '0.4rem 0.5rem' }}>Audit Proof (.eml)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map((item, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.4rem 0.5rem', whiteSpace: 'nowrap' }}>{item.date}</td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          <div style={{ fontWeight: 600 }}>{item.subject}</div>
                          <div className="muted" style={{ fontSize: '0.75rem' }}>{item.sender}</div>
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          {item.transactionId ? (
                            <span
                              style={{
                                background: 'rgba(59, 130, 246, 0.1)',
                                color: 'var(--accent)',
                                padding: '0.15rem 0.4rem',
                                borderRadius: '4px',
                                fontFamily: 'monospace',
                                fontSize: '0.75rem',
                              }}
                            >
                              {item.transactionId}
                            </span>
                          ) : (
                            <span className="muted">Auto-generated</span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: '0.4rem 0.5rem',
                            textAlign: 'right',
                            fontWeight: 600,
                            color: item.direction === 'out' ? '#ef4444' : '#10b981',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {item.direction === 'out' ? '-' : '+'}₹{(item.amountMinor / 100).toFixed(2)}
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.75rem' }}>
                          {item.attachmentPath ? (
                            <span title={item.attachmentPath} style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              📎 Archived (.eml)
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {report.errors.length > 0 ? (
            <div style={{ marginTop: '0.75rem', color: '#ef4444', fontSize: '0.8rem' }}>
              Errors:
              <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.2rem' }}>
                {report.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
