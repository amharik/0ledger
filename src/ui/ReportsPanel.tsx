import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import { isNativeStoreAvailable, nativeStore } from '@/core/db/native-store';
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

export type FinancialReportTab = 'pnl' | 'balance' | 'trial' | 'parties';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Props {
  workspaceId: string;
  refreshToken: number;
  activeTab?: FinancialReportTab;
  onTabChange?: (tab: FinancialReportTab) => void;
}

export function ReportsPanel({
  workspaceId,
  refreshToken,
  activeTab,
  onTabChange,
}: Props) {
  const [internalTab, setInternalTab] = useState<FinancialReportTab>('pnl');
  const tab = activeTab ?? internalTab;
  const setTab = (next: FinancialReportTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };

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
    const useSqlite = isNativeStoreAvailable();
    void Promise.all([
      useSqlite ? nativeStore.trialBalance(workspaceId) : trialBalance(db, workspaceId),
      useSqlite ? nativeStore.profitAndLoss(workspaceId) : profitAndLoss(db, workspaceId),
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

  const totalIncomeMinor = (pnl?.income ?? []).reduce((s, r) => s + r.amountMinor, 0);
  const totalExpenseMinor = (pnl?.expenses ?? []).reduce((s, r) => s + r.amountMinor, 0);

  return (
    <div className="space-y-5">
      {!activeTab ? (
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/80">
          {(
            [
              { id: 'pnl', label: 'Profit & Loss' },
              { id: 'balance', label: 'Balance Sheet' },
              { id: 'trial', label: 'Trial Balance' },
              { id: 'parties', label: 'Parties & Aging' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === item.id
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {/* Profit & Loss */}
      {tab === 'pnl' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            <div className="p-5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total income</div>
              <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {loading ? '—' : formatMinor(totalIncomeMinor)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total expenses</div>
              <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {loading ? '—' : formatMinor(totalExpenseMinor)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Net profit</div>
              <div
                className={`num-tabular mt-1.5 text-xl font-semibold ${
                  (pnl?.netProfitMinor ?? 0) >= 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {loading ? '—' : formatMinor(pnl?.netProfitMinor ?? 0)}
              </div>
            </div>
          </div>

          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {loading ? (
              <div className="space-y-2 p-6">
                <div className="h-9 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
                <div className="h-9 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
              </div>
            ) : (pnl?.income.length ?? 0) === 0 && (pnl?.expenses.length ?? 0) === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                Post income or expense entries to generate your Profit &amp; Loss statement.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-5 py-3">Category</th>
                      <th className="px-5 py-3">Ledger</th>
                      <th className="px-5 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {pnl?.income.map((row) => (
                      <tr key={`i-${row.ledgerId}`}>
                        <td className="px-5 py-3 text-xs text-emerald-700 dark:text-emerald-400">
                          Income
                        </td>
                        <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                          {row.name}
                        </td>
                        <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                          {formatMinor(row.amountMinor)}
                        </td>
                      </tr>
                    ))}
                    {pnl?.expenses.map((row) => (
                      <tr key={`e-${row.ledgerId}`}>
                        <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                          Expense
                        </td>
                        <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                          {row.name}
                        </td>
                        <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                          {formatMinor(row.amountMinor)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-semibold dark:bg-slate-950/60">
                      <td colSpan={2} className="px-5 py-3.5 text-slate-900 dark:text-slate-100">
                        Net profit
                      </td>
                      <td
                        className={`num-tabular px-5 py-3.5 text-right ${
                          (pnl?.netProfitMinor ?? 0) >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {formatMinor(pnl?.netProfitMinor ?? 0)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {/* Balance Sheet */}
      {tab === 'balance' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            <div className="p-5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total assets</div>
              <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {loading ? '—' : formatMinor(bs?.totalAssetsMinor ?? 0)}
              </div>
            </div>
            <div className="p-5">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total liabilities</div>
              <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {loading ? '—' : formatMinor(bs?.totalLiabilitiesMinor ?? 0)}
              </div>
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Equity + Net profit</span>
                {bs ? (
                  <span
                    className={`font-medium ${
                      bs.balanced
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {bs.balanced ? 'Balanced' : 'Unbalanced'}
                  </span>
                ) : null}
              </div>
              <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {loading
                  ? '—'
                  : formatMinor((bs?.totalEquityMinor ?? 0) + (bs?.netProfitMinor ?? 0))}
              </div>
            </div>
          </div>

          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-5 py-3">Section</th>
                    <th className="px-5 py-3">Ledger</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {bs?.assets.map((row) => (
                    <tr key={`a-${row.ledgerId}`}>
                      <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">Asset</td>
                      <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                        {row.name}
                      </td>
                      <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                        {formatMinor(row.amountMinor)}
                      </td>
                    </tr>
                  ))}
                  {bs?.liabilities.map((row) => (
                    <tr key={`l-${row.ledgerId}`}>
                      <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                        Liability
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                        {row.name}
                      </td>
                      <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                        {formatMinor(row.amountMinor)}
                      </td>
                    </tr>
                  ))}
                  {bs?.equity.map((row) => (
                    <tr key={`q-${row.ledgerId}`}>
                      <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                        Equity
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                        {row.name}
                      </td>
                      <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                        {formatMinor(row.amountMinor)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">Equity</td>
                    <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                      Current period net profit
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                      {formatMinor(bs?.netProfitMinor ?? 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {/* Trial Balance */}
      {tab === 'trial' ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {!nonZeroTrial || nonZeroTrial.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
              Post a voucher or set an opening balance to view your Trial Balance.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-5 py-3">Ledger</th>
                    <th className="px-5 py-3">Tally group</th>
                    <th className="px-5 py-3 text-right">Debit</th>
                    <th className="px-5 py-3 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {nonZeroTrial.map((row) => (
                    <tr key={row.ledgerId}>
                      <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                        {row.name}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                        {row.tallyParent}
                      </td>
                      <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                        {row.closingMinor > 0 ? formatMinor(row.closingMinor) : '—'}
                      </td>
                      <td className="num-tabular px-5 py-3 text-right text-slate-900 dark:text-slate-100">
                        {row.closingMinor < 0 ? formatMinor(-row.closingMinor) : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold dark:bg-slate-950/60">
                    <td colSpan={2} className="px-5 py-3.5 text-slate-900 dark:text-slate-100">
                      Total
                    </td>
                    <td className="num-tabular px-5 py-3.5 text-right text-slate-900 dark:text-slate-100">
                      {formatMinor(tb?.totalDebitMinor ?? 0)}
                    </td>
                    <td className="num-tabular px-5 py-3.5 text-right text-slate-900 dark:text-slate-100">
                      {formatMinor(tb?.totalCreditMinor ?? 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* Parties & Bill Aging */}
      {tab === 'parties' ? (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Party balances
              </h3>
            </div>
            {parties.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                No outstanding party balances yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-5 py-3">Party</th>
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3 text-right">Bills</th>
                      <th className="px-5 py-3 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {parties.map((row) => (
                      <tr key={row.ledgerId}>
                        <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                          {row.partyName}
                        </td>
                        <td className="px-5 py-3 text-xs capitalize text-slate-500 dark:text-slate-400">
                          {row.type}
                        </td>
                        <td className="num-tabular px-5 py-3 text-right text-slate-600 dark:text-slate-400">
                          {row.billCount}
                        </td>
                        <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                          {formatMinor(row.outstandingMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Bill-wise aging
              </h3>
              <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>As of</span>
                <input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="num-tabular rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
            </div>
            {aging.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                No open bills as of {asOf}.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="px-5 py-3">Party</th>
                      <th className="px-5 py-3">Bill ref</th>
                      <th className="px-5 py-3">Due date</th>
                      <th className="px-5 py-3">Bucket</th>
                      <th className="px-5 py-3 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {aging.map((row) => (
                      <tr key={`${row.ledgerId}-${row.billRef}`}>
                        <td className="px-5 py-3 font-medium text-slate-900 dark:text-slate-100">
                          {row.partyName}
                        </td>
                        <td className="num-tabular px-5 py-3 text-xs text-slate-700 dark:text-slate-300">
                          {row.billRef}
                        </td>
                        <td className="num-tabular px-5 py-3 text-xs text-slate-600 dark:text-slate-400">
                          {row.dueDate}
                        </td>
                        <td
                          className={`px-5 py-3 text-xs font-medium ${
                            row.bucket === 'current'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          {row.bucket}
                        </td>
                        <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                          {formatMinor(row.outstandingMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
