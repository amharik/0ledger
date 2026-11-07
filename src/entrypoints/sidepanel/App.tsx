import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getDb } from '@/core/db/db';
import { getPostedVoucher, postVoucher, type PostedVoucher } from '@/core/ledger';
import { listParties, listStockItems, type PartyView } from '@/core/db/master-service';
import { partyOutstanding, trialBalance, type TrialBalance } from '@/core/ledger/reports';
import { formatMinor, parseAmountToMinor } from '@/core/money/money';
import type { Ledger, StockItem, Voucher, VoucherType } from '@/core/model';
import { useWorkspace } from '@/ui/workspace';
import { InvoiceEntry } from '@/ui/InvoiceEntry';
import { ReconciliationPanel } from '@/ui/ReconciliationPanel';
import { ReportsPanel } from '@/ui/ReportsPanel';
import { StatementImport } from '@/ui/StatementImport';
import { VoucherReview } from '@/ui/VoucherReview';

type Side = 'debit' | 'credit';

interface DraftLine {
  key: string;
  ledgerId: string;
  side: Side;
  amount: string;
}

const VOUCHER_TYPES: VoucherType[] = ['Payment', 'Receipt', 'Contra', 'Journal'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function newLine(ledgerId = '', side: Side = 'debit'): DraftLine {
  return { key: crypto.randomUUID(), ledgerId, side, amount: '' };
}

function defaultLines(ledgers: Ledger[]): DraftLine[] {
  const cash = ledgers.find((ledger) => ledger.isCash) ?? ledgers[0];
  const expense =
    ledgers.find((ledger) => ledger.name === 'Purchases') ??
    ledgers.find((ledger) => ledger.name === 'General Expenses') ??
    ledgers[1] ??
    ledgers[0];
  return [newLine(expense?.id ?? '', 'debit'), newLine(cash?.id ?? '', 'credit')];
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const issues = (cause as Error & { issues?: Array<{ message: string }> }).issues;
    if (issues && issues.length > 0) return issues.map((issue) => issue.message).join(' · ');
    return cause.message;
  }
  return String(cause);
}

