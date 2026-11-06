import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import {
  cancelVoucher,
  deleteVoucher,
  updateVoucher,
  type PostedVoucher,
} from '@/core/ledger';
import { formatMinor, minorToDecimalString, parseAmountToMinor } from '@/core/money/money';
import { compact } from '@/core/util/objects';
import type { Ledger, NewVoucher, VoucherType } from '@/core/model';

type Side = 'debit' | 'credit';

interface DraftLine {
  key: string;
  ledgerId: string;
  side: Side;
  amount: string;
}

interface Draft {
  date: string;
  narration: string;
  reference: string;
  lines: DraftLine[];
}

const EDITABLE_TYPES = new Set<VoucherType>(['Payment', 'Receipt', 'Contra', 'Journal']);

function toDraft(posted: PostedVoucher): Draft {
  return {
    date: posted.voucher.date,
    narration: posted.voucher.narration ?? '',
    reference: posted.voucher.reference ?? '',
    lines: posted.lines.map((line) => ({
      key: line.id,
      ledgerId: line.ledgerId,
      side: line.amountMinor >= 0 ? 'debit' : 'credit',
      amount: minorToDecimalString(Math.abs(line.amountMinor)),
    })),
  };
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
  posted: PostedVoucher;
  ledgers: Ledger[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onDeleted: (message: string) => void;
}

export function VoucherReview({ posted, ledgers, onClose, onSaved, onDeleted }: Props) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(posted));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const { voucher } = posted;
  const editable =
    voucher.status === 'regular' &&
    EDITABLE_TYPES.has(voucher.voucherType) &&
    posted.items.length === 0 &&
    posted.billAllocations.length === 0 &&
    posted.costCenterAllocations.length === 0 &&
    posted.taxAllocations.length === 0;
  const deletable = voucher.status === 'cancelled';

  useEffect(() => {
    setDraft(toDraft(posted));
  }, [posted]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let invalid = false;
    for (const line of draft.lines) {
      const raw = line.amount.trim();
      if (!raw) continue;
      try {
        const amount = parseAmountToMinor(raw);
        if (amount <= 0) {
          invalid = true;
          continue;
        }
        if (line.side === 'debit') debit += amount;
        else credit += amount;
      } catch {
        invalid = true;
      }
    }
    return { debit, credit, invalid, balanced: debit === credit && debit > 0 };
  }, [draft.lines]);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  }

  function removeLine(key: string) {
    setDraft((current) => ({
      ...current,
      lines:
        current.lines.length <= 2
          ? current.lines
          : current.lines.filter((line) => line.key !== key),
    }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editable) return;
    setError(undefined);

    if (draft.lines.length < 2) {
      setError('Add at least two ledger lines.');
      return;
    }
    if (draft.lines.some((line) => !line.ledgerId)) {
      setError('Choose a ledger on every line.');
      return;
    }
    if (totals.invalid || !totals.balanced) {
      setError('Debit and credit totals must match and amounts must be positive.');
      return;
    }

    const payload = compact({
      workspaceId: voucher.workspaceId,
      voucherType: voucher.voucherType,
      number: voucher.number,
      date: draft.date,
      narration: draft.narration.trim() || undefined,
      reference: draft.reference.trim() || undefined,
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
      groupIds: voucher.groupIds,
      accountingId: voucher.accountingId,
      tags: voucher.tags,
      tally: voucher.tally,
      items: [],
      lines: draft.lines.map((line) => {
        const amount = parseAmountToMinor(line.amount);
        return {
          ledgerId: line.ledgerId,
          amountMinor: line.side === 'debit' ? amount : -amount,
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
      onSaved(`Updated ${updated.voucher.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(`Cancel voucher ${voucher.number}? It will be excluded from reports.`)) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const cancelled = await cancelVoucher(getDb(), voucher.id);
      onSaved(`Cancelled ${cancelled.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Permanently delete voucher ${voucher.number}? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await deleteVoucher(getDb(), voucher.id);
      onDeleted(`Deleted ${voucher.number}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>
          {voucher.number}{' '}
          <span className={voucher.status === 'regular' ? 'positive small' : 'negative small'}>
            {voucher.status}
          </span>
        </h2>
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      <p className="muted small">
        {voucher.voucherType} · {voucher.date}
        {voucher.source !== 'manual' ? ` · ${voucher.source}` : ''}
      </p>

      {error ? <div className="alert danger">{error}</div> : null}
      {!editable ? (
        <div className="alert">
          {voucher.status !== 'regular'
            ? 'This voucher is cancelled and cannot be edited.'
            : 'This voucher has item or allocation detail. Review it here; editing is not available for this type yet.'}
        </div>
      ) : null}

      {editable ? (
        <form className="voucher-form" onSubmit={save}>
          <div className="form-row">
            <label>
              <span>Date</span>
              <input
                type="date"
                value={draft.date}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, date: event.target.value }))
                }
                disabled={busy}
              />
            </label>
            <label>
              <span>Reference</span>
              <input
                value={draft.reference}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reference: event.target.value }))
                }
                disabled={busy}
              />
            </label>
          </div>
          <label>
            <span>Narration</span>
            <input
              value={draft.narration}
              onChange={(event) =>
                setDraft((current) => ({ ...current, narration: event.target.value }))
              }
              disabled={busy}
            />
          </label>

          <div className="lines">
            {draft.lines.map((line) => (
              <div className="line-row" key={line.key}>
                <select
                  aria-label="Ledger"
                  value={line.ledgerId}
                  onChange={(event) => updateLine(line.key, { ledgerId: event.target.value })}
                  disabled={busy}
                >
                  <option value="">Select ledger…</option>
                  {ledgers.map((ledger) => (
                    <option key={ledger.id} value={ledger.id}>
                      {ledger.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Side"
                  value={line.side}
                  onChange={(event) => updateLine(line.key, { side: event.target.value as Side })}
                  disabled={busy}
                >
                  <option value="debit">Dr</option>
                  <option value="credit">Cr</option>
                </select>
                <input
                  aria-label="Amount"
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(event) => updateLine(line.key, { amount: event.target.value })}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon ghost"
                  onClick={() => removeLine(line.key)}
                  disabled={busy || draft.lines.length <= 2}
                  aria-label="Remove line"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  lines: [
                    ...current.lines,
                    {
                      key: crypto.randomUUID(),
                      ledgerId: '',
                      side: 'debit',
                      amount: '',
                    },
                  ],
                }))
              }
              disabled={busy}
            >
              Add line
            </button>
            <span className={`balance ${totals.balanced ? 'positive' : 'negative'}`}>
              Dr {formatMinor(totals.debit)} · Cr {formatMinor(totals.credit)}
            </span>
            <button type="submit" disabled={busy || !totals.balanced}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Ledger</th>
                <th className="num">Dr</th>
                <th className="num">Cr</th>
              </tr>
            </thead>
            <tbody>
              {posted.lines.map((line) => (
                <tr key={line.id}>
                  <td>{ledgers.find((ledger) => ledger.id === line.ledgerId)?.name ?? line.ledgerId}</td>
                  <td className="num">
                    {line.amountMinor > 0 ? formatMinor(line.amountMinor) : '—'}
                  </td>
                  <td className="num">
                    {line.amountMinor < 0 ? formatMinor(-line.amountMinor) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="form-actions review-actions">
        <button
          type="button"
          className="danger"
          onClick={() => void cancel()}
          disabled={busy || voucher.status === 'cancelled'}
        >
          Cancel voucher
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void remove()}
          disabled={busy || !deletable}
          title={deletable ? 'Permanently delete' : 'Cancel the voucher first'}
        >
          Delete
        </button>
      </div>
    </section>
  );
}
