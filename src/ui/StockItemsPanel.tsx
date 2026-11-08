import { useCallback, useEffect, useState, type FormEvent } from 'react';
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function optionalAmount(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? parseAmountToMinor(trimmed) : undefined;
}

export default function StockItemsPanel({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
      setNotice(`Created stock item “${created.name}”.`);
      setName('');
      setHsnSac('');
      setRate('');
      setOpeningQuantity('');
      setOpeningValue('');
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
      setNotice(`${item.archived ? 'Restored' : 'Archived'} “${item.name}”.`);
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
    <div>
      {error ? <div className="alert danger">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {loading ? <p className="muted">Loading stock items…</p> : null}

      {!loading && items.length === 0 ? (
        <p className="muted">No stock items yet. Add one below; item lines in invoices can then use it.</p>
      ) : (
        <ul className="workspace-list">
          {items.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <div className="muted small">
                  {item.uom}
                  {item.hsnSac ? ` · HSN ${item.hsnSac}` : ''}
                  {item.openingQuantity ? ` · opening ${item.openingQuantity} ${item.uom}` : ''}
                  {item.openingValueMinor !== undefined
                    ? ` · ${formatMinor(item.openingValueMinor)}`
                    : ''}
                  {item.archived ? ' · archived' : ''}
                </div>
              </div>
              <div className="inline-field">
                <select
                  aria-label={`Valuation method for ${item.name}`}
                  value={item.valuationMethod ?? 'weighted-average'}
                  onChange={(event) => void changeMethod(item, event.target.value as ValuationMethod)}
                  disabled={busy}
                >
                  {METHODS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button className="ghost small-button" disabled={busy} onClick={() => void archive(item)}>
                  {item.archived ? 'Restore' : 'Archive'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="create-form">
        <h3>New stock item</h3>
        <div className="form-grid">
          <label>
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            <span>UOM</span>
            <input value={uom} onChange={(event) => setUom(event.target.value)} />
          </label>
          <label>
            <span>HSN/SAC</span>
            <input value={hsnSac} onChange={(event) => setHsnSac(event.target.value)} />
          </label>
          <label>
            <span>Default rate</span>
            <input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} placeholder="0.00" />
          </label>
          <label>
            <span>Opening quantity</span>
            <input inputMode="decimal" value={openingQuantity} onChange={(event) => setOpeningQuantity(event.target.value)} />
          </label>
          <label>
            <span>Opening value</span>
            <input inputMode="decimal" value={openingValue} onChange={(event) => setOpeningValue(event.target.value)} placeholder="0.00" />
          </label>
          <label>
            <span>Valuation</span>
            <select value={method} onChange={(event) => setMethod(event.target.value as ValuationMethod)}>
              {METHODS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create stock item'}</button>
      </form>
      <p className="muted small">
        Opening value defaults to opening quantity × default rate. Stock reports use the selected
        valuation method for outward movements.
      </p>
    </div>
  );
}