export default function App() {
  const { bundle, workspaces, loading, error, reload, selectWorkspace } = useWorkspace();
  const [voucherType, setVoucherType] = useState<VoucherType>('Payment');
  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [tb, setTb] = useState<TrialBalance>();
  const [recent, setRecent] = useState<Voucher[]>([]);
  const [voucherCount, setVoucherCount] = useState(0);
  const [openMatches, setOpenMatches] = useState(0);
  const [matchedLines, setMatchedLines] = useState(0);
  const [partyDue, setPartyDue] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<PostedVoucher>();
  const [parties, setParties] = useState<PartyView[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);

  const workspaceId = bundle?.workspace.id;
  const ledgerList = bundle?.ledgers ?? [];

  useEffect(() => {
    if (bundle) setLines(defaultLines(bundle.ledgers));
  }, [bundle]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const db = getDb();
      const [report, vouchers, statementLines, partiesReport] = await Promise.all([
        trialBalance(db, workspaceId),
        db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
        db.statementLines.where('workspaceId').equals(workspaceId).toArray(),
        partyOutstanding(db, workspaceId),
      ]);
      if (cancelled) return;
      setTb(report);
      setVoucherCount(vouchers.length);
      setOpenMatches(
        statementLines.filter(
          (line) => line.matchStatus === 'unmatched' || line.matchStatus === 'suggested',
        ).length,
      );
      setMatchedLines(statementLines.filter((line) => line.matchStatus === 'matched').length);
      setPartyDue(partiesReport.reduce((sum, row) => sum + row.outstandingMinor, 0));
      setRecent(
        vouchers
          .sort(
            (a, b) =>
              b.date.localeCompare(a.date) ||
              (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
          )
          .slice(0, 8),
      );
    })().catch((cause) => {
      if (!cancelled) setFormError(errorMessage(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void Promise.all([listParties(getDb(), workspaceId), listStockItems(getDb(), workspaceId)])
      .then(([partyRows, stockRows]) => {
        if (cancelled) return;
        setParties(partyRows);
        setStockItems(stockRows);
      })
      .catch((cause) => {
        if (!cancelled) setFormError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(undefined);
      return;
    }
    let cancelled = false;
    void getPostedVoucher(getDb(), selectedId)
      .then((posted) => {
        if (cancelled) return;
        if (!posted) {
          setSelectedId(undefined);
          setSelected(undefined);
          return;
        }
        setSelected(posted);
      })
      .catch((cause) => {
        if (!cancelled) setFormError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshToken]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    let invalid = false;
    for (const line of lines) {
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
  }, [lines]);

  const busy = loading || saving;

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(key: string) {
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!bundle) return;
    setFormError(undefined);
    setNotice(undefined);

    if (lines.length < 2) {
      setFormError('Add at least two ledger lines.');
      return;
    }
    if (lines.some((line) => !line.ledgerId)) {
      setFormError('Choose a ledger on every line.');
      return;
    }
    if (totals.invalid || !totals.balanced) {
      setFormError('Debit and credit totals must match and amounts must be positive.');
      return;
    }

    setSaving(true);
    try {
      const posted = await postVoucher(getDb(), {
        workspaceId: bundle.workspace.id,
        voucherType,
        date,
        narration: narration.trim(),
        reverseCharge: false,
        status: 'regular',
        currency: 'INR',
        source: 'manual',
        groupIds: [],
        tags: [],
        items: [],
        lines: lines.map((line) => {
          const amount = parseAmountToMinor(line.amount);
          return {
            ledgerId: line.ledgerId,
            amountMinor: line.side === 'debit' ? amount : -amount,
            currency: 'INR',
            billAllocations: [],
            costCenterAllocations: [],
            taxAllocations: [],
          };
        }),
      });
      setNotice(`Posted ${posted.voucher.number}`);
      setNarration('');
      setLines(defaultLines(bundle.ledgers));
      setRefreshToken((value) => value + 1);
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="shell">
      <header>
        <div>
          <h1>0ledger</h1>
          <p className="muted small">
            {bundle ? bundle.workspace.name : 'Local-first double-entry ledger'}
          </p>
        </div>
        <div className="header-actions">
          {workspaces.length > 1 && bundle ? (
            <select
              aria-label="Workspace"
              value={bundle.workspace.id}
              onChange={(event) => void selectWorkspace(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          ) : null}
          <button className="ghost" onClick={() => void reload()} disabled={loading}>
            Refresh
          </button>
          <button className="ghost" onClick={() => chrome.runtime.openOptionsPage()}>
            Settings
          </button>
        </div>
      </header>

      {error ? <div className="alert danger">{error}</div> : null}
      {formError ? <div className="alert danger">{formError}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      {loading ? <p className="muted">Loading ledger…</p> : null}

      {!loading && !bundle ? (
        <section className="card">
          <h2>No workspace yet</h2>
          <p className="muted">
            Create your company workspace in Settings. One workspace holds one company.
          </p>
          <button onClick={() => chrome.runtime.openOptionsPage()}>Open settings</button>
        </section>
      ) : null}

      {bundle ? (
        <>
          <section className="card stats">
            <div>
              <span className="muted small">Trial balance</span>
              <strong className={tb?.balanced ? 'positive' : 'negative'}>
                {tb?.balanced ? 'Balanced' : 'Unbalanced'}
              </strong>
            </div>
            <div>
              <span className="muted small">Debits</span>
              <strong>{formatMinor(tb?.totalDebitMinor ?? 0)}</strong>
            </div>
            <div>
              <span className="muted small">Credits</span>
              <strong>{formatMinor(tb?.totalCreditMinor ?? 0)}</strong>
            </div>
            <div>
              <span className="muted small">Vouchers</span>
              <strong>{voucherCount}</strong>
            </div>
            <div>
              <span className="muted small">Bank balance</span>
              <strong>
                {formatMinor(
                  tb?.rows.find((row) => row.name === 'Bank Account')?.closingMinor ?? 0,
                )}
              </strong>
            </div>
            <div>
              <span className="muted small">Party due</span>
              <strong>{formatMinor(partyDue)}</strong>
            </div>
            <div>
              <span className="muted small">Open matches</span>
              <strong className={openMatches > 0 ? 'negative' : 'positive'}>
                {openMatches} · {matchedLines} matched
              </strong>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <h2>New voucher</h2>
              <span className="muted small">Dr positive · Cr negative</span>
            </div>
            <form onSubmit={submit} className="voucher-form">
              <div className="form-row">
                <label>
                  <span>Type</span>
                  <select
                    value={voucherType}
                    onChange={(event) => setVoucherType(event.target.value as VoucherType)}
                  >
                    {VOUCHER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Date</span>
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                </label>
              </div>
              <label>
                <span>Narration</span>
                <input
                  value={narration}
                  onChange={(event) => setNarration(event.target.value)}
                  placeholder="What is this entry for?"
                />
              </label>

              <div className="lines">
                {lines.map((line) => (
                  <div className="line-row" key={line.key}>
                    <select
                      aria-label="Ledger"
                      value={line.ledgerId}
                      onChange={(event) => updateLine(line.key, { ledgerId: event.target.value })}
                    >
                      <option value="">Select ledger…</option>
                      {ledgerList.map((ledger) => (
                        <option key={ledger.id} value={ledger.id}>
                          {ledger.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Side"
                      value={line.side}
                      onChange={(event) => updateLine(line.key, { side: event.target.value as Side })}
                    >
                      <option value="debit">Dr</option>
                      <option value="credit">Cr</option>
                    </select>
                    <input
                      aria-label="Amount"
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(event) => updateLine(line.key, { amount: event.target.value })}
                      placeholder="0.00"
                    />
                    <button
                      type="button"
                      className="icon ghost"
                      onClick={() => removeLine(line.key)}
                      disabled={lines.length <= 2}
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
                  onClick={() => setLines((current) => [...current, newLine()])}
                >
                  Add line
                </button>
                <span className={`balance ${totals.balanced ? 'positive' : 'negative'}`}>
                  Dr {formatMinor(totals.debit)} · Cr {formatMinor(totals.credit)}
                  {!totals.balanced && !totals.invalid && totals.debit + totals.credit > 0
                    ? ` · diff ${formatMinor(Math.abs(totals.debit - totals.credit))}`
                    : ''}
                </span>
                <button type="submit" disabled={busy || !totals.balanced}>
                  {saving ? 'Posting…' : 'Post voucher'}
                </button>
              </div>
            </form>
          </section>

          <ReconciliationPanel
            workspaceId={bundle.workspace.id}
            ledgers={ledgerList}
            refreshToken={refreshToken}
            onChanged={(message) => {
              setNotice(message);
              setFormError(undefined);
              setRefreshToken((value) => value + 1);
            }}
          />

          <StatementImport
            workspaceId={bundle.workspace.id}
            ledgers={ledgerList}
            refreshToken={refreshToken}
            onChanged={(message) => {
              setNotice(message);
              setFormError(undefined);
              setRefreshToken((value) => value + 1);
            }}
          />

          <InvoiceEntry
            workspaceId={bundle.workspace.id}
            ledgers={ledgerList}
            parties={parties}
            stockItems={stockItems}
            onPosted={(message) => {
              setNotice(message);
              setFormError(undefined);
              setRefreshToken((value) => value + 1);
            }}
          />

          <section className="card">
            <div className="section-head">
              <h2>Recent vouchers</h2>
              <span className="muted small">latest {recent.length}</span>
            </div>
            {recent.length === 0 ? (
              <p className="muted">No vouchers posted yet.</p>
            ) : (
              <ul className="list">
                {recent.map((voucher) => (
                  <li key={voucher.id}>
                    <div>
                      <strong>{voucher.number}</strong>
                      <div className="muted small">
                        {voucher.voucherType} · {voucher.date}
                        {voucher.narration ? ` · ${voucher.narration}` : ''}
                        {voucher.status !== 'regular' ? ` · ${voucher.status}` : ''}
                      </div>
                    </div>
                    <div className="recent-actions">
                      <span className={voucher.status === 'regular' ? 'positive' : 'muted'}>
                        {formatMinor(voucher.totalDebitMinor)}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setSelectedId(voucher.id)}
                      >
                        Review
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selected ? (
            <VoucherReview
              key={`${selected.voucher.id}:${selected.voucher.updatedAt}`}
              posted={selected}
              ledgers={ledgerList}
              onClose={() => {
                setSelectedId(undefined);
                setSelected(undefined);
              }}
              onSaved={(message) => {
                setNotice(message);
                setFormError(undefined);
                setRefreshToken((value) => value + 1);
              }}
              onDeleted={(message) => {
                setNotice(message);
                setFormError(undefined);
                setSelectedId(undefined);
                setSelected(undefined);
                setRefreshToken((value) => value + 1);
              }}
            />
          ) : null}

          <ReportsPanel workspaceId={bundle.workspace.id} refreshToken={refreshToken} />
        </>
      ) : null}
    </main>
  );
}
