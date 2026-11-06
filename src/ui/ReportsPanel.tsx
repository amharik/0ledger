import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  balanceSheet,
  billAging,
  partyOutstanding,
  profitAndLoss,
  trialBalance,
  type BalanceSheet,
  type BillAgingRow,
  type PartyOutstandingRow,
  type ProfitAndLoss,
  type TrialBalance,
} from '@/core/ledger/reports';
import { formatMinor } from '@/core/money/money';

type ReportTab = 'trial' | 'pnl' | 'balance' | 'parties' | 'aging';

const TABS: Array<{ id: ReportTab; label: string }> = [
  { id: 'trial', label: 'Trial balance' },
  { id: 'pnl', label: 'P&L' },
  { id: 'balance', label: 'Balance sheet' },
  { id: 'parties', label: 'Parties' },
  { id: 'aging', label: 'Bill aging' },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Props {
  workspaceId: string;
  refreshToken: number;
}

export function ReportsPanel({ workspaceId, refreshToken }: Props) {
  const [tab, setTab] = useState<ReportTab>('trial');
  const [asOf, setAsOf] = useState(today());
  const [tb, setTb] = useState<TrialBalance>();
  const [pnl, setPnl] = useState<ProfitAndLoss>();
  const [bs, setBs] = useState<BalanceSheet>();
  const [parties, setParties] = useState<PartyOutstandingRow[]>([]);
  const [aging, setAging] = useState<BillAgingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const db = getDb();
    void Promise.all([
      trialBalance(db, workspaceId),
      profitAndLoss(db, workspaceId),
      balanceSheet(db, workspaceId),
      partyOutstanding(db, workspaceId),
      billAging(db, workspaceId, asOf),
    ])
      .then(([trial, profit, balance, partyRows, agingRows]) => {
        if (cancelled) return;
        setTb(trial);
        setPnl(profit);
        setBs(balance);
        setParties(partyRows);
        setAging(agingRows);
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
  }, [workspaceId, refreshToken, asOf]);

  const nonZeroTrial = tb?.rows.filter(
    (row) => row.closingMinor !== 0 || row.debitMinor !== 0 || row.creditMinor !== 0,
  );

  return (
    <section className="card">
      <div className="section-head">
        <h2>Reports</h2>
        {tab === 'aging' ? (
          <label className="inline-field">
            <span className="muted small">As of</span>
            <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
          </label>
        ) : (
          <span className="muted small">{loading ? 'Loading…' : 'live from local ledger'}</span>
        )}
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            type="button"
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'tab active' : 'tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="alert danger">{error}</div> : null}

      {tab === 'trial' ? (
        !nonZeroTrial || nonZeroTrial.length === 0 ? (
          <p className="muted">Post a voucher to see balances.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ledger</th>
                  <th>Group</th>
                  <th className="num">Dr</th>
                  <th className="num">Cr</th>
                </tr>
              </thead>
              <tbody>
                {nonZeroTrial.map((row) => (
                  <tr key={row.ledgerId}>
                    <td>{row.name}</td>
                    <td className="muted small">{row.tallyParent}</td>
                    <td className="num">{row.closingMinor > 0 ? formatMinor(row.closingMinor) : '—'}</td>
                    <td className="num">
                      {row.closingMinor < 0 ? formatMinor(-row.closingMinor) : '—'}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>
                    <strong>Total</strong>
                  </td>
                  <td className="num">
                    <strong>{formatMinor(tb?.totalDebitMinor ?? 0)}</strong>
                  </td>
                  <td className="num">
                    <strong>{formatMinor(tb?.totalCreditMinor ?? 0)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === 'pnl' ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Ledger</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {pnl?.income.map((row) => (
                <tr key={`i-${row.ledgerId}`}>
                  <td className="muted">Income</td>
                  <td>{row.name}</td>
                  <td className="num">{formatMinor(row.amountMinor)}</td>
                </tr>
              ))}
              {pnl?.expenses.map((row) => (
                <tr key={`e-${row.ledgerId}`}>
                  <td className="muted">Expense</td>
                  <td>{row.name}</td>
                  <td className="num">{formatMinor(row.amountMinor)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  <strong>Net profit</strong>
                </td>
                <td className={`num ${(pnl?.netProfitMinor ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                  <strong>{formatMinor(pnl?.netProfitMinor ?? 0)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'balance' ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Side</th>
                <th>Ledger</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bs?.assets.map((row) => (
                <tr key={`a-${row.ledgerId}`}>
                  <td className="muted">Asset</td>
                  <td>{row.name}</td>
                  <td className="num">{formatMinor(row.amountMinor)}</td>
                </tr>
              ))}
              {bs?.liabilities.map((row) => (
                <tr key={`l-${row.ledgerId}`}>
                  <td className="muted">Liability</td>
                  <td>{row.name}</td>
                  <td className="num">{formatMinor(row.amountMinor)}</td>
                </tr>
              ))}
              {bs?.equity.map((row) => (
                <tr key={`q-${row.ledgerId}`}>
                  <td className="muted">Equity</td>
                  <td>{row.name}</td>
                  <td className="num">{formatMinor(row.amountMinor)}</td>
                </tr>
              ))}
              <tr>
                <td className="muted">Equity</td>
                <td>Net profit</td>
                <td className="num">{formatMinor(bs?.netProfitMinor ?? 0)}</td>
              </tr>
              <tr>
                <td colSpan={2}>
                  <strong>
                    Assets {formatMinor(bs?.totalAssetsMinor ?? 0)} · Liabilities{' '}
                    {formatMinor(bs?.totalLiabilitiesMinor ?? 0)} · Equity{' '}
                    {formatMinor((bs?.totalEquityMinor ?? 0) + (bs?.netProfitMinor ?? 0))}
                  </strong>
                </td>
                <td className={`num ${bs?.balanced ? 'positive' : 'negative'}`}>
                  <strong>{bs?.balanced ? 'Balanced' : 'Check'}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'parties' ? (
        parties.length === 0 ? (
          <p className="muted">No party balances yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Type</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Bills</th>
                </tr>
              </thead>
              <tbody>
                {parties.map((row) => (
                  <tr key={row.ledgerId}>
                    <td>{row.partyName}</td>
                    <td className="muted">{row.type}</td>
                    <td className="num">{formatMinor(row.outstandingMinor)}</td>
                    <td className="num">{row.billCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === 'aging' ? (
        aging.length === 0 ? (
          <p className="muted">No open bills as of {asOf}.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Party</th>
                  <th>Bill</th>
                  <th>Due</th>
                  <th className="num">Outstanding</th>
                  <th>Bucket</th>
                </tr>
              </thead>
              <tbody>
                {aging.map((row) => (
                  <tr key={`${row.ledgerId}-${row.billRef}`}>
                    <td>{row.partyName}</td>
                    <td>{row.billRef}</td>
                    <td>{row.dueDate}</td>
                    <td className="num">{formatMinor(row.outstandingMinor)}</td>
                    <td className={row.bucket === 'current' ? 'positive' : 'negative'}>
                      {row.bucket}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
