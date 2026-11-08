import { useCallback, useEffect, useState } from 'react';
import { getDb } from '@/core/db/db';
import {
  exportBeancount,
  exportOfx,
  exportTallyMasters,
  exportTallyVouchers,
  importBeancount,
  importTallyXml,
  ledgersCsv,
  trialBalanceCsv,
  voucherLinesCsv,
} from '@/core/interchange';
import { checkTallyReadiness } from '@/core/ledger/validation';
import { loadWorkbookData, type WorkbookData } from '@/core/template';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function download(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || '0ledger';
}

export default function InterchangePanel({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<WorkbookData>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<string[]>([]);
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [beancountFile, setBeancountFile] = useState<File>();
  const [tallyFile, setTallyFile] = useState<File>();

  const refresh = useCallback(async () => {
    const next = await loadWorkbookData(getDb(), workspaceId);
    setData(next);
    const banks = next.ledgers.filter((ledger) => ledger.isBank);
    setBankLedgerId((current) =>
      banks.some((ledger) => ledger.id === current) ? current : banks[0]?.id ?? '',
    );
  }, [workspaceId]);

  useEffect(() => {
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  async function run(action: (current: WorkbookData) => Promise<void> | void) {
    if (!data) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setIssues([]);
    try {
      await action(data);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function exportFile(
    extension: string,
    mime: string,
    label: string,
    build: (current: WorkbookData) => string,
  ) {
    void run((current) => {
      download(`${safeFilename(current.workspace.slug)}-${label}.${extension}`, build(current), mime);
      setNotice(`Downloaded ${label}.${extension}.`);
    });
  }

  function checkReadiness() {
    void run((current) => {
      const vouchers = current.vouchers.filter((voucher) => voucher.status === 'regular');
      const ids = new Set(vouchers.map((voucher) => voucher.id));
      const result = checkTallyReadiness({
        company: current.company,
        ledgers: current.ledgers,
        parties: current.parties,
        stockItems: current.stockItems,
        vouchers,
        lines: current.voucherLines.filter((line) => ids.has(line.voucherId)),
        billAllocations: current.billAllocations.filter((item) => ids.has(item.voucherId)),
        taxAllocations: current.taxAllocations.filter((item) => ids.has(item.voucherId)),
        numberingSchemes: current.numberingSchemes,
        fyStartMonth: current.company.settings.fyStartMonth,
      });
      setIssues(
        result.issues.slice(0, 25).map((issue) => `${issue.severity.toUpperCase()}: ${issue.message}`),
      );
      setNotice(
        result.ok
          ? `Tally readiness passed with ${result.issues.length} warning(s).`
          : `Tally readiness found ${result.issues.filter((issue) => issue.severity === 'error').length} error(s).`,
      );
    });
  }

  async function importBeancountFile() {
    if (!beancountFile) {
      setError('Choose a Beancount file first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const text = await beancountFile.text();
      const result = await importBeancount(getDb(), workspaceId, text);
      setIssues(result.errors.map((item) => `Line ${item.line}: ${item.message}`));
      setNotice(
        `Imported ${result.imported} Beancount transaction(s), skipped ${result.skipped}.` +
          (result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : ''),
      );
      setBeancountFile(undefined);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importTallyFile() {
    if (!tallyFile) {
      setError('Choose a Tally XML file first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const xml = await tallyFile.text();
      const result = await importTallyXml(getDb(), workspaceId, xml);
      setIssues(result.errors.map((item) => `${item.voucher ?? 'Voucher'}: ${item.message}`));
      setNotice(
        `Imported ${result.imported} Tally voucher(s), skipped ${result.skipped}. ` +
          `${result.masters.ledgers} ledger(s), ${result.masters.stockItems} stock item(s) added.`,
      );
      setTallyFile(undefined);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="muted">Loading interchange data…</p>;
  const banks = data.ledgers.filter((ledger) => ledger.isBank);

  return (
    <div className="interchange-panel">
      {error ? <div className="alert danger">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={`${index}-${issue}`}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <h3>Export</h3>
      <div className="interchange-actions">
        <button className="ghost" disabled={busy} onClick={() => exportFile('csv', 'text/csv', 'voucher-lines', voucherLinesCsv)}>
          Voucher lines CSV
        </button>
        <button className="ghost" disabled={busy} onClick={() => exportFile('csv', 'text/csv', 'trial-balance', trialBalanceCsv)}>
          Trial balance CSV
        </button>
        <button className="ghost" disabled={busy} onClick={() => exportFile('csv', 'text/csv', 'ledgers', ledgersCsv)}>
          Ledgers CSV
        </button>
        <button className="ghost" disabled={busy} onClick={() => exportFile('beancount', 'text/plain', 'books', (current) => exportBeancount(current))}>
          Beancount
        </button>
        <button className="ghost" disabled={busy} onClick={() => exportFile('xml', 'application/xml', 'tally-masters', (current) => exportTallyMasters(current, { allowIncomplete }))}>
          Tally masters XML
        </button>
        <button className="ghost" disabled={busy} onClick={() => exportFile('xml', 'application/xml', 'tally-vouchers', (current) => exportTallyVouchers(current, { allowIncomplete }))}>
          Tally vouchers XML
        </button>
      </div>

      <div className="interchange-actions">
        <label className="inline-field">
          <span>OFX bank ledger</span>
          <select value={bankLedgerId} onChange={(event) => setBankLedgerId(event.target.value)}>
            {banks.length === 0 ? <option value="">No bank ledger</option> : null}
            {banks.map((ledger) => (
              <option key={ledger.id} value={ledger.id}>{ledger.name}</option>
            ))}
          </select>
        </label>
        <button
          className="ghost"
          disabled={busy || !bankLedgerId}
          onClick={() => exportFile('ofx', 'application/x-ofx', 'statement', (current) => exportOfx(current, { bankLedgerId }))}
        >
          OFX statement
        </button>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowIncomplete}
          onChange={(event) => setAllowIncomplete(event.target.checked)}
        />
        <span>Allow Tally export even when readiness checks fail (may lose Tally-specific data).</span>
      </label>
      <button className="ghost" disabled={busy} onClick={checkReadiness}>Check Tally readiness</button>

      <h3>Import</h3>
      <div className="interchange-import">
        <label>
          <span>Beancount file</span>
          <input type="file" accept=".beancount,.bean,.txt,text/plain" onChange={(event) => setBeancountFile(event.target.files?.[0])} />
        </label>
        <button disabled={busy || !beancountFile} onClick={() => void importBeancountFile()}>
          Import Beancount
        </button>
      </div>
      <div className="interchange-import">
        <label>
          <span>Tally XML file</span>
          <input type="file" accept=".xml,application/xml,text/xml" onChange={(event) => setTallyFile(event.target.files?.[0])} />
        </label>
        <button disabled={busy || !tallyFile} onClick={() => void importTallyFile()}>
          Import Tally XML
        </button>
      </div>
    </div>
  );
}
