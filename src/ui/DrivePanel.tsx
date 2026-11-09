import { useCallback, useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import type { DriveLink } from '@/core/model';
import {
  GMAIL_SCOPES,
  createPkcePair,
  buildAuthUrl,
  exchangeAuthorizationCode,
  fetchUserInfo,
  parseAuthRedirect,
  randomUrlSafe,
  revokeToken,
  type DriveTokens,
} from '@/core/drive/auth';
import {
  DEFAULT_GMAIL_QUERY,
  syncGmailStatements,
} from '@/core/ingest/gmail';
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const DRIVE_ORIGINS = [
  'https://www.googleapis.com/*',
  'https://sheets.googleapis.com/*',
  'https://oauth2.googleapis.com/*',
  'https://openidconnect.googleapis.com/*',
];
const GMAIL_ORIGINS = [...DRIVE_ORIGINS, 'https://gmail.googleapis.com/*'];

async function requestOrigins(origins: string[]): Promise<void> {
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error('Google API host permissions were not granted.');
}

export default function DrivePanel({ workspaceId }: { workspaceId: string }) {
  const [clientId, setClientId] = useState('');
  const [email, setEmail] = useState<string>();
  const [tokens, setTokens] = useState<DriveTokens>();
  const [link, setLink] = useState<DriveLink>();
  const [webViewLink, setWebViewLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [diff, setDiff] = useState<SnapshotDiff>();
  const [snapshot, setSnapshot] = useState<WorkbookSnapshot>();
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [period, setPeriod] = useState(monthKey());
  const [externalRef, setExternalRef] = useState('');
  const [gmailQuery, setGmailQuery] = useState(DEFAULT_GMAIL_QUERY);
  const hasGmailScope = Boolean(tokens?.scope?.includes('gmail.readonly'));

  const refresh = useCallback(async () => {
    const db = getDb();
    const [storedClient, storedTokens, links] = await Promise.all([
      getDriveClientId(),
      getDriveTokens(),
      db.driveLinks.where('workspaceId').equals(workspaceId).toArray(),
    ]);
    setClientId(storedClient ?? '');
    setTokens(storedTokens);
    setEmail(storedTokens?.email);
    setLink(links.find((item) => item.kind === 'sheets'));
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connect() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await requestOrigins(DRIVE_ORIGINS);
      const trimmed = clientId.trim();
      if (!trimmed) throw new Error('Enter your Google OAuth client ID first.');
      await saveDriveClientId(trimmed);
      const pair = await createPkcePair();
      const state = randomUrlSafe(24);
      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl = buildAuthUrl({
        clientId: trimmed,
        redirectUri,
        challenge: pair.challenge,
        state,
      });
      const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
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
      setEmail(user.email);
      const synced = await syncWorkspaceToDrive(getDb(), workspaceId, {
        token: nextTokens.accessToken,
        force: true,
      });
      setWebViewLink(synced.webViewLink);
      setNotice(`Connected${user.email ? ` as ${user.email}` : ''} and synced the workbook.`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function connectGmail() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await requestOrigins(GMAIL_ORIGINS);
      const trimmed = clientId.trim();
      if (!trimmed) throw new Error('Enter your Google OAuth client ID first.');
      await saveDriveClientId(trimmed);
      const pair = await createPkcePair();
      const state = randomUrlSafe(24);
      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl = buildAuthUrl({
        clientId: trimmed,
        redirectUri,
        challenge: pair.challenge,
        state,
        scopes: GMAIL_SCOPES,
      });
      const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
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
      setEmail(user.email);
      setNotice('Gmail read-only access enabled. Gmail API access requires Google verification.');
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function syncGmail() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await withToken(
        (token) =>
          syncGmailStatements(getDb(), workspaceId, {
            accessToken: token,
            query: gmailQuery.trim() || DEFAULT_GMAIL_QUERY,
            maxResults: 25,
          }),
        GMAIL_ORIGINS,
      );
      const lines = result.batches.reduce((sum, batch) => sum + batch.batch.totalLines, 0);
      setNotice(
        `Gmail: scanned ${result.messages} message(s), staged ${lines} line(s) across ${result.batches.length} batch(es)${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token) await revokeToken(token).catch(() => undefined);
      await clearDriveTokens();
      setTokens(undefined);
      setEmail(undefined);
      setDiff(undefined);
      setSnapshot(undefined);
      setNotice('Google Drive disconnected on this browser.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function withToken<T>(
    action: (token: string) => Promise<T>,
    origins: string[] = DRIVE_ORIGINS,
  ): Promise<T> {
    await requestOrigins(origins);
    const token = await getDriveAccessToken();
    if (!token) throw new Error('Connect Google Drive first.');
    return action(token);
  }

  async function syncNow() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await withToken((token) =>
        syncWorkspaceToDrive(getDb(), workspaceId, { token, force: true }),
      );
      setWebViewLink(result.webViewLink);
      setNotice(
        result.skipped
          ? 'Workbook already up to date.'
          : `Synced ${result.sheets} sheets to Google Sheets.`,
      );
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function compare() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await withToken(async (token) => {
        const location = await ensureDriveLocation(getDb(), workspaceId, token);
        const remote = await readDriveSnapshot(token, location.workbook.id);
        const comparison = await diffDriveSnapshot(getDb(), workspaceId, remote);
        return { remote, comparison, webViewLink: location.workbook.webViewLink };
      });
      setSnapshot(result.remote);
      setDiff(result.comparison);
      setWebViewLink(result.webViewLink);
      setConfirmRestore(false);
      setNotice(
        `Drive comparison: ${result.comparison.changed} changed, ${result.comparison.remoteOnly} only in Drive, ${result.comparison.localOnly} only local.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function readExternal() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const fileId = parseDriveFileId(externalRef);
      if (!fileId) throw new Error('Paste a Google Sheets URL or file id.');
      const result = await withToken(async (token) => {
        const remote = await readDriveSnapshot(token, fileId);
        const comparison = await diffDriveSnapshot(getDb(), workspaceId, remote);
        return { remote, comparison };
      });
      setSnapshot(result.remote);
      setDiff(result.comparison);
      setConfirmRestore(false);
      setNotice(
        `Read external workbook: ${result.comparison.changed} changed, ${result.comparison.remoteOnly} only in Drive, ${result.comparison.localOnly} only local. Nothing was overwritten.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!snapshot) return;
    if (restoreMode === 'replace' && !confirmRestore) {
      setError('Confirm that replace mode erases local rows for this workspace.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await restoreDriveSnapshot(getDb(), workspaceId, snapshot, restoreMode);
      setNotice(`Restored ${result.restored} records from Google Drive (${result.mode}).`);
      setConfirmRestore(false);
      setDiff(undefined);
      setSnapshot(undefined);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Choose an archive month.');
      const result = await withToken((token) =>
        archiveMonthToDrive(getDb(), workspaceId, period, { token }),
      );
      setNotice(`Saved ${result.file.name} to Drive.`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drive-panel">
      {error ? <div className="alert danger">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      <p className="muted">
        Connect a Google Cloud OAuth desktop client with the Drive API enabled. The extension uses
        PKCE, asks only for <code>drive.file</code>, and never writes to workbooks it did not create.
      </p>

      <div className="form-grid">
        <label>
          <span>OAuth client ID</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            disabled={Boolean(tokens)}
          />
        </label>
      </div>

      <div className="drive-actions">
        {tokens ? (
          <>
            <span className="badge">Connected{email ? ` · ${email}` : ''}</span>
            <button onClick={() => void syncNow()} disabled={busy}>
              Sync now
            </button>
            <button className="ghost" onClick={() => void compare()} disabled={busy}>
              Compare with Drive
            </button>
            <button className="ghost" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </button>
          </>
        ) : (
          <button onClick={() => void connect()} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect Google Drive'}
          </button>
        )}
      </div>

      {link ? (
        <p className="muted small">
          Workbook file id: <code>{link.fileId}</code>
          {link.lastSyncedAt ? ` · last sync ${link.lastSyncedAt}` : ''}
          {webViewLink ? (
            <>
              {' · '}
              <a href={webViewLink} target="_blank" rel="noreferrer">
                Open in Drive
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <h3>Gmail statement import</h3>
      <p className="muted small">
        Optional read-only Gmail access. Imported statements are staged for review; emails and
        attachments are not retained. Restricted Gmail scopes may require Google verification.
      </p>
      <div className="form-grid">
        <label>
          <span>Gmail search query</span>
          <input
            value={gmailQuery}
            onChange={(event) => setGmailQuery(event.target.value)}
            disabled={!hasGmailScope}
          />
        </label>
      </div>
      {hasGmailScope ? (
        <button className="ghost" onClick={() => void syncGmail()} disabled={busy}>
          Import recent Gmail statements
        </button>
      ) : (
        <button className="ghost" onClick={() => void connectGmail()} disabled={busy || !tokens}>
          Enable read-only Gmail access
        </button>
      )}

      <h3>External workbook</h3>
      <p className="muted small">
        Paste a Google Sheets URL or file id to compare it read-only. 0ledger never overwrites a
        workbook it did not create; restoring copies data into the local ledger.
      </p>
      <div className="form-grid">
        <label>
          <span>Sheets URL or file id</span>
          <input
            value={externalRef}
            onChange={(event) => setExternalRef(event.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
          />
        </label>
      </div>
      <button className="ghost" onClick={() => void readExternal()} disabled={busy || !tokens}>
        Read external workbook
      </button>

      <h3>Monthly XLSX archive</h3>
      <div className="form-grid">
        <label>
          <span>Month</span>
          <input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </label>
      </div>
      <button className="ghost" onClick={() => void archive()} disabled={busy || !tokens}>
        Archive month to Drive
      </button>

      {diff ? (
        <div className="drive-diff">
          <h3>Drive comparison</h3>
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Drive</th>
                <th>Local</th>
                <th>Changed</th>
                <th>Drive only</th>
                <th>Local only</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(diff.tables)
                .filter(
                  ([, row]) =>
                    row.changed > 0 || row.remoteOnly > 0 || row.localOnly > 0,
                )
                .map(([table, row]) => (
                  <tr key={table}>
                    <td>{table}</td>
                    <td>{row.remote}</td>
                    <td>{row.local}</td>
                    <td>{row.changed}</td>
                    <td>{row.remoteOnly}</td>
                    <td>{row.localOnly}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="form-grid">
            <label>
              <span>Restore mode</span>
              <select
                value={restoreMode}
                onChange={(event) => {
                  setRestoreMode(event.target.value as RestoreMode);
                  setConfirmRestore(false);
                }}
              >
                <option value="merge">Merge Drive into local</option>
                <option value="replace">Replace local workspace</option>
              </select>
            </label>
          </div>
          {restoreMode === 'replace' ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmRestore}
                onChange={(event) => setConfirmRestore(event.target.checked)}
              />
              <span>I understand this erases local rows for this workspace.</span>
            </label>
          ) : null}
          <button onClick={() => void restore()} disabled={busy}>
            Restore from Drive
          </button>
        </div>
      ) : null}
    </div>
  );
}
