import React, { useMemo, useState } from 'react';
import type {
  ColumnRole,
  IngestBatchStatusResponse,
  ParsedIngestRowDto,
  StatementSummaryDto,
} from '../core/ingest/types';
import {
  confirmColumnMapping,
  forcePostBatch,
  submitOcrAuditPatch,
} from '../core/ingest/pdf-rust';

export interface IngestPreviewModalProps {
  workspaceId: string;
  bankLedgerId: string;
  status: IngestBatchStatusResponse;
  onClose: () => void;
  onCompleted: (updated: IngestBatchStatusResponse) => void;
}

const COLUMN_ROLES: { value: ColumnRole; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'valueDate', label: 'Value Date' },
  { value: 'description', label: 'Narration / Description' },
  { value: 'debit', label: 'Debit / Withdrawal' },
  { value: 'credit', label: 'Credit / Deposit' },
  { value: 'amount', label: 'Amount (Signed / Dr-Cr)' },
  { value: 'type', label: 'Dr/Cr Indicator' },
  { value: 'balance', label: 'Running Balance' },
  { value: 'reference', label: 'UTR / Reference' },
  { value: 'ignore', label: 'Ignore' },
];

function normalizeHeaderKey(header: string, occurrence: number): string {
  const base = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return occurrence <= 1 ? base : `${base}_${occurrence}`;
}

function parseMinor(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const val = Number.parseFloat(cleaned);
  return Number.isFinite(val) ? Math.round(val * 100) : 0;
}

