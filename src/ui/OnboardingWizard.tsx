import { useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import { createWorkspace, type CreateWorkspaceInput } from '@/core/db/workspace-service';
import { setActiveWorkspaceId } from './workspace';
import { stageImport } from '@/core/ingest';
import { parseTextStatement } from '@/core/ingest/parsers';
import { captureStatementLines } from '@/core/autopilot';
import { createLedger } from '@/core/db/ledger-service';

export const INDIAN_STATES = [
  { code: '29', name: 'Karnataka' },
  { code: '27', name: 'Maharashtra' },
  { code: '07', name: 'Delhi' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '36', name: 'Telangana' },
  { code: '24', name: 'Gujarat' },
  { code: '19', name: 'West Bengal' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '06', name: 'Haryana' },
  { code: '03', name: 'Punjab' },
  { code: '08', name: 'Rajasthan' },
  { code: '10', name: 'Bihar' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '30', name: 'Goa' },
  { code: '32', name: 'Kerala' },
  { code: '05', name: 'Uttarakhand' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '04', name: 'Chandigarh' },
  { code: '18', name: 'Assam' },
];

interface Props {
  onCompleted: (workspaceId: string) => void;
  onCancel?: (() => void) | undefined;
}

export function OnboardingWizard({ onCompleted, onCancel }: Props) {
  const [name, setName] = useState('');
  const [state, setState] = useState('Karnataka');
  const [gstin, setGstin] = useState('');
  const [booksBegin, setBooksBegin] = useState('2026-04-01');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please enter your business or company name.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const input: CreateWorkspaceInput = {
        name: trimmed,
        state,
        booksBegin,
      };
      if (gstin.trim()) {
        input.gstin = gstin.trim().toUpperCase();
      }
      const bundle = await createWorkspace(db, input);
      await setActiveWorkspaceId(bundle.workspace.id);
      onCompleted(bundle.workspace.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  async function handleLoadDemo() {
    setBusy(true);
    setError(undefined);
    try {
      const db = getDb();
      const bundle = await createWorkspace(db, {
        name: 'Acme Traders',
        companyLegalName: 'Acme Traders Private Limited',
        state: 'Karnataka',
        gstin: '29AABCA1234F1Z5',
        booksBegin: '2026-04-01',
      });
      const wsId = bundle.workspace.id;

      // Find Sundry Debtors and Sundry Creditors groups
      const debtorsGroup = bundle.groups.find((g) => g.primaryGroup === 'Sundry Debtors');
      const creditorsGroup = bundle.groups.find((g) => g.primaryGroup === 'Sundry Creditors');

      if (debtorsGroup) {
        await createLedger(db, {
          workspaceId: wsId,
          name: 'Infosys Client Services',
          groupId: debtorsGroup.id,
        });
      }

      if (creditorsGroup) {
        await createLedger(db, {
          workspaceId: wsId,
          name: 'Apex Cloud Hosting Vendor',
          groupId: creditorsGroup.id,
        });
      }

      // Seed sample email statement lines into Money Inbox
      const sampleText = `Date,Description,Debit,Credit,Balance
2026-11-20,NEFT Cr from Infosys Client Services Inv 104,,85000.00,185000.00
2026-11-19,UPI/P2M/Swiggy Bangalore Office Pantry,1450.00,,183550.00
2026-11-18,IMPS to Apex Cloud Hosting Vendor,32000.00,,151550.00
2026-11-17,FASTag Toll Plaza Electronic City,450.00,,151100.00
2026-11-16,Bank Quarterly Account Charges,500.00,,150600.00`;

      const statement = parseTextStatement(sampleText, { fileName: 'sample-email-statement.csv' });
      const staged = await stageImport(db, {
        workspaceId: wsId,
        source: 'email',
        statement,
        fileName: 'sample-email-statement.csv',
      });
      await captureStatementLines(db, wsId, staged.batch, staged.lines);

      await setActiveWorkspaceId(wsId);
      onCompleted(wsId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: '720px', margin: '2rem auto', padding: '0 1rem' }}>
      <div className="card" style={{ padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.75rem', margin: '0 0 0.5rem 0' }}>Welcome to 0ledger</h2>
          <p className="muted" style={{ margin: 0, fontSize: '1rem' }}>
            Local-first accounting and GST ledger for Indian businesses. Secure, offline-first, and zero float bugs.
          </p>
        </div>

        {error ? <div className="alert danger" style={{ marginBottom: '1.5rem' }}>{error}</div> : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
          <div>
            <h3 style={{ fontSize: '1.15rem', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              Create Your Company
            </h3>
            <form onSubmit={handleCreate}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <label>
                  Company / Trade Name <span style={{ color: 'var(--danger)' }}>*</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Acme Enterprises or Sharma & Co."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ width: '100%', padding: '0.6rem 0.8rem', marginTop: '0.25rem' }}
                  />
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <label>
                    State (GST Code)
                    <select
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem 0.8rem', marginTop: '0.25rem' }}
                    >
                      {INDIAN_STATES.map((s) => (
                        <option key={s.code} value={s.name}>
                          {s.name} ({s.code})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    GSTIN <span className="muted small">(Optional)</span>
                    <input
                      type="text"
                      maxLength={15}
                      placeholder="e.g. 29AABCA1234F1Z5"
                      value={gstin}
                      onChange={(e) => setGstin(e.target.value)}
                      style={{ width: '100%', padding: '0.6rem 0.8rem', marginTop: '0.25rem', textTransform: 'uppercase' }}
                    />
                  </label>
                </div>

                <label>
                  Books Begin Date
                  <input
                    type="date"
                    value={booksBegin}
                    onChange={(e) => setBooksBegin(e.target.value)}
                    style={{ width: '100%', padding: '0.6rem 0.8rem', marginTop: '0.25rem' }}
                  />
                </label>

                <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', alignItems: 'center' }}>
                  <button type="submit" disabled={busy} style={{ flex: 1, padding: '0.75rem' }}>
                    {busy ? 'Setting up…' : '🚀 Create Company & Launch'}
                  </button>
                  {onCancel ? (
                    <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            </form>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1.5rem', textAlign: 'center' }}>
            <p className="muted small" style={{ marginBottom: '0.75rem' }}>
              Want to explore with real sample data first?
            </p>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => void handleLoadDemo()}
              style={{ width: '100%', padding: '0.6rem' }}
            >
              ✨ Load Demo Company (Acme Traders with Sample Inbox & Ledgers)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
