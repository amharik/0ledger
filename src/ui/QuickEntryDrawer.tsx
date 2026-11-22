import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import type { PartyView } from '@/core/db/master-service';
import { postVoucher } from '@/core/ledger';
import { formatMinor, parseAmountToMinor } from '@/core/money/money';
import { compact } from '@/core/util/objects';
import type {
  Ledger,
  StockItem,
  TaxAllocationInput,
  TaxType,
  VoucherLineInput,
  VoucherType,
} from '@/core/model';

type EntryMode = 'voucher' | 'invoice';
type SimpleVoucherType = Extract<VoucherType, 'Payment' | 'Receipt' | 'Contra' | 'Journal'>;
type InvoiceType = Extract<VoucherType, 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note'>;
type Side = 'debit' | 'credit';

interface DraftLine {
  key: string;
  ledgerId: string;
  side: Side;
  amount: string;
}

interface DraftItem {
  key: string;
  stockItemId: string;
  description: string;
  hsnSac: string;
  quantity: string;
  uom: string;
  rate: string;
}

const SIMPLE_TYPES: SimpleVoucherType[] = ['Payment', 'Receipt', 'Contra', 'Journal'];
const INVOICE_TYPES: InvoiceType[] = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'];
const DEBIT_PARTY_TYPES = new Set<InvoiceType>(['Sales', 'Debit Note']);
const TAX_TYPES: TaxType[] = ['CGST', 'SGST', 'IGST', 'CESS', 'VAT', 'Other'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function createLine(ledgerId = '', side: Side = 'debit'): DraftLine {
  return { key: crypto.randomUUID(), ledgerId, side, amount: '' };
}

function createItem(): DraftItem {
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

function itemAmount(item: DraftItem): number {
  try {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    return Math.round(qty * parseAmountToMinor(item.rate || '0'));
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
  open: boolean;
  workspaceId: string;
  ledgers: Ledger[];
  parties: PartyView[];
  stockItems: StockItem[];
  onClose: () => void;
  onPosted: (message: string) => void;
}

export function QuickEntryDrawer({
  open,
  workspaceId,
  ledgers,
  parties,
  stockItems,
  onClose,
  onPosted,
}: Props) {
  const [mode, setMode] = useState<EntryMode>('voucher');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // Voucher state
  const [voucherType, setVoucherType] = useState<SimpleVoucherType>('Payment');
  const [voucherDate, setVoucherDate] = useState(today());
  const [voucherRef, setVoucherRef] = useState('');
  const [voucherNarration, setVoucherNarration] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);

  // Invoice state
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('Sales');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [partyLedgerId, setPartyLedgerId] = useState('');
  const [accountLedgerId, setAccountLedgerId] = useState('');
  const [invoiceNarration, setInvoiceNarration] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [gstRegistration, setGstRegistration] = useState('');
  const [reverseCharge, setReverseCharge] = useState(false);
  const [showTaxFields, setShowTaxFields] = useState(false);
  const [taxType, setTaxType] = useState<TaxType>('IGST');
  const [taxRate, setTaxRate] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [tdsSection, setTdsSection] = useState('');
  const [tdsRate, setTdsRate] = useState('');
  const [tdsAmount, setTdsAmount] = useState('');
  const [items, setItems] = useState<DraftItem[]>([createItem()]);

  const activeLedgers = useMemo(
    () => ledgers.filter((l) => !l.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [ledgers],
  );

  const accountLedgers = useMemo(
    () =>
      activeLedgers.filter(
        (l) => l.tallyParent === 'Sales Accounts' || l.tallyParent === 'Purchase Accounts',
      ),
    [activeLedgers],
  );

  const partyLedgers = useMemo(
    () =>
      activeLedgers.filter(
        (l) => l.isParty || parties.some((view) => view.party.ledgerId === l.id),
      ),
    [activeLedgers, parties],
  );

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    const bank = activeLedgers.find((l) => l.isBank) ?? activeLedgers.find((l) => l.isCash) ?? activeLedgers[0];
    const expense =
      activeLedgers.find((l) => l.name === 'Office Expenses') ??
      activeLedgers.find((l) => l.name === 'Purchases') ??
      activeLedgers[1] ??
      activeLedgers[0];
    if (lines.length === 0 && bank && expense) {
      setLines([createLine(expense.id, 'debit'), createLine(bank.id, 'credit')]);
    }
  }, [open, activeLedgers, lines.length]);

  useEffect(() => {
    const defaultName = invoiceType === 'Sales' || invoiceType === 'Credit Note' ? 'Sales' : 'Purchases';
    const match = accountLedgers.find((l) => l.name === defaultName) ?? accountLedgers[0];
    if (match) setAccountLedgerId(match.id);
  }, [invoiceType, accountLedgers]);

  useEffect(() => {
    if (!partyLedgerId && partyLedgers[0]) {
      setPartyLedgerId(partyLedgers[0].id);
    }
  }, [partyLedgerId, partyLedgers]);

  const voucherTotals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let invalid = false;
    for (const line of lines) {
      const raw = line.amount.trim();
      if (!raw) continue;
      try {
        const value = parseAmountToMinor(raw);
        if (value <= 0) {
          invalid = true;
          continue;
        }
        if (line.side === 'debit') debit += value;
        else credit += value;
      } catch {
        invalid = true;
      }
    }
    return { debit, credit, invalid, balanced: debit === credit && debit > 0 };
  }, [lines]);

  const invoiceSubtotalMinor = items.reduce((sum, item) => sum + itemAmount(item), 0);

  if (!open) return null;

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
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

  async function submitVoucher(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (lines.length < 2) {
      setError('Add at least two ledger lines.');
      return;
    }
    if (lines.some((l) => !l.ledgerId || !l.amount.trim())) {
      setError('Choose a ledger and positive amount on every line.');
      return;
    }
    if (voucherTotals.invalid || !voucherTotals.balanced) {
      setError('Debit and credit totals must match.');
      return;
    }
    setSaving(true);
    try {
      const posted = await postVoucher(getDb(), {
        workspaceId,
        voucherType,
        date: voucherDate,
        ...(voucherRef.trim() ? { reference: voucherRef.trim() } : {}),
        ...(voucherNarration.trim() ? { narration: voucherNarration.trim() } : {}),
        status: 'regular',
        currency: 'INR',
        source: 'manual',
        groupIds: [],
        tags: [],
        items: [],
        lines: lines.map((line) => {
          const minor = parseAmountToMinor(line.amount);
          return {
            ledgerId: line.ledgerId,
            amountMinor: line.side === 'debit' ? minor : -minor,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          };
        }),
      });
      setVoucherRef('');
      setVoucherNarration('');
      setLines((current) => current.map((l) => ({ ...l, amount: '' })));
      onPosted(`Posted ${posted.voucher.number} · ${formatMinor(voucherTotals.debit)}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function submitInvoice(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!partyLedgerId) {
      setError('Select a party (add a Sundry Debtor or Creditor under Books → Accounts first if needed).');
      return;
    }
    if (!accountLedgerId) {
      setError('Select a sales or purchase account.');
      return;
    }
    if (!invoiceNumber.trim()) {
      setError('Invoice or bill number is required.');
      return;
    }
    if (items.length === 0 || items.some((i) => !i.description.trim())) {
      setError('Add at least one item with a description.');
      return;
    }
    if (invoiceSubtotalMinor <= 0) {
      setError('Invoice total must be greater than zero.');
      return;
    }

    const taxAllocations: TaxAllocationInput[] = [];
    try {
      if (taxAmount.trim()) {
        taxAllocations.push(
          compact({
            taxType,
            amountMinor: Math.abs(parseAmountToMinor(taxAmount)),
            taxableValueMinor: invoiceSubtotalMinor,
            rate: taxRate.trim() || undefined,
          }),
        );
      }
      if (tdsAmount.trim()) {
        const tdsMinor = Math.abs(parseAmountToMinor(tdsAmount));
        taxAllocations.push(
          compact({
            taxType: 'TDS' as const,
            amountMinor: tdsMinor,
            taxableValueMinor: invoiceSubtotalMinor,
            rate: tdsRate.trim() || undefined,
            tdsSection: tdsSection.trim() || undefined,
            tdsRate: tdsRate.trim() || undefined,
            tdsAmountMinor: tdsMinor,
          }),
        );
      }
    } catch {
      setError('Tax and TDS amounts must be valid numbers.');
      return;
    }

    const debitParty = DEBIT_PARTY_TYPES.has(invoiceType);
    const billType =
      invoiceType === 'Sales' || invoiceType === 'Purchase'
        ? ('New Ref' as const)
        : ('Against Ref' as const);

    const partyLine = compact({
      ledgerId: partyLedgerId,
      amountMinor: debitParty ? invoiceSubtotalMinor : -invoiceSubtotalMinor,
      currency: 'INR',
      billAllocations: [
        compact({
          billRef: invoiceNumber.trim(),
          billType,
          amountMinor: invoiceSubtotalMinor,
          dueDate: dueDate || undefined,
        }),
      ],
      costCenterAllocations: [],
      taxAllocations: [],
    }) as VoucherLineInput;

    const accountLine: VoucherLineInput = {
      ledgerId: accountLedgerId,
      amountMinor: debitParty ? -invoiceSubtotalMinor : invoiceSubtotalMinor,
      currency: 'INR',
      billAllocations: [],
      costCenterAllocations: [],
      taxAllocations,
    };

    setSaving(true);
    try {
      const posted = await postVoucher(getDb(), {
        workspaceId,
        voucherType: invoiceType,
        date: invoiceDate,
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate,
        ...(dueDate ? { dueDate } : {}),
        partyLedgerId,
        ...(invoiceNarration.trim() ? { narration: invoiceNarration.trim() } : {}),
        ...(placeOfSupply.trim() ? { placeOfSupply: placeOfSupply.trim() } : {}),
        ...(gstRegistration.trim() ? { gstRegistration: gstRegistration.trim().toUpperCase() } : {}),
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
          amountMinor: itemAmount(item),
          discountMinor: 0,
          direction: invoiceType === 'Sales' || invoiceType === 'Debit Note' ? 'out' : 'in',
        })),
      });
      setInvoiceNumber('');
      setInvoiceNarration('');
      setTaxAmount('');
      setTdsAmount('');
      setItems([createItem()]);
      onPosted(`Posted ${posted.voucher.number} · ${formatMinor(invoiceSubtotalMinor)}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Record accounting entry"
    >
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Record new entry
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Post a balanced voucher or party invoice directly to your local ledger.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-slate-200 px-6 py-3 dark:border-slate-800">
          <div className="inline-flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => {
                setMode('voucher');
                setError(undefined);
              }}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                mode === 'voucher'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              Payment / Receipt / Journal
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('invoice');
                setError(undefined);
              }}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                mode === 'invoice'
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              Sales / Purchase Invoice
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error ? (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          ) : null}

          {mode === 'voucher' ? (
            <form id="quick-voucher-form" onSubmit={submitVoucher} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Voucher type
                  </label>
                  <select
                    value={voucherType}
                    onChange={(e) => setVoucherType(e.target.value as SimpleVoucherType)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    {SIMPLE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Date
                  </label>
                  <input
                    type="date"
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Reference (UTR / cheque)
                  </label>
                  <input
                    type="text"
                    value={voucherRef}
                    onChange={(e) => setVoucherRef(e.target.value)}
                    placeholder="Optional"
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Narration
                </label>
                <input
                  type="text"
                  value={voucherNarration}
                  onChange={(e) => setVoucherNarration(e.target.value)}
                  placeholder="e.g. Monthly broadband bill paid via NEFT"
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Ledger lines
                  </span>
                  <button
                    type="button"
                    onClick={() => setLines((cur) => [...cur, createLine('', 'debit')])}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add line
                  </button>
                </div>

                <div className="space-y-2.5">
                  {lines.map((line) => (
                    <div
                      key={line.key}
                      className="grid grid-cols-12 items-center gap-2"
                    >
                      <select
                        aria-label="Ledger"
                        value={line.ledgerId}
                        onChange={(e) => updateLine(line.key, { ledgerId: e.target.value })}
                        className="col-span-6 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                      >
                        <option value="">Select ledger…</option>
                        {activeLedgers.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Debit or credit"
                        value={line.side}
                        onChange={(e) => updateLine(line.key, { side: e.target.value as Side })}
                        className="col-span-2 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                      >
                        <option value="debit">Dr</option>
                        <option value="credit">Cr</option>
                      </select>

                      <input
                        aria-label="Amount"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.amount}
                        onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                        className="num-tabular col-span-3 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-right text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                      />

                      <button
                        type="button"
                        disabled={lines.length <= 2}
                        aria-label="Remove line"
                        onClick={() =>
                          setLines((cur) => (cur.length <= 2 ? cur : cur.filter((x) => x.key !== line.key)))
                        }
                        className="col-span-1 flex items-center justify-center rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-600 disabled:opacity-30 dark:hover:bg-slate-800"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </form>
          ) : (
            <form id="quick-invoice-form" onSubmit={submitInvoice} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Document type
                  </label>
                  <select
                    value={invoiceType}
                    onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    {INVOICE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    {invoiceType === 'Purchase' ? 'Supplier bill number' : 'Invoice number'}
                  </label>
                  <input
                    type="text"
                    required
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="INV-2026-105"
                    className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Party (Customer / Vendor)
                  </label>
                  <select
                    value={partyLedgerId}
                    onChange={(e) => setPartyLedgerId(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value="">Select party…</option>
                    {partyLedgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Income / Expense ledger
                  </label>
                  <select
                    value={accountLedgerId}
                    onChange={(e) => setAccountLedgerId(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value="">Select account…</option>
                    {accountLedgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Invoice date
                  </label>
                  <input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Due date <span className="text-slate-400">(optional)</span>
                  </label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="num-tabular mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Line items
                  </span>
                  <button
                    type="button"
                    onClick={() => setItems((cur) => [...cur, createItem()])}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add item
                  </button>
                </div>

                <div className="space-y-3">
                  {items.map((item) => (
                    <div
                      key={item.key}
                      className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                    >
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                        <select
                          aria-label="Stock item"
                          value={item.stockItemId}
                          onChange={(e) => chooseStockItem(item.key, e.target.value)}
                          className="sm:col-span-5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        >
                          <option value="">Custom description…</option>
                          {stockItems
                            .filter((s) => !s.archived)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                        <input
                          aria-label="Description"
                          placeholder="Item or service description"
                          value={item.description}
                          onChange={(e) => updateItem(item.key, { description: e.target.value })}
                          className="sm:col-span-6 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          disabled={items.length <= 1}
                          aria-label="Remove item"
                          onClick={() =>
                            setItems((cur) =>
                              cur.length <= 1 ? cur : cur.filter((x) => x.key !== item.key),
                            )
                          }
                          className="sm:col-span-1 flex items-center justify-center rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-30 dark:hover:bg-slate-800"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-4 items-center gap-2">
                        <input
                          aria-label="Quantity"
                          inputMode="decimal"
                          placeholder="Qty"
                          value={item.quantity}
                          onChange={(e) => updateItem(item.key, { quantity: e.target.value })}
                          className="num-tabular rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        />
                        <input
                          aria-label="Unit"
                          placeholder="UOM"
                          value={item.uom}
                          onChange={(e) => updateItem(item.key, { uom: e.target.value })}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        />
                        <input
                          aria-label="Rate"
                          inputMode="decimal"
                          placeholder="Rate"
                          value={item.rate}
                          onChange={(e) => updateItem(item.key, { rate: e.target.value })}
                          className="num-tabular rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-right text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        />
                        <div className="num-tabular text-right text-sm font-medium text-slate-900 dark:text-slate-100">
                          {formatMinor(itemAmount(item))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowTaxFields((v) => !v)}
                  className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                >
                  {showTaxFields ? 'Hide GST, TDS & narration fields' : '+ Add GST, TDS & narration details'}
                </button>

                {showTaxFields ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Narration
                        </label>
                        <input
                          value={invoiceNarration}
                          onChange={(e) => setInvoiceNarration(e.target.value)}
                          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Place of supply
                        </label>
                        <input
                          value={placeOfSupply}
                          onChange={(e) => setPlaceOfSupply(e.target.value)}
                          placeholder="Karnataka"
                          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          GST type
                        </label>
                        <select
                          value={taxType}
                          onChange={(e) => setTaxType(e.target.value as TaxType)}
                          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        >
                          {TAX_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          GST rate (%)
                        </label>
                        <input
                          value={taxRate}
                          onChange={(e) => setTaxRate(e.target.value)}
                          placeholder="18"
                          className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          GST amount
                        </label>
                        <input
                          inputMode="decimal"
                          value={taxAmount}
                          onChange={(e) => setTaxAmount(e.target.value)}
                          placeholder="0.00"
                          className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-right text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          TDS section
                        </label>
                        <input
                          value={tdsSection}
                          onChange={(e) => setTdsSection(e.target.value)}
                          placeholder="194J"
                          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          TDS rate (%)
                        </label>
                        <input
                          value={tdsRate}
                          onChange={(e) => setTdsRate(e.target.value)}
                          placeholder="10"
                          className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          TDS amount
                        </label>
                        <input
                          inputMode="decimal"
                          value={tdsAmount}
                          onChange={(e) => setTdsAmount(e.target.value)}
                          placeholder="0.00"
                          className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-right text-sm dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Party GSTIN
                        </label>
                        <input
                          value={gstRegistration}
                          onChange={(e) => setGstRegistration(e.target.value.toUpperCase())}
                          placeholder="29ABCDE1234F1Z5"
                          className="num-tabular mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm uppercase dark:border-slate-700 dark:bg-slate-950"
                        />
                      </div>
                      <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={reverseCharge}
                          onChange={(e) => setReverseCharge(e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        <span>Reverse charge applicable</span>
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            </form>
          )}
        </div>

        {/* Sticky footer with balance verification & primary submit */}
        <div className="flex items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-950">
          {mode === 'voucher' ? (
            <div className="text-xs">
              <div className="text-slate-500 dark:text-slate-400">Balance check</div>
              <div
                className={`num-tabular mt-0.5 font-medium ${
                  voucherTotals.balanced
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                Dr {formatMinor(voucherTotals.debit)} · Cr {formatMinor(voucherTotals.credit)}
              </div>
            </div>
          ) : (
            <div className="text-xs">
              <div className="text-slate-500 dark:text-slate-400">Document total</div>
              <div className="num-tabular mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                {formatMinor(invoiceSubtotalMinor)}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={mode === 'voucher' ? 'quick-voucher-form' : 'quick-invoice-form'}
              disabled={
                saving ||
                (mode === 'voucher' ? !voucherTotals.balanced : invoiceSubtotalMinor <= 0)
              }
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              {saving
                ? 'Posting…'
                : mode === 'voucher'
                  ? `Post ${voucherType.toLowerCase()}`
                  : `Post ${invoiceType.toLowerCase()}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
