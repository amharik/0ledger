import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Mail, Plus, Search, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import {
  cancelVoucher,
  deleteVoucher,
  getPostedVoucher,
  updateVoucher,
  type PostedVoucher,
} from '@/core/ledger';
import { formatMinor, minorToDecimalString, parseAmountToMinor } from '@/core/money/money';
import { compact } from '@/core/util/objects';
import type { Ledger, NewVoucher, Voucher, VoucherType } from '@/core/model';
import { findEmailArchiveForVoucher } from '@/core/desktop/email-archive';
import { SourceEmailPreview } from './SourceEmailPreview';

type Side = 'debit' | 'credit';

interface DraftLine {
  key: string;
  ledgerId: string;
  side: Side;
  amount: string;
}

const EDITABLE_TYPES = new Set<VoucherType>(['Payment', 'Receipt', 'Contra', 'Journal']);
const TYPE_FILTERS: Array<VoucherType | 'All'> = [
  'All',
  'Payment',
  'Receipt',
  'Sales',
  'Purchase',
  'Journal',
  'Contra',
];

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const issues = (cause as Error & { issues?: Array<{ message: string }> }).issues;
    if (issues && issues.length > 0) return issues.map((issue) => issue.message).join(' · ');
    return cause.message;
  }
  return String(cause);
}

interface VoucherSummaryRow {
  voucher: Voucher;
  totalMinor: number;
  primaryLedger: string;
}

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  refreshToken: number;
  onChanged: (message: string) => void;
  onOpenNewEntry: () => void;
}

