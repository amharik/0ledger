import { useEffect, useState, type ChangeEvent } from 'react';
import { getDb } from '@/core/db/db';
import { formatMinor } from '@/core/money/money';
import {
  parseGstr2bJson,
  parseGstr2bCsv,
  type Gstr2bRecord,
  type Gstr2bReconItem,
  type Gstr2bSummary,
  type ReconMatchStatus,
} from '@/core/gst/gstr2b';
import { executeGstr2bReconciliation } from '@/core/gst/gstr2b-service';
import Papa from 'papaparse';

interface Props {
  workspaceId: string;
  period?: string;
  refreshToken?: number;
  onNotice?: (message: string) => void;
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
  }, [workspaceId, period, refreshToken]);

  async function runRecon(g2bRecords: Gstr2bRecord[]) {
    setLoading(true);
    setError(undefined);
    try {
      const db = getDb();
      const res = await executeGstr2bReconciliation(db, workspaceId, period, g2bRecords);
      setReconItems(res.items);
      setSummary(res.summary);
      onNotice?.(`Reconciled ${res.items.length} items (${res.summary.matchedCount} matched).`);
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
      let parsed: Gstr2bRecord[] = [];

      if (file.name.endsWith('.json') || text.trim().startsWith('{')) {
        parsed = parseGstr2bJson(text);
      } else {
        parsed = parseGstr2bCsv(text);
      }

      if (parsed.length === 0) {
        throw new Error('No valid GSTR-2B invoice records found in file.');
      }

      setRecords(parsed);
      await runRecon(parsed);
      onNotice?.(`Loaded ${parsed.length} records from ${file.name}`);
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
    onNotice?.(`Copied vendor reminder for ${item.supplierName}`);
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
    <section className="card gstr2b-panel">
      <div className="section-head">
        <div>
          <h2>GSTR-2B Reconciliation (Input Tax Credit)</h2>
          <span className="muted small">Match GST portal data with your purchase ledger</span>
        </div>
        <div className="head-actions">
          {reconItems.length > 0 ? (
            <button type="button" className="ghost" onClick={exportReconCsv}>
              Export CSV
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="alert danger">{error}</div> : null}

      <div className="upload-box">
        <label className="file-dropzone">
          <input
            type="file"
            accept=".json,.csv,.txt"
            onChange={handleFileUpload}
            disabled={loading}
          />
          <div className="dropzone-text">
            <strong>Upload GSTR-2B (JSON or CSV)</strong>
            <span className="muted small">
              Download from GST Portal (Services → Returns → GSTR-2B)
            </span>
          </div>
        </label>
      </div>

      {summary ? (
        <div className="stats" style={{ marginTop: '1rem' }}>
          <div>
            <span className="muted small">Total 2B ITC</span>
            <strong>{formatMinor(summary.totalItcAvailableMinor)}</strong>
          </div>
          <div>
            <span className="muted small">Claimable (Matched)</span>
            <strong className="positive">{formatMinor(summary.claimedItcMinor)}</strong>
          </div>
          <div>
            <span className="muted small">At Risk (Missing in 2B)</span>
            <strong className={summary.itcAtRiskMinor > 0 ? 'negative' : 'positive'}>
              {formatMinor(summary.itcAtRiskMinor)}
            </strong>
          </div>
          <div>
            <span className="muted small">Unbooked Invoices</span>
            <strong className="negative">{summary.missingInBooksCount}</strong>
          </div>
        </div>
      ) : null}

      {reconItems.length > 0 ? (
        <>
          <div className="filter-chips" style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0' }}>
            <button
              type="button"
              className={filter === 'all' ? 'chip active' : 'chip'}
              onClick={() => setFilter('all')}
            >
              All ({reconItems.length})
            </button>
            <button
              type="button"
              className={filter === 'missing_in_2b' ? 'chip active' : 'chip'}
              onClick={() => setFilter('missing_in_2b')}
            >
              Missing in 2B ({summary?.missingIn2bCount})
            </button>
            <button
              type="button"
              className={filter === 'missing_in_books' ? 'chip active' : 'chip'}
              onClick={() => setFilter('missing_in_books')}
            >
              Missing in Books ({summary?.missingInBooksCount})
            </button>
            <button
              type="button"
              className={filter === 'tax_mismatch' ? 'chip active' : 'chip'}
              onClick={() => setFilter('tax_mismatch')}
            >
              Mismatch ({summary?.taxMismatchCount})
            </button>
            <button
              type="button"
              className={filter === 'matched' ? 'chip active' : 'chip'}
              onClick={() => setFilter('matched')}
            >
              Matched ({summary?.matchedCount})
            </button>
          </div>

          <div className="recon-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Supplier</th>
                  <th>Invoice #</th>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>2B Amount</th>
                  <th style={{ textAlign: 'right' }}>Books Amount</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className={`status-pill status-${item.status}`}>
                        {item.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td>
                      <div>
                        <strong>{item.supplierName}</strong>
                        <div className="muted small">{item.supplierGstin}</div>
                      </div>
                    </td>
                    <td>{item.invoiceNumber}</td>
                    <td>{item.invoiceDate}</td>
                    <td style={{ textAlign: 'right' }}>
                      {item.gstr2bAmountMinor ? formatMinor(item.gstr2bAmountMinor) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {item.booksAmountMinor ? formatMinor(item.booksAmountMinor) : '—'}
                    </td>
                    <td>
                      {item.status === 'missing_in_2b' && item.vendorFollowupText ? (
                        <button
                          type="button"
                          className="ghost small-button"
                          onClick={() => copyFollowup(item)}
                        >
                          {copiedId === item.id ? 'Copied ✓' : 'Copy WhatsApp Reminder'}
                        </button>
                      ) : null}
                      {item.status === 'missing_in_books' ? (
                        <span className="muted small">Needs voucher</span>
                      ) : null}
                      {item.status === 'matched' ? (
                        <span className="positive small">ITC Safe ✓</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
