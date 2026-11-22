import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import { stockReport, type StockReport as StockReportData } from '@/core/inventory';
import { formatMinor } from '@/core/money/money';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function quantity(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

interface Props {
  workspaceId: string;
  refreshToken: number;
}

export function StockReport({ workspaceId, refreshToken }: Props) {
  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState<StockReportData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void stockReport(getDb(), workspaceId, { asOf })
      .then((report) => {
        if (!cancelled) setData(report);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken, asOf]);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Stock valuation
            </h2>
            {data ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Closing value:{' '}
                <span className="num-tabular font-semibold text-slate-900 dark:text-slate-100">
                  {formatMinor(data.totalClosingValueMinor)}
                </span>
              </p>
            ) : null}
          </div>
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

        {error ? (
          <div className="m-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2 p-6">
            <div className="h-9 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
            <div className="h-9 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            No stock movements recorded yet. Add item lines on purchase or sales invoices to track inventory valuation.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-5 py-3">Item</th>
                  <th className="px-5 py-3">Method</th>
                  <th className="px-5 py-3 text-right">Opening</th>
                  <th className="px-5 py-3 text-right">In</th>
                  <th className="px-5 py-3 text-right">Out</th>
                  <th className="px-5 py-3 text-right">Closing qty</th>
                  <th className="px-5 py-3 text-right">Closing value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{row.name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {row.uom}
                        {row.warnings.length > 0 ? ` · ${row.warnings[0]}` : ''}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                      {row.valuationMethod}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-slate-600 dark:text-slate-400">
                      {quantity(row.openingQuantity)}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-emerald-700 dark:text-emerald-400">
                      {quantity(row.inwardQuantity)}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-slate-700 dark:text-slate-300">
                      {quantity(row.outwardQuantity)}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                      {quantity(row.closingQuantity)}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                      {formatMinor(row.closingValueMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && data.movements.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Movement ledger
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Voucher</th>
                  <th className="px-5 py-3">Item</th>
                  <th className="px-5 py-3 text-right">In</th>
                  <th className="px-5 py-3 text-right">Out</th>
                  <th className="px-5 py-3 text-right">Cost</th>
                  <th className="px-5 py-3 text-right">Balance qty</th>
                  <th className="px-5 py-3 text-right">Balance value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.movements.map((m) => (
                  <tr key={m.itemLineId}>
                    <td className="num-tabular px-5 py-3 text-xs text-slate-600 dark:text-slate-400">
                      {m.date}
                    </td>
                    <td className="px-5 py-3">
                      <div className="num-tabular text-xs font-medium text-slate-900 dark:text-slate-100">
                        {m.voucherNumber}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{m.voucherType}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-900 dark:text-slate-100">{m.name}</td>
                    <td className="num-tabular px-5 py-3 text-right text-emerald-700 dark:text-emerald-400">
                      {m.direction === 'in' ? quantity(m.quantity) : '—'}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-slate-700 dark:text-slate-300">
                      {m.direction === 'out' ? quantity(m.quantity) : '—'}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right text-slate-700 dark:text-slate-300">
                      {m.direction === 'out' ? formatMinor(m.costMinor) : '—'}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                      {quantity(m.runningQuantity)}
                    </td>
                    <td className="num-tabular px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                      {formatMinor(m.runningValueMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