export function LedgerRegister({
  workspaceId,
  ledgers,
  refreshToken,
  onChanged,
  onOpenNewEntry,
}: Props) {
  const [rows, setRows] = useState<VoucherSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<VoucherType | 'All'>('All');
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<PostedVoucher>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'delete' | null>(null);
  const [sourceEmailId, setSourceEmailId] = useState<string>();
  const [previewEmailId, setPreviewEmailId] = useState<string>();

  // Edit draft state
  const [editDate, setEditDate] = useState('');
  const [editRef, setEditRef] = useState('');
  const [editNarration, setEditNarration] = useState('');
  const [editLines, setEditLines] = useState<DraftLine[]>([]);

  const ledgerById = useMemo(() => new Map(ledgers.map((l) => [l.id, l])), [ledgers]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const db = getDb();
    void Promise.all([
      db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
      db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
    ])
      .then(([vouchers, allLines]) => {
        if (cancelled) return;
        const linesByVoucher = new Map<string, typeof allLines>();
        for (const line of allLines) {
          const list = linesByVoucher.get(line.voucherId) ?? [];
          list.push(line);
          linesByVoucher.set(line.voucherId, list);
        }
        const computed: VoucherSummaryRow[] = vouchers
          .sort(
            (a, b) =>
              b.date.localeCompare(a.date) ||
              (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
          )
          .map((voucher) => {
            const vLines = linesByVoucher.get(voucher.id) ?? [];
            const totalMinor = vLines
              .filter((l) => l.amountMinor > 0)
              .reduce((sum, l) => sum + l.amountMinor, 0);
            const nonBankLine =
              vLines.find((l) => !ledgerById.get(l.ledgerId)?.isBank) ?? vLines[0];
            const primaryLedger = nonBankLine
              ? (ledgerById.get(nonBankLine.ledgerId)?.name ?? 'Ledger')
              : voucher.voucherType;
            return { voucher, totalMinor, primaryLedger };
          });
        setRows(computed);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken, ledgerById]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(undefined);
      setConfirmAction(null);
      return;
    }
    let cancelled = false;
    void getPostedVoucher(getDb(), selectedId)
      .then((posted) => {
        if (cancelled) return;
        setSelected(posted);
        setConfirmAction(null);
        if (posted) {
          setEditDate(posted.voucher.date);
          setEditRef(posted.voucher.reference ?? '');
          setEditNarration(posted.voucher.narration ?? '');
          setEditLines(
            posted.lines.map((line) => ({
              key: line.id,
              ledgerId: line.ledgerId,
              side: line.amountMinor >= 0 ? 'debit' : 'credit',
              amount: minorToDecimalString(Math.abs(line.amountMinor)),
            })),
          );
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshToken]);

  useEffect(() => {
    if (!selected) {
      setSourceEmailId(undefined);
      return;
    }
    let cancelled = false;
    void findEmailArchiveForVoucher(getDb(), workspaceId, selected.voucher)
      .then((archive) => {
        if (!cancelled) setSourceEmailId(archive?.id);
      })
      .catch(() => {
        if (!cancelled) setSourceEmailId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, workspaceId]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(({ voucher, primaryLedger }) => {
      if (typeFilter !== 'All' && voucher.voucherType !== typeFilter) return false;
      if (!q) return true;
      return (
        voucher.number.toLowerCase().includes(q) ||
        (voucher.narration ?? '').toLowerCase().includes(q) ||
        (voucher.invoiceNumber ?? '').toLowerCase().includes(q) ||
        primaryLedger.toLowerCase().includes(q)
      );
    });
  }, [rows, search, typeFilter]);

  const editable = selected
    ? selected.voucher.status === 'regular' &&
      EDITABLE_TYPES.has(selected.voucher.voucherType) &&
      selected.items.length === 0 &&
      selected.billAllocations.length === 0 &&
      selected.costCenterAllocations.length === 0 &&
      selected.taxAllocations.length === 0
    : false;

  const editTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let invalid = false;
    for (const line of editLines) {
      const raw = line.amount.trim();
      if (!raw) continue;
      try {
        const val = parseAmountToMinor(raw);
        if (val <= 0) {
          invalid = true;
          continue;
        }
        if (line.side === 'debit') debit += val;
        else credit += val;
      } catch {
        invalid = true;
      }
    }
    return { debit, credit, invalid, balanced: debit === credit && debit > 0 };
  }, [editLines]);

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!selected || !editable) return;
    setError(undefined);
    if (editTotals.invalid || !editTotals.balanced) {
      setError('Debit and credit totals must balance.');
      return;
    }
    const { voucher } = selected;
    const payload = compact({
      workspaceId: voucher.workspaceId,
      voucherType: voucher.voucherType,
      number: voucher.number,
      date: editDate,
      narration: editNarration.trim() || undefined,
      reference: editRef.trim() || undefined,
      invoiceNumber: voucher.invoiceNumber,
      invoiceDate: voucher.invoiceDate,
      dueDate: voucher.dueDate,
      creditDays: voucher.creditDays,
      partyLedgerId: voucher.partyLedgerId,
      placeOfSupply: voucher.placeOfSupply,
      gstRegistration: voucher.gstRegistration,
      reverseCharge: voucher.reverseCharge,
      status: 'regular' as const,
      currency: voucher.currency,
      roundOffLedgerId: voucher.roundOffLedgerId,
      source: voucher.source,
      sourceRef: voucher.sourceRef,
      sourceEmailId: voucher.sourceEmailId,
      sourceTimestamp: voucher.sourceTimestamp,
      groupIds: voucher.groupIds,
      accountingId: voucher.accountingId,
      tags: voucher.tags,
      tally: voucher.tally,
      items: [],
      lines: editLines.map((line) => {
        const minor = parseAmountToMinor(line.amount);
        return {
          ledgerId: line.ledgerId,
          amountMinor: line.side === 'debit' ? minor : -minor,
          currency: voucher.currency,
          billAllocations: [],
          costCenterAllocations: [],
          taxAllocations: [],
        };
      }),
    }) as NewVoucher;

    setBusy(true);
    try {
      const updated = await updateVoucher(getDb(), voucher.id, payload);
      onChanged(`Updated ${updated.voucher.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelVoucher() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const cancelled = await cancelVoucher(getDb(), selected.voucher.id);
      setConfirmAction(null);
      onChanged(`Cancelled ${cancelled.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteVoucher() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const num = selected.voucher.number;
      await deleteVoucher(getDb(), selected.voucher.id);
      setSelectedId(undefined);
      setSelected(undefined);
      setConfirmAction(null);
      onChanged(`Deleted ${num}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/80">
          {TYPE_FILTERS.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setTypeFilter(type)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                typeFilter === type
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number, party, narration…"
            className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
      </div>

      {/* Main layout: Table + optional Inspector side panel */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div
          className={`rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 ${
            selected ? 'lg:col-span-7' : 'lg:col-span-12'
          }`}
        >
          {loading ? (
            <div className="space-y-2 p-6">
              <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              <div className="h-10 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {rows.length === 0 ? 'No vouchers recorded yet' : 'No matching vouchers'}
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {rows.length === 0
                  ? 'Record a payment, receipt, or invoice, or approve items from your Money Inbox.'
                  : 'Try adjusting your type filter or search term.'}
              </p>
              {rows.length === 0 ? (
                <button
                  type="button"
                  onClick={onOpenNewEntry}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  <Plus className="h-4 w-4" />
                  Record entry
                </button>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Number</th>
                    <th className="px-4 py-3">Account &amp; narration</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredRows.map(({ voucher, totalMinor, primaryLedger }) => {
                    const isSelected = voucher.id === selectedId;
                    const isCancelled = voucher.status === 'cancelled';
                    return (
                      <tr
                        key={voucher.id}
                        onClick={() => setSelectedId(voucher.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50/70 dark:bg-blue-950/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        } ${isCancelled ? 'opacity-55' : ''}`}
                      >
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
                          {voucher.date}
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {voucher.number}
                        </td>
                        <td className="max-w-xs px-4 py-3">
                          <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                            {primaryLedger}
                          </div>
                          {voucher.narration || voucher.invoiceNumber ? (
                            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                              {voucher.invoiceNumber ? `${voucher.invoiceNumber} · ` : ''}
                              {voucher.narration ?? ''}
                            </div>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
                          {voucher.voucherType}
                          {isCancelled ? (
                            <span className="ml-1.5 text-red-600 dark:text-red-400">· cancelled</span>
                          ) : null}
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                          {formatMinor(totalMinor)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Selected Voucher Inspector / Editor */}
        {selected ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
              <div>
                <div className="flex items-baseline gap-2">
                  <h3 className="num-tabular text-base font-semibold text-slate-900 dark:text-slate-100">
                    {selected.voucher.number}
                  </h3>
                  <span
                    className={`text-xs font-medium ${
                      selected.voucher.status === 'regular'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {selected.voucher.status}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {selected.voucher.voucherType} · {selected.voucher.date}
                  {selected.voucher.sourceTimestamp
                    ? ` ${new Date(selected.voucher.sourceTimestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : ''}
                  {selected.voucher.source !== 'manual' ? ` · ${selected.voucher.source}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {sourceEmailId ? (
                  <button
                    type="button"
                    onClick={() => setPreviewEmailId(sourceEmailId)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Source email
                  </button>
                ) : null}
              <button
                type="button"
                aria-label="Close voucher inspector"
                onClick={() => setSelectedId(undefined)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
              </div>
            </div>

            {editable ? (
              <form onSubmit={saveEdit} className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Date
                    </label>
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                      Reference
                    </label>
                    <input
                      value={editRef}
                      onChange={(e) => setEditRef(e.target.value)}
                      className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Narration
                  </label>
                  <input
                    value={editNarration}
                    onChange={(e) => setEditNarration(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                      Lines
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditLines((cur) => [
                          ...cur,
                          { key: crypto.randomUUID(), ledgerId: '', side: 'debit', amount: '' },
                        ])
                      }
                      className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                    >
                      + Add line
                    </button>
                  </div>
                  {editLines.map((line) => (
                    <div key={line.key} className="grid grid-cols-12 items-center gap-1.5">
                      <select
                        value={line.ledgerId}
                        onChange={(e) =>
                          setEditLines((cur) =>
                            cur.map((l) => (l.key === line.key ? { ...l, ledgerId: e.target.value } : l)),
                          )
                        }
                        className="col-span-6 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value="">Ledger…</option>
                        {ledgers.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={line.side}
                        onChange={(e) =>
                          setEditLines((cur) =>
                            cur.map((l) =>
                              l.key === line.key ? { ...l, side: e.target.value as Side } : l,
                            ),
                          )
                        }
                        className="col-span-2 rounded-md border border-slate-300 bg-white px-1.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                      >
                        <option value="debit">Dr</option>
                        <option value="credit">Cr</option>
                      </select>
                      <input
                        inputMode="decimal"
                        value={line.amount}
                        onChange={(e) =>
                          setEditLines((cur) =>
                            cur.map((l) => (l.key === line.key ? { ...l, amount: e.target.value } : l)),
                          )
                        }
                        className="num-tabular col-span-3 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-xs dark:border-slate-700 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        disabled={editLines.length <= 2}
                        aria-label="Remove line"
                        onClick={() =>
                          setEditLines((cur) =>
                            cur.length <= 2 ? cur : cur.filter((l) => l.key !== line.key),
                          )
                        }
                        className="col-span-1 flex justify-center text-slate-400 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <span
                    className={`num-tabular text-xs font-medium ${
                      editTotals.balanced
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    Dr {formatMinor(editTotals.debit)} · Cr {formatMinor(editTotals.credit)}
                  </span>
                  <button
                    type="submit"
                    disabled={busy || !editTotals.balanced}
                    className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
                  >
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-4 space-y-3">
                {selected.voucher.narration ? (
                  <p className="text-sm text-slate-700 dark:text-slate-300">
                    {selected.voucher.narration}
                  </p>
                ) : null}
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2 text-left">Ledger</th>
                      <th className="py-2 text-right">Dr</th>
                      <th className="py-2 text-right">Cr</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {selected.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-2 font-medium text-slate-800 dark:text-slate-200">
                          {ledgerById.get(line.ledgerId)?.name ?? line.ledgerId}
                        </td>
                        <td className="num-tabular py-2 text-right">
                          {line.amountMinor > 0 ? formatMinor(line.amountMinor) : '—'}
                        </td>
                        <td className="num-tabular py-2 text-right">
                          {line.amountMinor < 0 ? formatMinor(-line.amountMinor) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Cancel / Delete with inline confirmation */}
            <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
              {confirmAction ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs dark:border-red-900/50 dark:bg-red-950/40">
                  <span className="text-red-800 dark:text-red-300">
                    {confirmAction === 'cancel'
                      ? 'Exclude this voucher from reports?'
                      : 'Permanently delete this cancelled voucher?'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmAction(null)}
                      className="text-slate-600 hover:underline dark:text-slate-400"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void (confirmAction === 'cancel'
                          ? handleCancelVoucher()
                          : handleDeleteVoucher())
                      }
                      className="rounded bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  {selected.voucher.status === 'regular' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmAction('cancel')}
                      className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                    >
                      Cancel voucher
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmAction('delete')}
                      className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                    >
                      Delete permanently
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {previewEmailId ? (
        <SourceEmailPreview
          workspaceId={workspaceId}
          emailArchiveId={previewEmailId}
          onClose={() => setPreviewEmailId(undefined)}
        />
      ) : null}
    </div>
  );
}
