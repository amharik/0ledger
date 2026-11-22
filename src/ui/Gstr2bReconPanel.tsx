import { useEffect, useState, type ChangeEvent } from 'react';
import { Check, Copy, Download, Upload } from 'lucide-react';
import Papa from 'papaparse';
import { getDb } from '@/core/db/db';
import { formatMinor } from '@/core/money/money';
import {
  parseGstr2bCsv,
  parseGstr2bJson,
  type Gstr2bRecord,
  type Gstr2bReconItem,
  type Gstr2bSummary,
  type ReconMatchStatus,
} from '@/core/gst/gstr2b';
import { executeGstr2bReconciliation } from '@/core/gst/gstr2b-service';

interface Props {
  workspaceId: string;
  period?: string;
  refreshToken?: number;
  onNotice?: (message: string) => void;
}

function statusLabel(status: ReconMatchStatus): { label: string; colorClass: string } {
  switch (status) {
    case 'matched':
      return { label: 'Matched', colorClass: 'text-emerald-700 dark:text-emerald-400' };
    case 'missing_in_2b':
      return { label: 'Missing in 2B', colorClass: 'text-red-700 dark:text-red-400' };
    case 'missing_in_books':
      return { label: 'Missing in books', colorClass: 'text-amber-700 dark:text-amber-400' };
    case 'tax_mismatch':
      return { label: 'Tax mismatch', colorClass: 'text-amber-700 dark:text-amber-400' };
    default:
      return {
        label: String(status).replace(/_/g, ' '),
        colorClass: 'text-slate-600 dark:text-slate-400',
      };
  }
}

