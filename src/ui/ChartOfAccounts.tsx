import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import {
  createLedger,
  removeLedger,
  updateLedger,
  type CreateLedgerInput,
} from '@/core/db/ledger-service';
import {
  getWorkspaceBundle,
  type WorkspaceBundle,
} from '@/core/db/workspace-service';
import {
  formatMinor,
  minorToDecimalString,
  parseAmountToMinor,
} from '@/core/money/money';
import type { Ledger } from '@/core/model';

type Side = 'debit' | 'credit';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function signedMinor(amount: string, side: Side): number {
  const text = amount.trim();
  if (!text) return 0;
  const value = parseAmountToMinor(text);
  return side === 'debit' ? value : -value;
}

export default function ChartOfAccounts({ workspaceId }: { workspaceId: string }) {
  const [bundle, setBundle] = useState<WorkspaceBundle>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [code, setCode] = useState('');
  const [opening, setOpening] = useState('');
  const [side, setSide] = useState<Side>('debit');

  const [editLedgerId, setEditLedgerId] = useState('');
  const [editOpening, setEditOpening] = useState('');
  const [editSide, setEditSide] = useState<Side>('debit');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getWorkspaceBundle(getDb(), workspaceId);
      if (!next) throw new Error('Workspace not found');
      setBundle(next);
      setGroupId((current) => current || next.groups.find((group) => group.name === 'Indirect Expenses')?.id || next.groups[0]?.id || '');
      const first = next.ledgers.find((ledger) => !ledger.archived && !ledger.isSystem);
      setEditLedgerId((current) => current || first?.id || '');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const selected = bundle?.ledgers.find((ledger) => ledger.id === editLedgerId);
    if (!selected) return;
    setEditOpening(minorToDecimalString(Math.abs(selected.openingBalanceMinor)));
    setEditSide(selected.openingBalanceMinor < 0 ? 'credit' : 'debit');
  }, [bundle, editLedgerId]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    if (!name.trim()) {
      setError('Ledger name is required.');
      return;
    }
    if (!groupId) {
      setError('Choose a ledger group.');
      return;
    }

    setBusy(true);
    try {
      const input: CreateLedgerInput = {
        workspaceId,
        name: name.trim(),
        groupId,
        openingBalanceMinor: signedMinor(opening, side),
      };
      if (code.trim()) input.code = code.trim();
      const created = await createLedger(getDb(), input);
      setNotice(`Created ${created.ledger.name} under ${created.ledger.tallyParent}.`);
      setName('');
      setCode('');
      setOpening('');
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveOpening(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    if (!editLedgerId) {
      setError('Choose a ledger to edit.');
      return;
    }

    setBusy(true);
    try {
      const updated = await updateLedger(getDb(), editLedgerId, {
        openingBalanceMinor: signedMinor(editOpening, editSide),
      });
      setNotice(`Updated opening balance for ${updated.name}.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(ledger: Ledger) {
    if (!window.confirm(`Remove “${ledger.name}”? Used ledgers are archived, not deleted.`)) return;
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const result = await removeLedger(getDb(), ledger.id);
      setNotice(result === 'archived' ? `${ledger.name} archived.` : `${ledger.name} deleted.`);
      if (editLedgerId === ledger.id) setEditLedgerId('');
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !bundle) return <p className="muted">Loading chart of accounts…</p>;
  if (!bundle) return <p className="muted">No chart of accounts loaded.</p>;

  const ledgerGroups = [...bundle.groups].sort((a, b) => a.name.localeCompare(b.name));
  const ledgers = bundle.ledgers
    .filter((ledger) => !ledger.archived)
    .sort(
      (a, b) =>
        a.tallyParent.localeCompare(b.tallyParent) || a.name.localeCompare(b.name),
    );

  return (
    <div className="chart-of-accounts">
      {error ? <div className="alert danger">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      <form onSubmit={add} className="create-form">
        <h3>Add ledger</h3>
        <div className="form-grid">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="HDFC Current A/C 1234"
              required
            />
          </label>
          <label>
            <span>Group</span>
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              {ledgerGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Code (optional)</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="1020" />
          </label>
          <label>
            <span>Opening balance</span>
            <input
              inputMode="decimal"
              value={opening}
              onChange={(event) => setOpening(event.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            <span>Balance side</span>
            <select value={side} onChange={(event) => setSide(event.target.value as Side)}>
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add ledger'}
        </button>
      </form>

      <form onSubmit={saveOpening} className="create-form">
        <h3>Edit opening balance</h3>
        <div className="form-grid">
          <label>
            <span>Ledger</span>
            <select
              value={editLedgerId}
              onChange={(event) => setEditLedgerId(event.target.value)}
            >
              <option value="">Select ledger…</option>
              {ledgers
                .filter((ledger) => !ledger.isSystem)
                .map((ledger) => (
                  <option key={ledger.id} value={ledger.id}>
                    {ledger.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Opening balance</span>
            <input
              inputMode="decimal"
              value={editOpening}
              onChange={(event) => setEditOpening(event.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            <span>Balance side</span>
            <select
              value={editSide}
              onChange={(event) => setEditSide(event.target.value as Side)}
            >
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy || !editLedgerId}>
          {busy ? 'Saving…' : 'Save opening balance'}
        </button>
      </form>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Ledger</th>
              <th>Group</th>
              <th className="num">Opening</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ledgers.map((ledger) => (
              <tr key={ledger.id}>
                <td>
                  <strong>{ledger.name}</strong>
                  <div className="muted small">
                    {[ledger.code, ledger.isBank ? 'bank' : '', ledger.isParty ? 'party' : '', ledger.isSystem ? 'system' : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </td>
                <td className="muted small">{ledger.tallyParent}</td>
                <td className="num">{formatMinor(ledger.openingBalanceMinor)}</td>
                <td className="num">
                  {ledger.isSystem ? null : (
                    <button
                      type="button"
                      className="ghost small-button"
                      onClick={() => void remove(ledger)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
