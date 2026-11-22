import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import { loadWorkbookData } from '@/core/template/data';
import {
  testTallyConnection,
  pushLedgerToTallyPrime,
  type TallyConnectionStatus,
  type TallyPushResult,
} from '@/core/interchange/tally-bridge';

interface Props {
  workspaceId: string;
  onNotice?: (message: string) => void;
}

export function TallyBridgePanel({ workspaceId, onNotice }: Props) {
  const [endpoint, setEndpoint] = useState('http://localhost:9000');
  const [status, setStatus] = useState<TallyConnectionStatus>();
  const [checking, setChecking] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<TallyPushResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void checkConnection();
  }, [endpoint]);

  async function checkConnection() {
    setChecking(true);
    setError(undefined);
    try {
      const res = await testTallyConnection(endpoint);
      setStatus(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  async function pushToTally() {
    setPushing(true);
    setResult(undefined);
    setError(undefined);
    try {
      const db = getDb();
      const data = await loadWorkbookData(db, workspaceId);
      const res = await pushLedgerToTallyPrime(data, { endpoint });
      setResult(res);

      if (res.success) {
        onNotice?.(
          `Successfully pushed to Tally Prime: ${res.created} created, ${res.altered} altered.`,
        );
      } else {
        setError(
          res.errorMessages.length > 0
            ? res.errorMessages.join(' · ')
            : 'Push failed with errors in Tally Prime.',
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }

  return (
    <section className="card tally-bridge-panel">
      <div className="section-head">
        <div>
          <h2>Tally Prime Live Bridge</h2>
          <span className="muted small">Direct 1-click XML push over localhost:9000</span>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="ghost small-button"
            onClick={checkConnection}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Test Connection'}
          </button>
        </div>
      </div>

      <div className="form-grid" style={{ marginBottom: '1rem' }}>
        <label>
          <span>Tally Server Endpoint</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://localhost:9000"
          />
        </label>
      </div>

      <div
        className="connection-status-box"
        style={{
          padding: '0.75rem',
          borderRadius: '6px',
          background: status?.online ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          border: `1px solid ${status?.online ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <strong>Status: </strong>
            <span style={{ color: status?.online ? '#10b981' : '#ef4444' }}>
              {status?.online ? 'Connected to Tally Prime' : 'Disconnected / Offline'}
            </span>
          </div>
          {status?.companyNames && status.companyNames.length > 0 ? (
            <span className="badge">
              Active Company: {status.companyNames[0]}
            </span>
          ) : null}
        </div>

        {status?.helpTip ? (
          <p className="muted small" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
            💡 {status.helpTip}
          </p>
        ) : null}
      </div>

      {error ? <div className="alert danger">{error}</div> : null}

      {result ? (
        <div
          className={`alert ${result.success ? 'success' : 'danger'}`}
          style={{ marginBottom: '1rem' }}
        >
          <div>
            <strong>{result.success ? 'Import Succeeded!' : 'Tally Import Finished with Errors'}</strong>
            <div className="small">
              Created: {result.created} · Altered: {result.altered} · Errors: {result.errors}
            </div>
            {result.errorMessages.length > 0 ? (
              <ul style={{ marginTop: '0.5rem', paddingLeft: '1.2rem' }}>
                {result.errorMessages.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={pushToTally}
          disabled={pushing || !status?.online}
          className="button"
        >
          {pushing ? 'Pushing to Tally…' : 'Push All Vouchers to Tally Prime'}
        </button>
      </div>
    </section>
  );
}