export function Gstr2bReconPanel({
  workspaceId,
  period = new Date().toISOString().slice(0, 7),
  refreshToken = 0,
  onNotice,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [records, setRecords] = useState<Gstr2bRecord[]>([]);
  const [reconItems, setReconItems] = useState<Gstr2bReconItem[]>([]);
  const [summary, setSummary] = useState<Gstr2bSummary>();
  const [filter, setFilter] = useState<ReconMatchStatus | 'all'>('all');
  const [copiedId, setCopiedId] = useState<string>();

  useEffect(() => {
    if (records.length === 0) return;
    void runRecon(records);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, period, refreshToken]);

  async function runRecon(g2bRecords: Gstr2bRecord[]) {
    setLoading(true);
    setError(undefined);
    try {
      const res = await executeGstr2bReconciliation(getDb(), workspaceId, period, g2bRecords);
      setReconItems(res.items);
      setSummary(res.summary);
      onNotice?.(`Reconciled ${res.items.length} invoices (${res.summary.matchedCount} matched)`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(undefined);
    setLoading(true);
    try {
      const text = await file.text();
      const parsed =
        file.name.endsWith('.json') || text.trim().startsWith('{')
          ? parseGstr2bJson(text)
          : parseGstr2bCsv(text);
      if (parsed.length === 0) {
        throw new Error('No valid GSTR-2B invoice records found in this file.');
      }
      setRecords(parsed);
      await runRecon(parsed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  }

  function copyFollowup(item: Gstr2bReconItem) {
    if (!item.vendorFollowupText) return;
    void navigator.clipboard.writeText(item.vendorFollowupText);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(undefined), 2500);
    onNotice?.(`Copied reminder message for ${item.supplierName}`);
  }

  function exportReconCsv() {
    if (reconItems.length === 0) return;
    const rows = reconItems.map((item) => ({
      Status: item.status.toUpperCase(),
      'Supplier GSTIN': item.supplierGstin,
      'Supplier Name': item.supplierName,
      'Invoice Number': item.invoiceNumber,
      'Invoice Date': item.invoiceDate,
      '2B Amount': item.gstr2bAmountMinor ? (item.gstr2bAmountMinor / 100).toFixed(2) : '',
      '2B Tax (ITC)': item.gstr2bTaxMinor ? (item.gstr2bTaxMinor / 100).toFixed(2) : '',
      'Books Amount': item.booksAmountMinor ? (item.booksAmountMinor / 100).toFixed(2) : '',
      'Books Tax': item.booksTaxMinor ? (item.booksTaxMinor / 100).toFixed(2) : '',
      'Discrepancy Note': item.discrepancyNote ?? '',
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `GSTR-2B-Reconciliation-${period}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const filteredItems = reconItems.filter((item) => filter === 'all' || item.status === filter);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              GSTR-2B Input Tax Credit reconciliation
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Match GST Portal GSTR-2B JSON or CSV against your purchase register to protect claimable ITC.
            </p>
          </div>
          {reconItems.length > 0 ? (
            <button
              type="button"
              onClick={exportReconCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-6 py-7 text-center transition-colors hover:border-blue-500 hover:bg-blue-50/30 dark:border-slate-700 dark:bg-slate-950/60 dark:hover:border-blue-500">
          <Upload className="h-5 w-5 text-slate-400" />
          <span className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
            {loading ? 'Reconciling invoices…' : 'Upload GSTR-2B file (JSON or CSV)'}
          </span>
          <span className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Download from GST Portal under Services → Returns → GSTR-2B
          </span>
          <input
            type="file"
            className="hidden"
            accept=".json,.csv,.txt"
            onChange={handleFileUpload}
            disabled={loading}
          />
        </label>
      </section>

      {summary ? (
        <section className="grid grid-cols-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:grid-cols-4 sm:divide-x sm:divide-y-0 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          <div className="p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Total 2B ITC</div>
            <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
              {formatMinor(summary.totalItcAvailableMinor)}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Claimable (matched)</div>
            <div className="num-tabular mt-1.5 text-xl font-semibold text-emerald-700 dark:text-emerald-400">
              {formatMinor(summary.claimedItcMinor)}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">At risk (missing in 2B)</div>
            <div
              className={`num-tabular mt-1.5 text-xl font-semibold ${
                summary.itcAtRiskMinor > 0
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {formatMinor(summary.itcAtRiskMinor)}
            </div>
          </div>
          <div className="p-5">
            <div className="text-xs text-slate-500 dark:text-slate-400">Unbooked invoices</div>
            <div className="num-tabular mt-1.5 text-xl font-semibold text-slate-900 dark:text-slate-100">
              {summary.missingInBooksCount}
            </div>
          </div>
        </section>
      ) : null}

      {reconItems.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/80">
            {(
              [
                { id: 'all', label: `All (${reconItems.length})` },
                { id: 'missing_in_2b', label: `Missing in 2B (${summary?.missingIn2bCount ?? 0})` },
                { id: 'missing_in_books', label: `Missing in books (${summary?.missingInBooksCount ?? 0})` },
                { id: 'tax_mismatch', label: `Mismatch (${summary?.taxMismatchCount ?? 0})` },
                { id: 'matched', label: `Matched (${summary?.matchedCount ?? 0})` },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  filter === item.id
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Supplier</th>
                    <th className="px-4 py-3">Invoice</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">2B amount</th>
                    <th className="px-4 py-3 text-right">Books amount</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredItems.map((item) => {
                    const meta = statusLabel(item.status);
                    return (
                      <tr key={item.id}>
                        <td className={`whitespace-nowrap px-4 py-3 text-xs font-medium ${meta.colorClass}`}>
                          {meta.label}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {item.supplierName}
                          </div>
                          <div className="num-tabular text-xs text-slate-500 dark:text-slate-400">
                            {item.supplierGstin}
                          </div>
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-xs text-slate-700 dark:text-slate-300">
                          {item.invoiceNumber}
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                          {item.invoiceDate}
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-right text-xs text-slate-900 dark:text-slate-100">
                          {item.gstr2bAmountMinor ? formatMinor(item.gstr2bAmountMinor) : '—'}
                        </td>
                        <td className="num-tabular whitespace-nowrap px-4 py-3 text-right text-xs text-slate-900 dark:text-slate-100">
                          {item.booksAmountMinor ? formatMinor(item.booksAmountMinor) : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-xs">
                          {item.status === 'missing_in_2b' && item.vendorFollowupText ? (
                            <button
                              type="button"
                              onClick={() => copyFollowup(item)}
                              className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline dark:text-blue-400"
                            >
                              {copiedId === item.id ? (
                                <>
                                  <Check className="h-3.5 w-3.5" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy reminder
                                </>
                              )}
                            </button>
                          ) : item.status === 'missing_in_books' ? (
                            <span className="text-slate-500">Record purchase bill</span>
                          ) : (
                            <span className="text-emerald-700 dark:text-emerald-400">ITC safe</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
