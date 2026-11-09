import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import type { PartyView } from '@/core/db/master-service';
import { postVoucher } from '@/core/ledger';
import { formatMinor, parseAmountToMinor } from '@/core/money/money';
import { compact } from '@/core/util/objects';
import type { Ledger, StockItem, TaxAllocationInput, TaxType, VoucherLineInput } from '@/core/model';

type InvoiceType = 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note';

interface DraftItem {
  key: string;
  stockItemId: string;
  description: string;
  hsnSac: string;
  quantity: string;
  uom: string;
  rate: string;
}

const INVOICE_TYPES: InvoiceType[] = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'];
const DEBIT_PARTY_TYPES = new Set<InvoiceType>(['Sales', 'Debit Note']);
const TAX_TYPES: TaxType[] = ['CGST', 'SGST', 'IGST', 'CESS', 'VAT', 'Other'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function newItem(): DraftItem {
  return {
    key: crypto.randomUUID(),
    stockItemId: '',
    description: '',
    hsnSac: '',
    quantity: '1',
    uom: 'NOS',
    rate: '',
  };
}

function amountFor(item: DraftItem): number {
  try {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    return Math.round(quantity * parseAmountToMinor(item.rate || '0'));
  } catch {
    return 0;
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const issues = (cause as Error & { issues?: Array<{ message: string }> }).issues;
    if (issues && issues.length > 0) return issues.map((issue) => issue.message).join(' · ');
    return cause.message;
  }
  return String(cause);
}

interface Props {
  workspaceId: string;
  ledgers: Ledger[];
  parties: PartyView[];
  stockItems: StockItem[];
  onPosted: (message: string) => void;
}

export function InvoiceEntry({ workspaceId, ledgers, parties, stockItems, onPosted }: Props) {
  const [voucherType, setVoucherType] = useState<InvoiceType>('Sales');
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [partyLedgerId, setPartyLedgerId] = useState('');
  const [accountLedgerId, setAccountLedgerId] = useState('');
  const [narration, setNarration] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [gstRegistration, setGstRegistration] = useState('');
  const [reverseCharge, setReverseCharge] = useState(false);
  const [taxType, setTaxType] = useState<TaxType>('CGST');
  const [taxRate, setTaxRate] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [tdsSection, setTdsSection] = useState('');
  const [tdsRate, setTdsRate] = useState('');
  const [tdsAmount, setTdsAmount] = useState('');
  const [items, setItems] = useState<DraftItem[]>([newItem()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const defaultAccount = useMemo(() => {
    const name = voucherType === 'Sales' || voucherType === 'Credit Note' ? 'Sales' : 'Purchases';
    return ledgers.find((ledger) => ledger.name === name);
  }, [ledgers, voucherType]);

  useEffect(() => {
    if (!accountLedgerId && defaultAccount) setAccountLedgerId(defaultAccount.id);
  }, [accountLedgerId, defaultAccount]);

  useEffect(() => {
    if (!partyLedgerId && parties[0]) setPartyLedgerId(parties[0].party.ledgerId);
  }, [partyLedgerId, parties]);

  const totalMinor = items.reduce((sum, item) => sum + amountFor(item), 0);

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function chooseStockItem(key: string, stockItemId: string) {
    const stock = stockItems.find((item) => item.id === stockItemId);
    updateItem(key, {
      stockItemId,
      ...(stock
        ? {
            description: stock.name,
            hsnSac: stock.hsnSac ?? '',
            uom: stock.uom,
            rate: stock.rateMinor > 0 ? String(stock.rateMinor / 100) : '',
          }
        : {}),
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!partyLedgerId) {
      setError('Choose a party ledger.');
      return;
    }
    if (!accountLedgerId) {
      setError('Choose a sales or purchase ledger.');
      return;
    }
    if (!invoiceNumber.trim()) {
      setError('Invoice / note number is required.');
      return;
    }
    if (items.length === 0 || items.some((item) => !item.description.trim())) {
      setError('Add at least one item and describe every line.');
      return;
    }
    if (totalMinor <= 0) {
      setError('Invoice total must be greater than zero.');
      return;
    }

    let taxAllocations: TaxAllocationInput[] = [];
    try {
      if (taxAmount.trim()) {
        taxAllocations.push(
          compact({
            taxType,
            amountMinor: Math.abs(parseAmountToMinor(taxAmount)),
            taxableValueMinor: totalMinor,
            rate: taxRate.trim() || undefined,
          }),
        );
      }
      if (tdsAmount.trim()) {
        taxAllocations.push(
          compact({
            taxType: 'TDS' as const,
            amountMinor: Math.abs(parseAmountToMinor(tdsAmount)),
            taxableValueMinor: totalMinor,
            rate: tdsRate.trim() || undefined,
            tdsSection: tdsSection.trim() || undefined,
            tdsRate: tdsRate.trim() || undefined,
            tdsAmountMinor: Math.abs(parseAmountToMinor(tdsAmount)),
          }),
        );
      }
    } catch {
      setError('Tax and TDS amounts must be valid numbers.');
      return;
    }

    const debitParty = DEBIT_PARTY_TYPES.has(voucherType);
    const billType = voucherType === 'Sales' || voucherType === 'Purchase' ? 'New Ref' as const : 'Against Ref' as const;
    const partyLine = compact({
      ledgerId: partyLedgerId,
      amountMinor: debitParty ? totalMinor : -totalMinor,
      currency: 'INR',
      billAllocations: [
        compact({
          billRef: invoiceNumber.trim(),
          billType,
          amountMinor: totalMinor,
          dueDate: dueDate || undefined,
        }),
      ],
      costCenterAllocations: [],
      taxAllocations: [],
    }) as VoucherLineInput;
    const accountLine: VoucherLineInput = {
      ledgerId: accountLedgerId,
      amountMinor: debitParty ? -totalMinor : totalMinor,
      currency: 'INR',
      billAllocations: [],
      costCenterAllocations: [],
      taxAllocations,
    };

    setSaving(true);
    try {
      const posted = await postVoucher(getDb(), {
        workspaceId,
        voucherType,
        date,
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate: date,
        ...(dueDate ? { dueDate } : {}),
        partyLedgerId,
        narration: narration.trim() || undefined,
        ...(placeOfSupply.trim() ? { placeOfSupply: placeOfSupply.trim() } : {}),
        ...(gstRegistration.trim() ? { gstRegistration: gstRegistration.trim() } : {}),
        reverseCharge,
        status: 'regular',
        currency: 'INR',
        source: 'manual',
        groupIds: [],
        tags: [],
        lines: [partyLine, accountLine],
        items: items.map((item) => ({
          ...(item.stockItemId ? { stockItemId: item.stockItemId } : {}),
          description: item.description.trim(),
          ...(item.hsnSac.trim() ? { hsnSac: item.hsnSac.trim() } : {}),
          quantity: item.quantity,
          uom: item.uom.trim() || 'NOS',
          rateMinor: parseAmountToMinor(item.rate || '0'),
          amountMinor: amountFor(item),
          discountMinor: 0,
          direction:
            voucherType === 'Sales' || voucherType === 'Debit Note' ? 'out' : 'in',
        })),
      });
      onPosted(`Posted ${posted.voucher.number} · ${formatMinor(totalMinor)}`);
      setInvoiceNumber('');
      setNarration('');
      setItems([newItem()]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const accountLedgers = ledgers.filter(
    (ledger) =>
      !ledger.archived &&
      (ledger.tallyParent === 'Sales Accounts' || ledger.tallyParent === 'Purchase Accounts'),
  );
  const partyLedgers = ledgers.filter(
    (ledger) => !ledger.archived && (ledger.isParty || parties.some((view) => view.party.ledgerId === ledger.id)),
  );

  return (
    <section className="card">
      <div className="section-head">
        <h2>Invoice / note</h2>
        <span className="muted small">party · items · bill-wise</span>
      </div>
      {error ? <div className="alert danger">{error}</div> : null}
      <form className="voucher-form" onSubmit={submit}>
        <div className="form-row">
          <label>
            <span>Type</span>
            <select
              value={voucherType}
              onChange={(event) => setVoucherType(event.target.value as InvoiceType)}
            >
              {INVOICE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{voucherType === 'Purchase' ? 'Bill no.' : 'Invoice no.'}</span>
            <input
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
              placeholder="INV-001"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            <span>Party</span>
            <select value={partyLedgerId} onChange={(event) => setPartyLedgerId(event.target.value)}>
              <option value="">Select party…</option>
              {partyLedgers.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Account</span>
            <select
              value={accountLedgerId}
              onChange={(event) => setAccountLedgerId(event.target.value)}
            >
              <option value="">Select account…</option>
              {accountLedgers.map((ledger) => (
                <option key={ledger.id} value={ledger.id}>
                  {ledger.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            <span>Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </label>
        </div>

        <div className="lines">
          {items.map((item) => (
            <div className="item-row" key={item.key}>
              <select
                aria-label="Stock item"
                value={item.stockItemId}
                onChange={(event) => chooseStockItem(item.key, event.target.value)}
              >
                <option value="">Free text…</option>
                {stockItems
                  .filter((stock) => !stock.archived)
                  .map((stock) => (
                    <option key={stock.id} value={stock.id}>
                      {stock.name}
                    </option>
                  ))}
              </select>
              <input
                aria-label="Description"
                value={item.description}
                onChange={(event) => updateItem(item.key, { description: event.target.value })}
                placeholder="Description"
              />
              <input
                aria-label="Quantity"
                inputMode="decimal"
                value={item.quantity}
                onChange={(event) => updateItem(item.key, { quantity: event.target.value })}
                placeholder="Qty"
              />
              <input
                aria-label="Unit"
                value={item.uom}
                onChange={(event) => updateItem(item.key, { uom: event.target.value })}
                placeholder="UOM"
              />
              <input
                aria-label="Rate"
                inputMode="decimal"
                value={item.rate}
                onChange={(event) => updateItem(item.key, { rate: event.target.value })}
                placeholder="Rate"
              />
              <span className="num">{formatMinor(amountFor(item))}</span>
              <button
                type="button"
                className="icon ghost"
                onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                disabled={items.length <= 1}
                aria-label="Remove item"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="form-actions">
          <button type="button" className="ghost" onClick={() => setItems((current) => [...current, newItem()])}>
            Add item
          </button>
          <span className="balance">Total {formatMinor(totalMinor)}</span>
          <button type="submit" disabled={saving || totalMinor <= 0}>
            {saving ? 'Posting…' : `Post ${voucherType.toLowerCase()}`}
          </button>
        </div>

        <details>
          <summary className="muted small">Narration, GST/TDS capture fields</summary>
          <div className="form-row">
            <label>
              <span>Narration</span>
              <input value={narration} onChange={(event) => setNarration(event.target.value)} />
            </label>
            <label>
              <span>Place of supply</span>
              <input
                value={placeOfSupply}
                onChange={(event) => setPlaceOfSupply(event.target.value)}
                placeholder="Karnataka"
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              <span>GST registration</span>
              <input
                value={gstRegistration}
                onChange={(event) => setGstRegistration(event.target.value)}
                placeholder="29ABCDE1234F1Z5"
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={reverseCharge}
                onChange={(event) => setReverseCharge(event.target.checked)}
              />
              <span>Reverse charge</span>
            </label>
          </div>
        </details>
      </form>
    </section>
  );
}