export const IngestPreviewModal: React.FC<IngestPreviewModalProps> = ({
  workspaceId,
  bankLedgerId,
  status,
  onClose,
  onCompleted,
}) => {
  const primaryTable = status.tables[0];
  const [institutionSlug, setInstitutionSlug] = useState(
    status.batch.institutionSlug ?? 'hdfc',
  );
  const [statementKind, setStatementKind] = useState(status.batch.statementKind || 'bank');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [summary] = useState<StatementSummaryDto>({});

  const headerKeys = useMemo(() => {
    if (!primaryTable) return [];
    const seen = new Map<string, number>();
    return primaryTable.rawHeaders.map((h) => {
      const norm = normalizeHeaderKey(h, 1);
      const count = (seen.get(norm) ?? 0) + 1;
      seen.set(norm, count);
      return normalizeHeaderKey(h, count);
    });
  }, [primaryTable]);

  const [mappings, setMappings] = useState<Record<string, ColumnRole>>(() => {
    if (status.template?.columnMappings) return status.template.columnMappings;
    const init: Record<string, ColumnRole> = {};
    headerKeys.forEach((k) => {
      init[k] = 'ignore';
    });
    return init;
  });

  const [editedCells, setEditedCells] = useState<Record<string, string>>({});

  const parsedRows: ParsedIngestRowDto[] = useMemo(() => {
    if (!primaryTable) return [];
    return primaryTable.rawRows.map((cells, rowIdx) => {
      let date = '';
      let valueDate: string | undefined;
      let description = '';
      let reference: string | undefined;
      let debitMinor = 0;
      let creditMinor = 0;
      let amountMinor = 0;
      let txType = '';
      let balanceMinor: number | undefined;

      cells.forEach((rawCell, colIdx) => {
        const cell = editedCells[`${rowIdx}:${colIdx}`] ?? rawCell;
        const headerKey = headerKeys[colIdx] ?? '';
        const role = mappings[headerKey] ?? 'ignore';
        switch (role) {
          case 'date':
            date = cell.trim();
            break;
          case 'valueDate':
            valueDate = cell.trim() || undefined;
            break;
          case 'description':
            description = cell.trim();
            break;
          case 'reference':
            reference = cell.trim() || undefined;
            break;
          case 'debit':
            debitMinor = Math.abs(parseMinor(cell));
            break;
          case 'credit':
            creditMinor = Math.abs(parseMinor(cell));
            break;
          case 'amount':
            amountMinor = parseMinor(cell);
            break;
          case 'type':
            txType = cell.trim().toLowerCase();
            break;
          case 'balance':
            if (cell.trim()) balanceMinor = parseMinor(cell);
            break;
          default:
            break;
        }
      });

      if (debitMinor === 0 && creditMinor === 0 && amountMinor !== 0) {
        if (txType.includes('cr')) creditMinor = Math.abs(amountMinor);
        else debitMinor = Math.abs(amountMinor);
      }

      return {
        rowIndex: rowIdx,
        date,
        ...(valueDate !== undefined ? { valueDate } : {}),
        description,
        ...(reference !== undefined ? { reference } : {}),
        debitMinor,
        creditMinor,
        ...(balanceMinor !== undefined ? { balanceMinor } : {}),
        narrationNorm: description.toLowerCase().replace(/\s+/g, ' ').trim(),
        dailyRank: 1,
      };
    });
  }, [primaryTable, editedCells, mappings, headerKeys]);

  const flaggedRows = useMemo(() => {
    const set = new Set<number>();
    status.discrepancies.forEach((d) => {
      if (d.rowIndex !== undefined) set.add(d.rowIndex);
    });
    return set;
  }, [status.discrepancies]);

  const handleConfirmMapping = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await confirmColumnMapping({
        workspaceId,
        batchId: status.batch.idKey,
        bankLedgerId,
        institutionSlug,
        statementKind,
        columnMappings: mappings,
        rows: parsedRows,
        summary,
      });
      onCompleted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitRepair = async () => {
    setBusy(true);
    setError(null);
    try {
      const firstEdit = Object.entries(editedCells)[0];
      const updated = await submitOcrAuditPatch({
        workspaceId,
        batchId: status.batch.idKey,
        bankLedgerId,
        statementKind,
        rows: parsedRows,
        summary,
        patch: {
          field: firstEdit ? firstEdit[0] : 'amount_minor',
          rawValue: firstEdit ? firstEdit[1] : '0',
          repairedValue: parsedRows[0]?.debitMinor || parsedRows[0]?.creditMinor || 0,
          repairType: 'ocr_digit_correction',
          actor: 'user',
          rationale: rationale || 'OCR digit repair',
        },
      });
      onCompleted(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleForcePost = async () => {
    if (!rationale.trim()) {
      setError('A documented rationale is required to force-post an unreconciled batch.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const batch = await forcePostBatch({
        workspaceId,
        batchId: status.batch.idKey,
        bankLedgerId,
        rows: parsedRows,
        forcePost: {
          actor: 'user',
          rationale: rationale.trim(),
          discrepancyMinor: status.discrepancies.reduce((acc, d) => acc + d.deltaMinor, 0),
        },
      });
      onCompleted({ ...status, batch, discrepancies: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between border-b pb-3">
          <div>
            <h2 className="text-lg font-semibold">
              Statement Review ({status.batch.state})
            </h2>
            <p className="text-xs text-neutral-500">
              Batch: {status.batch.idKey} | Skipped Overlaps: {status.batch.skippedDuplicateCount}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            Close
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-4">
          <label className="text-sm">
            Institution:
            <input
              type="text"
              value={institutionSlug}
              onChange={(e) => setInstitutionSlug(e.target.value)}
              className="ml-2 rounded border px-2 py-1 text-sm"
            />
          </label>
          <label className="text-sm">
            Statement Type:
            <select
              value={statementKind}
              onChange={(e) => setStatementKind(e.target.value)}
              className="ml-2 rounded border px-2 py-1 text-sm"
            >
              <option value="bank">Bank Account</option>
              <option value="credit_card">Credit Card</option>
              <option value="p2p">P2P / Wallet</option>
              <option value="fastag">FASTag</option>
            </select>
          </label>
        </div>

        {status.discrepancies.length > 0 && (
          <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>Reconciliation Discrepancies:</strong>
            <ul className="mt-1 list-disc pl-5">
              {status.discrepancies.map((d, idx) => (
                <li key={idx}>{d.message}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto rounded border">
          {primaryTable ? (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-neutral-100">
                <tr>
                  <th className="border p-2">#</th>
                  {primaryTable.rawHeaders.map((hdr, colIdx) => {
                    const headerKey = headerKeys[colIdx] ?? `col_${colIdx}`;
                    return (
                      <th key={colIdx} className="border p-2">
                        <div className="mb-1 font-medium">{hdr}</div>
                        <select
                          value={mappings[headerKey] ?? 'ignore'}
                          onChange={(e) =>
                            setMappings((prev) => ({
                              ...prev,
                              [headerKey]: e.target.value as ColumnRole,
                            }))
                          }
                          className="w-full rounded border bg-white px-1 py-0.5 text-xs"
                        >
                          {COLUMN_ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {primaryTable.rawRows.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className={flaggedRows.has(rowIdx) ? 'bg-red-50' : undefined}
                  >
                    <td className="border p-2 text-neutral-500">{rowIdx + 1}</td>
                    {row.map((cell, colIdx) => {
                      const key = `${rowIdx}:${colIdx}`;
                      return (
                        <td key={colIdx} className="border p-1">
                          <input
                            type="text"
                            value={editedCells[key] ?? cell}
                            onChange={(e) =>
                              setEditedCells((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            className="w-full bg-transparent px-1 py-0.5 focus:bg-white focus:outline"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-4 text-sm text-neutral-500">No extracted tables available.</div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <input
            type="text"
            placeholder="Audit rationale (required for OCR repair / force-post)"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            className="min-w-[280px] flex-1 rounded border px-3 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            {status.batch.state === 'NEEDS_MAPPING' && (
              <button
                type="button"
                disabled={busy}
                onClick={handleConfirmMapping}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Save Template & Import
              </button>
            )}
            {status.batch.state === 'SCRUTINY_REQUIRED' && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSubmitRepair}
                  className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Submit OCR Repair
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleForcePost}
                  className="rounded bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  Force-Post to Suspense
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

