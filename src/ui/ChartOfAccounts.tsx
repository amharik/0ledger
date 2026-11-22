import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Building2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  createLedger,
  removeLedger,
  updateLedger,
  type CreateLedgerInput,
} from '@/core/db/ledger-service';
import {
  listParties,
  updateParty,
  type UpdatePartyInput,
} from '@/core/db/master-service';
import {
  getWorkspaceBundle,
  type WorkspaceBundle,
} from '@/core/db/workspace-service';
import {
  formatMinor,
  minorToDecimalString,
  parseAmountToMinor,
} from '@/core/money/money';
import type { Ledger, Party } from '@/core/model';

type Side = 'debit' | 'credit';

interface Props {
  workspaceId: string;
  onChanged?: ((message: string) => void) | undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function signedMinor(amount: string, side: Side): number {
  const text = amount.trim();
  if (!text) return 0;
  const value = parseAmountToMinor(text);
  return side === 'debit' ? value : -value;
}

export default function ChartOfAccounts({ workspaceId, onChanged }: Props) {
  const [bundle, setBundle] = useState<WorkspaceBundle>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [code, setCode] = useState('');
  const [opening, setOpening] = useState('');
  const [side, setSide] = useState<Side>('debit');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOpening, setEditOpening] = useState('');
  const [editSide, setEditSide] = useState<Side>('debit');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const [partyByLedgerId, setPartyByLedgerId] = useState<Record<string, Party>>({});
  const [editingPartyLedgerId, setEditingPartyLedgerId] = useState<string | null>(null);
  const [partyLegalName, setPartyLegalName] = useState('');
  const [partyGstin, setPartyGstin] = useState('');
  const [partyGstRegType, setPartyGstRegType] = useState('');
  const [partyState, setPartyState] = useState('');
  const [partyPincode, setPartyPincode] = useState('');
  const [partyEmail, setPartyEmail] = useState('');
  const [partyPhone, setPartyPhone] = useState('');
  const [partyBillingAddress, setPartyBillingAddress] = useState('');
  const [partyCreditDays, setPartyCreditDays] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const db = getDb();
      const [next, partyViews] = await Promise.all([
        getWorkspaceBundle(db, workspaceId),
        listParties(db, workspaceId),
      ]);
      if (!next) throw new Error('Workspace not found');
      setBundle(next);
      const map: Record<string, Party> = {};
      for (const view of partyViews) {
        map[view.ledger.id] = view.party;
      }
      setPartyByLedgerId(map);
      setGroupId(
        (current) =>
          current ||
          next.groups.find((group) => group.name === 'Indirect Expenses')?.id ||
          next.groups[0]?.id ||
          '',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ledgerGroups = useMemo(
    () => (bundle ? [...bundle.groups].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [bundle],
  );

  const activeLedgers = useMemo(() => {
    if (!bundle) return [];
    const q = query.trim().toLowerCase();
    return bundle.ledgers
      .filter((ledger) => !ledger.archived)
      .filter((ledger) => (!groupFilter ? true : ledger.tallyParent === groupFilter))
      .filter((ledger) => {
        if (!q) return true;
        return (
          ledger.name.toLowerCase().includes(q) ||
          ledger.tallyParent.toLowerCase().includes(q) ||
          (ledger.code ?? '').toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          a.tallyParent.localeCompare(b.tallyParent) || a.name.localeCompare(b.name),
      );
  }, [bundle, query, groupFilter]);

  const parentGroups = useMemo(() => {
    if (!bundle) return [];
    return [...new Set(bundle.ledgers.filter((l) => !l.archived).map((l) => l.tallyParent))].sort(
      (a, b) => a.localeCompare(b),
    );
  }, [bundle]);

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
      const message = `Created ${created.ledger.name} under ${created.ledger.tallyParent}.`;
      setNotice(message);
      onChanged?.(message);
      setName('');
      setCode('');
      setOpening('');
      setShowAdd(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function startEditOpening(ledger: Ledger) {
    setConfirmRemoveId(null);
    setEditingPartyLedgerId(null);
    setEditingId(ledger.id);
    setEditOpening(minorToDecimalString(Math.abs(ledger.openingBalanceMinor)));
    setEditSide(ledger.openingBalanceMinor < 0 ? 'credit' : 'debit');
  }

  function startEditParty(ledger: Ledger, party: Party) {
    setConfirmRemoveId(null);
    setEditingId(null);
    setEditingPartyLedgerId(ledger.id);
    setPartyLegalName(party.legalName);
    setPartyGstin(party.gstin ?? '');
    setPartyGstRegType(party.gstRegistrationType ?? '');
    setPartyState(party.state ?? '');
    setPartyPincode(party.pincode ?? '');
    setPartyEmail(party.email ?? '');
    setPartyPhone(party.phone ?? '');
    setPartyBillingAddress(party.billingAddress ?? '');
    setPartyCreditDays(
      party.creditPeriodDays !== undefined ? String(party.creditPeriodDays) : '',
    );
  }

  async function savePartyDetails(party: Party, ledgerName: string) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const parsedDays = partyCreditDays.trim() ? Number(partyCreditDays.trim()) : undefined;
      if (parsedDays !== undefined && (!Number.isFinite(parsedDays) || parsedDays < 0)) {
        throw new Error('Credit period days must be a non-negative number.');
      }
      const input: UpdatePartyInput = {
        legalName: partyLegalName,
        gstin: partyGstin,
        gstRegistrationType: partyGstRegType,
        state: partyState,
        pincode: partyPincode,
        email: partyEmail,
        phone: partyPhone,
        billingAddress: partyBillingAddress,
        ...(parsedDays !== undefined ? { creditPeriodDays: Math.round(parsedDays) } : {}),
      };
      await updateParty(getDb(), party.id, input);
      const message = `Updated party details for ${ledgerName}.`;
      setNotice(message);
      onChanged?.(message);
      setEditingPartyLedgerId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveOpening(ledgerId: string) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const updated = await updateLedger(getDb(), ledgerId, {
        openingBalanceMinor: signedMinor(editOpening, editSide),
      });
      const message = `Updated opening balance for ${updated.name}.`;
      setNotice(message);
      onChanged?.(message);
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove(ledger: Ledger) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const result = await removeLedger(getDb(), ledger.id);
      const message =
        result === 'archived' ? `${ledger.name} archived.` : `${ledger.name} deleted.`;
      setNotice(message);
      onChanged?.(message);
      setConfirmRemoveId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !bundle) {
    return (
      <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading chart of accounts...
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        No chart of accounts loaded.
      </div>
    );
  }

  const totalCount = bundle.ledgers.filter((l) => !l.archived).length;

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
            Chart of accounts
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            <span className="num-tabular">{totalCount}</span> active accounts across{' '}
            <span className="num-tabular">{parentGroups.length}</span> groups.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((open) => !open)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          {showAdd ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          <span>{showAdd ? 'Close form' : 'Add account'}</span>
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      {/* Add account form */}
      {showAdd ? (
        <form
          onSubmit={add}
          className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]"
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
              New ledger account
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Mapped automatically to Tally parent groups
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block lg:col-span-2">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Account name
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="HDFC Current A/C 1234"
                required
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Group
              </span>
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {ledgerGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Code (optional)
              </span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="1020"
                className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-2 block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Opening
                </span>
                <input
                  inputMode="decimal"
                  value={opening}
                  onChange={(event) => setOpening(event.target.value)}
                  placeholder="0.00"
                  className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Side
                </span>
                <select
                  value={side}
                  onChange={(event) => setSide(event.target.value as Side)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="debit">Dr</option>
                  <option value="credit">Cr</option>
                </select>
              </label>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Save account'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Search & Group filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by account name, group, or code..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-800 dark:bg-[#111827] dark:text-slate-100"
          />
        </div>
        <select
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
          aria-label="Filter by account group"
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none dark:border-slate-800 dark:bg-[#111827] dark:text-slate-200"
        >
          <option value="">All groups</option>
          {parentGroups.map((group) => (
            <option key={group} value={group}>
              {group}
            </option>
          ))}
        </select>
      </div>

      {/* Ledger table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Group</th>
                <th className="px-4 py-3 text-right">Opening balance</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {activeLedgers.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400"
                  >
                    No accounts match your filter.
                  </td>
                </tr>
              ) : (
                activeLedgers.map((ledger) => {
                  const party = partyByLedgerId[ledger.id];
                  const meta = [
                    ledger.code,
                    ledger.isBank ? 'Bank' : '',
                    ledger.isParty ? 'Party' : '',
                    party?.gstin ? `GSTIN ${party.gstin}` : '',
                    party?.state ?? '',
                    ledger.isSystem ? 'System' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const isEditing = editingId === ledger.id;
                  const isConfirming = confirmRemoveId === ledger.id;
                  const isEditingParty = editingPartyLedgerId === ledger.id && Boolean(party);

                  return (
                    <Fragment key={ledger.id}>
                      <tr className="transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {ledger.name}
                          </div>
                          {meta ? (
                            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                              {meta}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                          {ledger.tallyParent}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isEditing ? (
                            <div className="inline-flex items-center justify-end gap-1.5">
                              <input
                                inputMode="decimal"
                                value={editOpening}
                                onChange={(event) => setEditOpening(event.target.value)}
                                className="num-tabular w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                              />
                              <select
                                value={editSide}
                                onChange={(event) => setEditSide(event.target.value as Side)}
                                className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                              >
                                <option value="debit">Dr</option>
                                <option value="credit">Cr</option>
                              </select>
                            </div>
                          ) : (
                            <span className="num-tabular font-medium text-slate-900 dark:text-slate-100">
                              {formatMinor(ledger.openingBalanceMinor)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {ledger.isSystem ? (
                            <span className="text-xs text-slate-400 dark:text-slate-500">
                              Protected
                            </span>
                          ) : isEditing ? (
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void saveOpening(ledger.id)}
                                className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : isConfirming ? (
                            <div className="inline-flex items-center justify-end gap-2">
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                Archive/delete?
                              </span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void confirmRemove(ledger)}
                                className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveId(null)}
                                className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center justify-end gap-3">
                              {party ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    isEditingParty
                                      ? setEditingPartyLedgerId(null)
                                      : startEditParty(ledger, party)
                                  }
                                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
                                >
                                  <Building2 className="h-3.5 w-3.5" />
                                  <span>{isEditingParty ? 'Close' : 'Party'}</span>
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => startEditOpening(ledger)}
                                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                <span>Opening</span>
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setEditingId(null);
                                  setEditingPartyLedgerId(null);
                                  setConfirmRemoveId(ledger.id);
                                }}
                                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-rose-600 dark:text-slate-400 dark:hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>Remove</span>
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>

                      {isEditingParty && party ? (
                        <tr className="bg-slate-50/70 dark:bg-slate-900/40">
                          <td colSpan={4} className="px-4 py-4">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                                  Party master details · {party.type === 'creditor' ? 'Vendor / Creditor' : 'Customer / Debtor'}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setEditingPartyLedgerId(null)}
                                  className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                                >
                                  Close
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Legal name
                                  </span>
                                  <input
                                    value={partyLegalName}
                                    onChange={(e) => setPartyLegalName(e.target.value)}
                                    className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    GSTIN (15 chars)
                                  </span>
                                  <input
                                    value={partyGstin}
                                    onChange={(e) => setPartyGstin(e.target.value.toUpperCase())}
                                    placeholder="27ABCDE1234F1Z5"
                                    maxLength={15}
                                    className="num-tabular w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs uppercase text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    GST registration
                                  </span>
                                  <select
                                    value={partyGstRegType}
                                    onChange={(e) => setPartyGstRegType(e.target.value)}
                                    className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  >
                                    <option value="">Not specified</option>
                                    <option value="Regular">Regular</option>
                                    <option value="Composition">Composition</option>
                                    <option value="Unregistered">Unregistered</option>
                                    <option value="Consumer">Consumer</option>
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    State
                                  </span>
                                  <input
                                    value={partyState}
                                    onChange={(e) => setPartyState(e.target.value)}
                                    placeholder="Maharashtra"
                                    className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Email
                                  </span>
                                  <input
                                    type="email"
                                    value={partyEmail}
                                    onChange={(e) => setPartyEmail(e.target.value)}
                                    placeholder="accounts@vendor.com"
                                    className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Phone
                                  </span>
                                  <input
                                    value={partyPhone}
                                    onChange={(e) => setPartyPhone(e.target.value)}
                                    placeholder="+91 98..."
                                    className="num-tabular w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Credit days
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={partyCreditDays}
                                    onChange={(e) => setPartyCreditDays(e.target.value)}
                                    placeholder="30"
                                    className="num-tabular w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Pincode
                                  </span>
                                  <input
                                    value={partyPincode}
                                    onChange={(e) => setPartyPincode(e.target.value)}
                                    placeholder="400001"
                                    maxLength={6}
                                    className="num-tabular w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                                <label className="block sm:col-span-2 lg:col-span-4">
                                  <span className="mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-400">
                                    Billing address
                                  </span>
                                  <input
                                    value={partyBillingAddress}
                                    onChange={(e) => setPartyBillingAddress(e.target.value)}
                                    placeholder="Street, locality, city"
                                    className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                  />
                                </label>
                              </div>
                              <div className="flex justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingPartyLedgerId(null)}
                                  className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void savePartyDetails(party, ledger.name)}
                                  className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {busy ? 'Saving...' : 'Save party details'}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
