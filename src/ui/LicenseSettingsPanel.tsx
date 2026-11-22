import { useEffect, useState } from 'react';
import {
  getLicenseState,
  createLicenseKey,
  type LicenseState,
  type LicenseTier,
} from '@/core/license/license';

interface Props {
  workspaceCreatedAt?: string | undefined;
  onNotice?: ((message: string) => void) | undefined;
}

const STORAGE_KEY = '0ledger_license_key';

export function LicenseSettingsPanel({ workspaceCreatedAt, onNotice }: Props) {
  const [keyInput, setKeyInput] = useState('');
  const [licenseState, setLicenseState] = useState<LicenseState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void load();
  }, [workspaceCreatedAt]);

  async function load() {
    setLoading(true);
    try {
      const stored = localStorage.getItem(STORAGE_KEY) ?? undefined;
      if (stored) setKeyInput(stored);
      const state = await getLicenseState(stored, workspaceCreatedAt);
      setLicenseState(state);
    } finally {
      setLoading(false);
    }
  }

  async function applyKey(keyToApply = keyInput) {
    setError(undefined);
    try {
      const state = await getLicenseState(keyToApply.trim(), workspaceCreatedAt);
      if (keyToApply.trim() && state.tier === 'community') {
        setError('Invalid or expired license key. Please check the code.');
        return;
      }
      localStorage.setItem(STORAGE_KEY, keyToApply.trim());
      setLicenseState(state);
      onNotice?.(`License updated to ${state.tier.toUpperCase()} tier.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function generateTestKey(tier: LicenseTier) {
    const today = new Date().toISOString().slice(0, 10);
    const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const key = await createLicenseKey({
      licensee: 'Demo Business Owner',
      email: 'owner@example.com',
      tier,
      issuedAt: today,
      expiresAt: nextYear,
      maxWorkspaces: tier === 'ca_practice' ? 50 : 1,
    });
    setKeyInput(key);
    await applyKey(key);
  }

  function removeKey() {
    localStorage.removeItem(STORAGE_KEY);
    setKeyInput('');
    void load();
    onNotice?.('License key removed.');
  }

  return (
    <section className="card license-panel">
      <div className="section-head">
        <div>
          <h2>Product Edition & Subscription</h2>
          <span className="muted small">Autopilot Pro & CA Practice Licensing</span>
        </div>
        <div>
          {licenseState?.tier === 'pro' && !licenseState.isTrial ? (
            <span className="badge positive">Pro Active</span>
          ) : licenseState?.isTrial ? (
            <span className="badge" style={{ background: '#f59e0b', color: '#fff' }}>
              1-Year Pro Trial ({licenseState.trialDaysRemaining} days left)
            </span>
          ) : licenseState?.tier === 'ca_practice' ? (
            <span className="badge positive">CA Practice Edition</span>
          ) : (
            <span className="badge">Community (Free)</span>
          )}
        </div>
      </div>

      {error ? <div className="alert danger">{error}</div> : null}

      <div style={{ margin: '1rem 0' }}>
        <p className="muted small">
          Enter your license key received after subscribing via Razorpay or Stripe. Pro unlocks
          GSTR-2B automated reconciliation, Direct Localhost Tally Prime push, OCR bill scanning,
          and priority CA close packs.
        </p>

        <div className="form-grid" style={{ marginBottom: '0.75rem' }}>
          <label>
            <span>License Key</span>
            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="0L-PRO-..."
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => applyKey(keyInput)} disabled={loading}>
            Activate Key
          </button>
          {keyInput ? (
            <button type="button" className="ghost" onClick={removeKey}>
              Clear Key
            </button>
          ) : null}
          <button
            type="button"
            className="ghost small-button"
            onClick={() => generateTestKey('pro')}
          >
            Activate Free Pro Trial Key
          </button>
          <button
            type="button"
            className="ghost small-button"
            onClick={() => generateTestKey('ca_practice')}
          >
            Activate CA Practice Key
          </button>
        </div>
      </div>

      <div style={{ marginTop: '1.25rem', borderTop: '1px solid #e5e7eb', paddingTop: '1rem' }}>
        <strong style={{ fontSize: '0.9rem' }}>Included Features in Current Tier:</strong>
        <ul style={{ fontSize: '0.85rem', marginTop: '0.5rem', paddingLeft: '1.2rem' }}>
          <li>
            Double-Entry Accounting Core & Integer Money: <span className="positive">✓ Active</span>
          </li>
          <li>
            10+ Indian Bank Statement & FASTag Parsers: <span className="positive">✓ Active</span>
          </li>
          <li>
            GSTR-2B Input Tax Credit Matching & Vendor Alerts:{' '}
            <span className={licenseState?.tier !== 'community' ? 'positive' : 'muted'}>
              {licenseState?.tier !== 'community' ? '✓ Active (Pro)' : '🔒 Pro Upgrade'}
            </span>
          </li>
          <li>
            Direct Tally Prime Localhost Bridge (1-Click Push):{' '}
            <span className={licenseState?.tier !== 'community' ? 'positive' : 'muted'}>
              {licenseState?.tier !== 'community' ? '✓ Active (Pro)' : '🔒 Pro Upgrade'}
            </span>
          </li>
          <li>
            OCR Invoice & Bill Text Extractor:{' '}
            <span className={licenseState?.tier !== 'community' ? 'positive' : 'muted'}>
              {licenseState?.tier !== 'community' ? '✓ Active (Pro)' : '🔒 Pro Upgrade'}
            </span>
          </li>
          <li>
            Multi-Client Firm Dashboard & Batch Exports:{' '}
            <span className={licenseState?.tier === 'ca_practice' ? 'positive' : 'muted'}>
              {licenseState?.tier === 'ca_practice' ? '✓ Active (CA Practice)' : '🔒 CA Practice Tier'}
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}
