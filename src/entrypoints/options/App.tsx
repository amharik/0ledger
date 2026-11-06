import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  backupFilename,
  createBackup,
  restoreBackup,
  type BackupEnvelope,
  type RestoreMode,
} from '@/core/backup';
import { getDb } from '@/core/db/db';
import { createWorkspace } from '@/core/db/workspace-service';
import type { Workspace } from '@/core/model';
import { getActiveWorkspaceId, listWorkspaces, setActiveWorkspaceId } from '@/ui/workspace';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [gstin, setGstin] = useState('');
  const [creating, setCreating] = useState(false);

  const [backupPassword, setBackupPassword] = useState('');
  const [backupConfirm, setBackupConfirm] = useState('');
  const [downloading, setDownloading] = useState(false);

  const [restorePassword, setRestorePassword] = useState('');
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('replace');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextWorkspaces, storedActive] = await Promise.all([
        listWorkspaces(),
        getActiveWorkspaceId(),
      ]);
      setWorkspaces(nextWorkspaces);
      const nextActive =
        storedActive && nextWorkspaces.some((workspace) => workspace.id === storedActive)
          ? storedActive
          : nextWorkspaces[0]?.id;
      setActiveId(nextActive);
      if (nextActive && nextActive !== storedActive) await setActiveWorkspaceId(nextActive);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    if (!name.trim()) {
      setError('Company name is required.');
      return;
    }

    setCreating(true);
    try {
      const input: Parameters<typeof createWorkspace>[1] = { name: name.trim() };
      if (state.trim()) input.state = state.trim();
      if (gstin.trim()) input.gstin = gstin.trim().toUpperCase();

      const bundle = await createWorkspace(getDb(), input);
      await setActiveWorkspaceId(bundle.workspace.id);
      setNotice(`Created workspace “${bundle.workspace.name}”.`);
      setName('');
      setState('');
      setGstin('');
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  async function downloadBackup() {
    setError(undefined);
    setNotice(undefined);
    if (backupPassword.length < 8) {
      setError('Backup password must be at least 8 characters.');
      return;
    }
    if (backupPassword !== backupConfirm) {
      setError('Backup passwords do not match.');
      return;
    }

    setDownloading(true);
    try {
      const envelope = await createBackup(getDb(), backupPassword);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = backupFilename();
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice('Encrypted backup downloaded. Keep the password safe — it cannot be recovered.');
      setBackupPassword('');
      setBackupConfirm('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDownloading(false);
    }
  }

  async function restore() {
    setError(undefined);
    setNotice(undefined);
    if (!restoreFile) {
      setError('Choose a .0ledger backup file.');
      return;
    }
    if (restorePassword.length < 8) {
      setError('Enter the backup password.');
      return;
    }
    if (restoreMode === 'replace' && !confirmReplace) {
      setError('Confirm that replace mode will erase current local data.');
      return;
    }

    setRestoring(true);
    try {
      const text = await restoreFile.text();
      const envelope = JSON.parse(text) as BackupEnvelope;
      const result = await restoreBackup(getDb(), envelope, restorePassword, {
        mode: restoreMode,
      });
      setNotice(
        `Restored ${result.totalRecords} records (${result.mode}). Reloading workspace list…`,
      );
      setRestoreFile(undefined);
      setRestorePassword('');
      setConfirmReplace(false);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRestoring(false);
    }
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeId);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>0ledger settings</h1>
          <p className="muted">Local-first ledger · one company per workspace</p>
        </div>
        <button className="ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error ? <div className="alert danger">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      <section className="card">
        <h2>Workspaces</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : workspaces.length === 0 ? (
          <p className="muted">No workspace yet. Create your company below.</p>
        ) : (
          <ul className="workspace-list">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <div>
                  <strong>{workspace.name}</strong>
                  <div className="muted small">{workspace.slug}</div>
                </div>
                {workspace.id === activeId ? (
                  <span className="badge">Active</span>
                ) : (
                  <button className="ghost small-button" onClick={() => void switchWorkspace(workspace.id)}>
                    Use
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={create} className="create-form">
          <h3>New workspace</h3>
          <div className="form-grid">
            <label>
              <span>Company / workspace name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme Traders"
                required
              />
            </label>
            <label>
              <span>State</span>
              <input
                value={state}
                onChange={(event) => setState(event.target.value)}
                placeholder="Karnataka"
              />
            </label>
            <label>
              <span>GSTIN (optional)</span>
              <input
                value={gstin}
                onChange={(event) => setGstin(event.target.value)}
                placeholder="29ABCDE1234F1Z5"
              />
            </label>
          </div>
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Encrypted backup</h2>
        <p className="muted">
          Exports every table to one AES-256-GCM file. The password is not stored and cannot be
          recovered.
        </p>
        <div className="form-grid">
          <label>
            <span>Password</span>
            <input
              type="password"
              value={backupPassword}
              onChange={(event) => setBackupPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              value={backupConfirm}
              onChange={(event) => setBackupConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </label>
        </div>
        <button onClick={() => void downloadBackup()} disabled={downloading || workspaces.length === 0}>
          {downloading ? 'Encrypting…' : 'Download backup'}
        </button>
      </section>

      <section className="card">
        <h2>Restore</h2>
        <p className="muted">
          Restore a 0ledger backup. Replace mode clears local data first; merge keeps existing
          records and overwrites matching ids.
        </p>
        <div className="form-grid">
          <label>
            <span>Backup file</span>
            <input
              type="file"
              accept=".0ledger,application/json"
              onChange={(event) => setRestoreFile(event.target.files?.[0])}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={restorePassword}
              onChange={(event) => setRestorePassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label>
            <span>Mode</span>
            <select
              value={restoreMode}
              onChange={(event) => {
                setRestoreMode(event.target.value as RestoreMode);
                setConfirmReplace(false);
              }}
            >
              <option value="replace">Replace local data</option>
              <option value="merge">Merge into local data</option>
            </select>
          </label>
        </div>
        {restoreMode === 'replace' ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmReplace}
              onChange={(event) => setConfirmReplace(event.target.checked)}
            />
            <span>I understand this erases the current local ledger and settings.</span>
          </label>
        ) : null}
        <button onClick={() => void restore()} disabled={restoring}>
          {restoring ? 'Restoring…' : 'Restore backup'}
        </button>
      </section>

      <section className="card">
        <h2>Data & privacy</h2>
        <p className="muted">
          Your ledger is stored locally in this browser. Nothing is uploaded unless you connect
          Google Drive or Google Sheets. Google Sheets mirrors are plaintext by design.
        </p>
        {activeWorkspace ? (
          <p className="muted small">
            Active workspace: <strong>{activeWorkspace.name}</strong>
          </p>
        ) : null}
      </section>
    </main>
  );

  async function switchWorkspace(workspaceId: string) {
    await setActiveWorkspaceId(workspaceId);
    setActiveId(workspaceId);
    setNotice('Active workspace changed.');
  }
}
