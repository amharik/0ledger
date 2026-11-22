import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
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

interface EnginePanelProps {
  workspaceId: string;
}

export function EnginePanel({ workspaceId }: EnginePanelProps) {
  const available = isNativeStoreAvailable();
  const [engineVersion, setEngineVersion] = useState<string>();
  const [deviceId, setDeviceId] = useState<string>();
  const [schemaVersion, setSchemaVersion] = useState<number>();
  const [integrity, setIntegrity] = useState<IntegrityReport>();
  const [verification, setVerification] = useState<LedgerVerification>();
  const [syncKey, setSyncKey] = useState<string>();
  const [envelopeOut, setEnvelopeOut] = useState('');
  const [envelopeIn, setEnvelopeIn] = useState('');
  const [backupPath, setBackupPath] = useState('0ledger-backup.sqlite3');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!available) return;
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
      .catch((e: unknown) => setError(String(e)));
  }, [available]);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!available) {
    return (
      <div className="panel">
        <h2>Portable Engine</h2>
        <p className="muted">
          The SQLite engine is available inside the native Tauri desktop app. This browser
          build keeps using the Dexie cache.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="panel">
        <h2>Portable Engine</h2>
        <p className="muted small">
          SQLite is the authoritative local store. The same Rust engine is exposed to Kotlin
          and Swift through UniFFI.
        </p>
        <div className="grid two">
          <div>
            <span className="muted small">Engine version</span>
            <div>{engineVersion ?? '—'}</div>
          </div>
          <div>
            <span className="muted small">Schema version</span>
            <div>{schemaVersion ?? '—'}</div>
          </div>
          <div>
            <span className="muted small">Device id</span>
            <div style={{ wordBreak: 'break-all' }}>{deviceId ?? '—'}</div>
          </div>
        </div>
      </div>

      {notice ? <div className="alert success">{notice}</div> : null}
      {error ? <div className="alert danger">{error}</div> : null}

      <div className="panel">
        <h2>Migration</h2>
        <p className="muted small">
          Copy this workspace from the legacy Dexie cache into SQLite. Safe to re-run.
        </p>
        <button
          className="secondary small-button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const summary = await migrateWorkspaceToSqlite(getDb(), workspaceId);
              return `Migrated ${summary.workspaces} workspace(s), ${summary.ledgers} ledgers, ${summary.vouchers} vouchers.`;
            })
          }
        >
          {busy ? 'Working…' : 'Migrate this workspace to SQLite'}
        </button>
      </div>

      <div className="panel">
        <h2>Integrity & Backup</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className="secondary small-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await verifyWorkspace(getDb(), workspaceId);
                setVerification(result);
                return result.ok
                  ? 'SQLite and the local cache agree.'
                  : `${result.issues.length} divergence(s) found.`;
              })
            }
          >
            Verify SQLite vs cache
          </button>
          <button
            className="secondary small-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const summary = await mirrorAllWorkspaces(getDb());
                return summary
                  ? `Mirrored ${summary.workspaces} workspace(s), ${summary.ledgers} ledgers, ${summary.vouchers} vouchers.`
                  : 'Native store unavailable.';
              })
            }
          >
            Mirror all workspaces
          </button>
          <button
            className="secondary small-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const report = await nativeStore.integrityCheck(workspaceId);
                setIntegrity(report);
                return report.ok
                  ? `Verified ${report.checkedVouchers} vouchers and ${report.checkedAuditEvents} audit events.`
                  : `${report.issues.length} integrity issue(s) found.`;
              })
            }
          >
            Run integrity check
          </button>
          <input
            value={backupPath}
            onChange={(e) => setBackupPath(e.target.value)}
            placeholder="Backup file path"
            style={{ minWidth: '16rem' }}
          />
          <button
            className="secondary small-button"
            disabled={busy || backupPath.trim().length === 0}
            onClick={() =>
              void run(async () => {
                await nativeStore.backupTo(backupPath.trim());
                return `Backup written to ${backupPath.trim()}.`;
              })
            }
          >
            Back up SQLite snapshot
          </button>
        </div>
        {integrity ? (
          <div style={{ marginTop: '0.75rem' }}>
            <span className={integrity.ok ? 'badge positive' : 'badge negative'}>
              {integrity.ok ? 'Integrity OK' : 'Integrity issues'}
            </span>
            {integrity.issues.length > 0 ? (
              <ul className="muted small">
                {integrity.issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <strong>{issue.code}</strong>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {verification ? (
          <div style={{ marginTop: '0.75rem' }}>
            <span className={verification.ok ? 'badge positive' : 'badge negative'}>
              {verification.ok ? 'SQLite matches the cache' : 'SQLite divergence'}
            </span>
            {verification.issues.length > 0 ? (
              <ul className="muted small">
                {verification.issues.map((issue, index) => (
                  <li key={`${issue}-${index}`}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <h2>Device-to-device sync</h2>
        <p className="muted small">
          Pair devices with a shared sync key, then move sealed envelopes over any channel.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <button
            className="secondary small-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const key = await nativeStore.generateSyncKey();
                setSyncKey(key);
                return 'New sync key generated. Store it securely and share it only with your own devices.';
              })
            }
          >
            Generate sync key
          </button>
          <button
            className="secondary small-button"
            disabled={busy || !syncKey}
            onClick={() =>
              void run(async () => {
                const envelope = await nativeStore.exportSyncEnvelope(syncKey as string, 0);
                setEnvelopeOut(envelope);
                return 'Exported a sealed change set.';
              })
            }
          >
            Export changes
          </button>
          <button
            className="secondary small-button"
            disabled={busy || !syncKey || envelopeIn.trim().length === 0}
            onClick={() =>
              void run(async () => {
                const summary: ApplySummary = await nativeStore.importSyncEnvelope(
                  syncKey as string,
                  envelopeIn.trim(),
                );
                return `Applied ${summary.applied}, ignored ${summary.ignored}, skipped ${summary.skipped}.`;
              })
            }
          >
            Apply received changes
          </button>
        </div>
        {syncKey ? (
          <label className="muted small" style={{ display: 'block', marginBottom: '0.75rem' }}>
            Sync key
            <input value={syncKey} readOnly style={{ width: '100%' }} />
          </label>
        ) : null}
        <label className="muted small" style={{ display: 'block', marginBottom: '0.5rem' }}>
          Outgoing envelope
          <textarea value={envelopeOut} readOnly rows={4} style={{ width: '100%' }} />
        </label>
        <label className="muted small" style={{ display: 'block' }}>
          Incoming envelope
          <textarea
            value={envelopeIn}
            onChange={(e) => setEnvelopeIn(e.target.value)}
            rows={4}
            style={{ width: '100%' }}
          />
        </label>
      </div>
    </div>
  );
}
