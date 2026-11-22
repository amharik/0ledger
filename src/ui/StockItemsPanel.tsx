import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, Package, Plus, RotateCcw, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createStockItem, listStockItems, updateStockItem } from '@/core/db/master-service';
import { formatMinor, parseAmountToMinor } from '@/core/money/money';
import type { StockItem } from '@/core/model';

export type ValuationMethod = 'fifo' | 'weighted-average' | 'standard-cost';

const METHODS: Array<{ value: ValuationMethod; label: string }> = [
  { value: 'weighted-average', label: 'Weighted average' },
  { value: 'fifo', label: 'FIFO' },
  { value: 'standard-cost', label: 'Standard cost' },
];

interface Props {
  workspaceId: string;
  onChanged?: ((message: string) => void) | undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function optionalAmount(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? parseAmountToMinor(trimmed) : undefined;
}

export default function StockItemsPanel({ workspaceId, onChanged }: Props) {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showAdd, setShowAdd] = useState(false);

  const [name, setName] = useState('');
  const [uom, setUom] = useState('NOS');
  const [hsnSac, setHsnSac] = useState('');
  const [rate, setRate] = useState('');
  const [openingQuantity, setOpeningQuantity] = useState('');
  const [openingValue, setOpeningValue] = useState('');
  const [method, setMethod] = useState<ValuationMethod>('weighted-average');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listStockItems(getDb(), workspaceId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    if (!name.trim()) {
      setError('Stock item name is required.');
      return;
    }
    setBusy(true);
    try {
      const rateMinor = optionalAmount(rate);
      const openingValueMinor = optionalAmount(openingValue);
      const created = await createStockItem(getDb(), {
        workspaceId,
        name: name.trim(),
        uom: uom.trim() || 'NOS',
        ...(hsnSac.trim() ? { hsnSac: hsnSac.trim() } : {}),
        ...(rateMinor !== undefined ? { rateMinor } : {}),
        ...(openingQuantity.trim() ? { openingQuantity: openingQuantity.trim() } : {}),
        ...(openingValueMinor !== undefined ? { openingValueMinor } : {}),
        valuationMethod: method,
      });
      const message = `Created stock item “${created.name}”.`;
      setNotice(message);
      onChanged?.(message);
      setName('');
      setHsnSac('');
      setRate('');
      setOpeningQuantity('');
      setOpeningValue('');
      setShowAdd(false);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function archive(item: StockItem) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      await updateStockItem(getDb(), item.id, { archived: !item.archived });
      const message = `${item.archived ? 'Restored' : 'Archived'} “${item.name}”.`;
      setNotice(message);
      onChanged?.(message);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeMethod(item: StockItem, value: ValuationMethod) {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      await updateStockItem(getDb(), item.id, { valuationMethod: value });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
            Stock items
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Inventory catalog used on sales and purchase invoices. Outward stock uses each item’s
            valuation method.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((open) => !open)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          {showAdd ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          <span>{showAdd ? 'Close form' : 'Add stock item'}</span>
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

      {/* Add item form */}
      {showAdd ? (
        <form
          onSubmit={create}
          className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-[#111827]"
        >
          <h3 className="mb-4 font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
            New stock item
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block lg:col-span-2">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Item name
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Cloud Workstation License"
                required
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Unit (UOM)
              </span>
              <input
                value={uom}
                onChange={(event) => setUom(event.target.value)}
                placeholder="NOS"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                HSN / SAC
              </span>
              <input
                value={hsnSac}
                onChange={(event) => setHsnSac(event.target.value)}
                placeholder="998314"
                className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Default rate
              </span>
              <input
                inputMode="decimal"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                placeholder="0.00"
                className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Opening qty
              </span>
              <input
                inputMode="decimal"
                value={openingQuantity}
                onChange={(event) => setOpeningQuantity(event.target.value)}
                placeholder="0"
                className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Opening value
              </span>
              <input
                inputMode="decimal"
                value={openingValue}
                onChange={(event) => setOpeningValue(event.target.value)}
                placeholder="Auto (qty × rate)"
                className="num-tabular w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Valuation method
              </span>
              <select
                value={method}
                onChange={(event) => setMethod(event.target.value as ValuationMethod)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
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
              {busy ? 'Saving...' : 'Create stock item'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Table or Empty */}
      {loading ? (
        <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Loading stock items...
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center dark:border-slate-800 dark:bg-[#111827]">
          <Package className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No stock items yet
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Add products or billable services to track inventory quantity and valuation on invoices.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#111827]">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Opening stock</th>
                  <th className="px-4 py-3">Valuation</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {items.map((item) => {
                  const meta = [
                    item.uom,
                    item.hsnSac ? `HSN ${item.hsnSac}` : '',
                    item.rateMinor !== undefined ? `Rate ${formatMinor(item.rateMinor)}` : '',
                    item.archived ? 'Archived' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  return (
                    <tr
                      key={item.id}
                      className={
                        item.archived
                          ? 'opacity-60 transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40'
                          : 'transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {item.name}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {meta}
                        </div>
                      </td>
                      <td className="num-tabular px-4 py-3 text-xs text-slate-700 dark:text-slate-300">
                        {item.openingQuantity ? `${item.openingQuantity} ${item.uom}` : '—'}
                        {item.openingValueMinor !== undefined ? (
                          <span className="ml-2 text-slate-500 dark:text-slate-400">
                            ({formatMinor(item.openingValueMinor)})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          aria-label={`Valuation method for ${item.name}`}
                          value={item.valuationMethod ?? 'weighted-average'}
                          onChange={(event) =>
                            void changeMethod(item, event.target.value as ValuationMethod)
                          }
                          disabled={busy}
                          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        >
                          {METHODS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void archive(item)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
                        >
                          {item.archived ? (
                            <>
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Restore</span>
                            </>
                          ) : (
                            <>
                              <Archive className="h-3.5 w-3.5" />
                              <span>Archive</span>
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
