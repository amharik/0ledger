import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  getDefaultFolders,
  getWatcherConfig,
  saveWatcherConfig,
  scanInboxFolder,
  runFolderIngestionCycle,
  type DiscoveredFile,
  type FolderWatcherConfig,
  type IngestCycleResult,
} from '@/core/desktop/folder-watcher';

interface Props {
  workspaceId: string;
  companyName: string;
  onNotice: (msg: string) => void;
}

export function FolderWatcherPanel({ workspaceId, companyName, onNotice }: Props) {
  const [config, setConfig] = useState<FolderWatcherConfig>(() => getWatcherConfig(workspaceId));
  const [discovered, setDiscovered] = useState<DiscoveredFile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [report, setReport] = useState<IngestCycleResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void getDefaultFolders().then((defaults) => {
      setConfig((current) => {
        if (current.watchFolder === '~/Downloads' && defaults.watch_folder !== '~/Downloads') {
          return {
            ...current,
            watchFolder: defaults.watch_folder,
            archiveFolder: defaults.archive_folder,
          };
        }
        return current;
      });
    });
  }, []);

  const updateConfig = (patch: Partial<FolderWatcherConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveWatcherConfig(workspaceId, next);
      return next;
    });
  };

  async function handleScan() {
    setScanning(true);
    setError(undefined);
    try {
      const files = await scanInboxFolder(config.watchFolder);
      setDiscovered(files);
      if (files.length === 0) {
        onNotice(`No accounting statements found in ${config.watchFolder}`);
      } else {
        onNotice(`Found ${files.length} statement file${files.length === 1 ? '' : 's'} in ${config.watchFolder}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function handleIngestNow() {
    setIngesting(true);
    setError(undefined);
    try {
      const db = getDb();
      const res = await runFolderIngestionCycle(db, workspaceId, companyName, config, pdfPassword);
      setReport(res);
      if (res.transactionsCreated > 0) {
        onNotice(`Ingested ${res.newFilesIngested} file(s) and created ${res.transactionsCreated} transaction(s) in Money Inbox!`);
      } else if (res.discovered === 0) {
        onNotice(`No statement files found in ${config.watchFolder}`);
      } else {
        onNotice(`All ${res.discovered} file(s) in watch folder have already been processed.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  }

  return (
    <section className="card">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>📁 Folder Auto-Watcher & Accounting Vault</h2>
          <p className="muted small" style={{ margin: '0.25rem 0 0 0' }}>
            Watches your local folder for downloaded bank statements, PDFs, and bills. Auto-ingests to Money Inbox and organizes into your accounting vault.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="ghost small-button" disabled={scanning || ingesting} onClick={() => void handleScan()}>
            {scanning ? 'Scanning…' : '🔍 Scan Folder'}
          </button>
          <button type="button" className="secondary small-button" disabled={ingesting || scanning} onClick={() => void handleIngestNow()}>
            {ingesting ? 'Processing…' : '⚡ Ingest & Auto-Organize Now'}
          </button>
        </div>
      </div>

      {error ? <div className="alert danger" style={{ marginTop: '1rem' }}>{error}</div> : null}

      <div className="form-grid" style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <label>
          Watch Folder Path (Downloads / Accounting Inbox)
          <input
            type="text"
            value={config.watchFolder}
            onChange={(e) => updateConfig({ watchFolder: e.target.value })}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
          />
          <span className="muted small">Where your bank statements and e-bills are downloaded</span>
        </label>

        <label>
          Archive Vault Folder Path
          <input
            type="text"
            value={config.archiveFolder}
            onChange={(e) => updateConfig({ archiveFolder: e.target.value })}
            style={{ width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
          />
          <span className="muted small">Organized tree: <code>~/0ledger/Archive/{'{Company}'}/{'{FY}'}/{'{Month}'}/{'{Category}'}</code></span>
        </label>
      </div>

      <div style={{ marginTop: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.autoOrganize}
            onChange={(e) => updateConfig({ autoOrganize: e.target.checked })}
          />
          <strong>Auto-organize files into Accounting Vault upon ingestion</strong>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          File action:
          <select
            value={config.action}
            onChange={(e) => updateConfig({ action: e.target.value as 'move' | 'copy' })}
            style={{ padding: '0.3rem 0.6rem' }}
          >
            <option value="copy">Copy to Vault (keep original in watch folder)</option>
            <option value="move">Move to Vault (clean watch folder)</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          PDF Password:
          <input
            type="password"
            placeholder="optional"
            value={pdfPassword}
            onChange={(e) => setPdfPassword(e.target.value)}
            style={{ width: '130px', padding: '0.3rem 0.5rem' }}
          />
        </label>
      </div>

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
          <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Ingestion & Organization Report</h4>
          <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem' }}>
            <span>Discovered: <strong>{report.discovered}</strong></span>
            <span>New Files Ingested: <strong style={{ color: 'var(--accent)' }}>{report.newFilesIngested}</strong></span>
            <span>Transactions Created: <strong style={{ color: '#4caf50' }}>{report.transactionsCreated}</strong></span>
            <span>Files Vaulted: <strong>{report.filesOrganized.length}</strong></span>
          </div>

          {report.filesOrganized.length > 0 ? (
            <div style={{ marginTop: '0.75rem' }}>
              <div className="muted small" style={{ marginBottom: '0.25rem' }}>Vault Destinations:</div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8rem', color: 'var(--text)' }}>
                {report.filesOrganized.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: '0.2rem' }}>
                    <code>{item.destination}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.errors.length > 0 ? (
            <div style={{ marginTop: '0.5rem', color: 'var(--danger)', fontSize: '0.8rem' }}>
              Errors:
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {report.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {discovered.length > 0 ? (
        <div style={{ marginTop: '1.5rem' }}>
          <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>
            Discovered Statement Files ({discovered.length})
          </h4>
          <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'var(--panel)', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Filename</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Type</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Size</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Modified</th>
                </tr>
              </thead>
              <tbody>
                {discovered.map((file) => (
                  <tr key={file.sha256} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.5rem 0.75rem' }}>{file.filename}</td>
                    <td style={{ padding: '0.5rem 0.75rem' }}><span className="badge">{file.extension.toUpperCase()}</span></td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>{(file.size_bytes / 1024).toFixed(1)} KB</td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      {file.modified_ms ? new Date(file.modified_ms).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
