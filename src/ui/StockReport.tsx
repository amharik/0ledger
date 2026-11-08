import { useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import { stockReport, type StockReport as StockReportData } from '@/core/inventory';
import { formatMinor } from '@/core/money/money';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function quantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
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
    <section className="card">
      <div className="section-head">
        <h2>Stock</h2>
        <label className="inline-field">
          <span className="muted small">As of</span>
          <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
        </label>
      </div>

      {error ? <div className="alert danger">{error}</div> : null}
      {loading ? <p className="muted">Valuing stock…</p> : null}

      {!loading && data ? (
        data.rows.length === 0 ? (
          <p className="muted">No stock movements yet. Add item lines to purchase or sales vouchers.</p>
        ) : (
          <>
            <div className="stock-total">
              <span className="muted small">Closing stock value</span>
              <strong>{formatMinor(data.totalClosingValueMinor)}</strong>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Method</th>
                    <th className="num">Opening</th>
                    <th className="num">In</th>
                    <th className="num">Out</th>
                    <th className="num">Closing qty</th>
                    <th className="num">Closing value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        {row.name}
                        <div className="muted small">
                          {row.uom}
                          {row.warnings.length > 0 ? ` · ${row.warnings[0]}` : ''}
                        </div>
                      </td>
                      <td>{row.valuationMethod}</td>
                      <td className="num">{quantity(row.openingQuantity)}</td>
                      <td className="num">{quantity(row.inwardQuantity)}</td>
                      <td className="num">{quantity(row.outwardQuantity)}</td>
                      <td className="num">{quantity(row.closingQuantity)}</td>
                      <td className="num">{formatMinor(row.closingValueMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Movement ledger</h3>
            {data.movements.length === 0 ? (
              <p className="muted">No movements up to this date.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Voucher</th>
                      <th>Item</th>
                      <th className="num">In</th>
                      <th className="num">Out</th>
                      <th className="num">Cost</th>
                      <th className="num">Balance qty</th>
                      <th className="num">Balance value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.movements.map((movement) => (
                      <tr key={movement.itemLineId}>
                        <td>{movement.date}</td>
                        <td>
                          {movement.voucherNumber}
                          <div className="muted small">{movement.voucherType}</div>
                        </td>
                        <td>{movement.name}</td>
                        <td className="num">{movement.direction === 'in' ? quantity(movement.quantity) : ''}</td>
                        <td className="num">{movement.direction === 'out' ? quantity(movement.quantity) : ''}</td>
                        <td className="num">
                          {movement.direction === 'out' ? formatMinor(movement.costMinor) : ''}
                        </td>
                        <td className="num">{quantity(movement.runningQuantity)}</td>
                        <td className="num">{formatMinor(movement.runningValueMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      ) : null}
    </section>
  );
}
