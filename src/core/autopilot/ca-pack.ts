import Papa from 'papaparse';
import { monthKey, newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import { compact } from '../util/objects';
import { sha256Hex } from '../util/hash';
import { minorToDecimalString } from '../money/money';
import {
  CaPackSchema,
  type CaPack,
  type CaPackFile,
  type CaPackManifest,
  type CaPackQuestion,
} from '../model';
import type { LedgerDatabase } from '../db/db';
import { loadWorkbookData, type WorkbookData } from '../template/data';
import { exportTallyXml } from '../interchange/tally-export';
import { csvText } from '../interchange/csv';
import { buildCloseCockpit, periodBounds } from './close';

export interface CaPackFileContent {
  name: string;
  mimeType: string;
  content: string;
}

export interface GeneratedCaPack {
  pack: CaPack;
  files: CaPackFileContent[];
}

function inPeriod(date: string, period: string): boolean {
  return monthKey(date) === period;
}

function periodWorkbook(data: WorkbookData, period: string): WorkbookData {
  const vouchers = data.vouchers.filter(
    (voucher) => voucher.status === 'regular' && inPeriod(voucher.date, period),
  );
  const ids = new Set(vouchers.map((voucher) => voucher.id));
  return {
    ...data,
    vouchers,
    voucherLines: data.voucherLines.filter((line) => ids.has(line.voucherId)),
    itemLines: data.itemLines.filter((line) => ids.has(line.voucherId)),
    billAllocations: data.billAllocations.filter((row) => ids.has(row.voucherId)),
    costCenterAllocations: data.costCenterAllocations.filter((row) => ids.has(row.voucherId)),
    taxAllocations: data.taxAllocations.filter((row) => ids.has(row.voucherId)),
    statementLines: data.statementLines.filter((line) => inPeriod(line.date, period)),
    reconciliations: data.reconciliations.filter((row) => {
      return data.statementLines.some(
        (line) => line.id === row.statementLineId && inPeriod(line.date, period),
      );
    }),
  };
}

function money(data: WorkbookData, minor: number): string {
  return minorToDecimalString(minor, data.company.currency);
}

function trialBalanceAsOf(data: WorkbookData, to: string): string {
  const vouchers = data.vouchers.filter(
    (voucher) => voucher.status === 'regular' && voucher.date <= to,
  );
  const ids = new Set(vouchers.map((voucher) => voucher.id));
  const sums = new Map<string, { debit: number; credit: number }>();
  for (const line of data.voucherLines) {
    if (!ids.has(line.voucherId)) continue;
    const entry = sums.get(line.ledgerId) ?? { debit: 0, credit: 0 };
    if (line.amountMinor >= 0) entry.debit += line.amountMinor;
    else entry.credit += -line.amountMinor;
    sums.set(line.ledgerId, entry);
  }
  const rows = data.ledgers
    .map((ledger) => {
      const entry = sums.get(ledger.id) ?? { debit: 0, credit: 0 };
      return {
        Group: csvText(ledger.tallyParent),
        Ledger: csvText(ledger.name),
        Opening: money(data, ledger.openingBalanceMinor),
        Debit: money(data, entry.debit),
        Credit: money(data, entry.credit),
        Closing: money(data, ledger.openingBalanceMinor + entry.debit - entry.credit),
      };
    })
    .filter((row) => row.Opening !== '0.00' || row.Debit !== '0.00' || row.Credit !== '0.00');
  const totalOpening = data.ledgers.reduce((sum, ledger) => sum + ledger.openingBalanceMinor, 0);
  const totalDebit = [...sums.values()].reduce((sum, entry) => sum + entry.debit, 0);
  const totalCredit = [...sums.values()].reduce((sum, entry) => sum + entry.credit, 0);
  rows.push({
    Group: '',
    Ledger: 'Total',
    Opening: money(data, totalOpening),
    Debit: money(data, totalDebit),
    Credit: money(data, totalCredit),
    Closing: money(data, totalOpening + totalDebit - totalCredit),
  });
  return Papa.unparse(rows);
}

function partyOutstandingAsOf(data: WorkbookData, to: string): string {
  const vouchers = data.vouchers.filter(
    (voucher) => voucher.status === 'regular' && voucher.date <= to,
  );
  const ids = new Set(vouchers.map((voucher) => voucher.id));
  const sums = new Map<string, number>();
  for (const line of data.voucherLines) {
    if (!ids.has(line.voucherId)) continue;
    sums.set(line.ledgerId, (sums.get(line.ledgerId) ?? 0) + line.amountMinor);
  }
  const billCounts = new Map<string, number>();
  for (const bill of data.billAllocations) {
    if (!ids.has(bill.voucherId)) continue;
    billCounts.set(bill.ledgerId, (billCounts.get(bill.ledgerId) ?? 0) + 1);
  }
  const rows = data.ledgers
    .filter((ledger) => ledger.isParty)
    .map((ledger) => {
      const balance = (ledger.openingBalanceMinor + (sums.get(ledger.id) ?? 0));
      return {
        Party: csvText(ledger.name),
        Type: ledger.tallyParent === 'Sundry Debtors' ? 'Debtor' : 'Creditor',
        Balance: money(data, Math.abs(balance)),
        'Open bills': String(billCounts.get(ledger.id) ?? 0),
      };
    })
    .filter((row) => row.Balance !== '0.00')
    .sort((a, b) => b.Balance.localeCompare(a.Balance));
  return Papa.unparse(rows);
}

function closingItemsCsv(
  items: Array<{
    type: string;
    status: string;
    owner: string;
    title: string;
    evidence?: string | undefined;
    note?: string | undefined;
    amountMinor?: number | undefined;
  }>,
  data: WorkbookData,
): string {
  return Papa.unparse(
    items.map((item) => ({
      Type: csvText(item.type),
      Status: csvText(item.status),
      Owner: csvText(item.owner),
      Item: csvText(item.title),
      Amount: item.amountMinor === undefined ? '' : money(data, item.amountMinor),
      Evidence: csvText(item.evidence ?? ''),
      Note: csvText(item.note ?? ''),
    })),
  );
}

function taxCsv(
  entries: Array<{ taxType: string; ledgerName: string; amountMinor: number; taxableValueMinor: number }>,
  data: WorkbookData,
): string {
  return Papa.unparse(
    entries.map((entry) => ({
      'Tax Type': csvText(entry.taxType),
      Ledger: csvText(entry.ledgerName),
      Amount: money(data, entry.amountMinor),
      'Taxable Value': money(data, entry.taxableValueMinor),
    })),
  );
}

function fileHash(content: string): Promise<string> {
  return sha256Hex(content);
}

export async function generateCaPack(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
): Promise<GeneratedCaPack> {
  const bounds = periodBounds(period);
  const cockpit = await buildCloseCockpit(db, workspaceId, period);
  const fullData = await loadWorkbookData(db, workspaceId);
  const data = periodWorkbook(fullData, period);
  const generatedAt = nowIso();
  const statements = data.statementLines;

  const contents: CaPackFileContent[] = [
    {
      name: 'tally.xml',
      mimeType: 'application/xml',
      content: exportTallyXml(data, { allowIncomplete: true }),
    },
    {
      name: 'voucher-lines.csv',
      mimeType: 'text/csv',
      content: Papa.unparse(
        data.vouchers.flatMap((voucher) => {
          const lines = data.voucherLines.filter((line) => line.voucherId === voucher.id);
          return lines.map((line) => {
            const ledger = data.ledgers.find((candidate) => candidate.id === line.ledgerId);
            return {
              Date: voucher.date,
              'Voucher Type': voucher.voucherType,
              Number: voucher.number,
              Reference: csvText(voucher.reference ?? ''),
              Narration: csvText(voucher.narration ?? ''),
              Ledger: csvText(ledger?.name ?? line.ledgerId),
              Debit: line.amountMinor > 0 ? money(data, line.amountMinor) : '',
              Credit: line.amountMinor < 0 ? money(data, -line.amountMinor) : '',
              Currency: line.currency,
            };
          });
        }),
      ),
    },
    {
      name: 'trial-balance.csv',
      mimeType: 'text/csv',
      content: trialBalanceAsOf(fullData, bounds.to),
    },
    {
      name: 'party-outstanding.csv',
      mimeType: 'text/csv',
      content: partyOutstandingAsOf(fullData, bounds.to),
    },
    {
      name: 'captured-tax.csv',
      mimeType: 'text/csv',
      content: taxCsv(cockpit.tax.entries, data),
    },
    {
      name: 'closing-items.csv',
      mimeType: 'text/csv',
      content: closingItemsCsv(cockpit.items, data),
    },
    {
      name: 'open-items.csv',
      mimeType: 'text/csv',
      content: closingItemsCsv(
        cockpit.items.filter((item) => item.status === 'open' || item.status === 'asked_ca'),
        data,
      ),
    },
    {
      name: 'questions-for-ca.csv',
      mimeType: 'text/csv',
      content: closingItemsCsv(
        cockpit.items.filter((item) => item.status === 'asked_ca'),
        data,
      ),
    },
    {
      name: 'statements.csv',
      mimeType: 'text/csv',
      content: Papa.unparse(
        statements.map((line) => ({
          Date: line.date,
          Description: csvText(line.description),
          Reference: csvText(line.reference ?? ''),
          Debit: line.debitMinor > 0 ? money(data, line.debitMinor) : '',
          Credit: line.creditMinor > 0 ? money(data, line.creditMinor) : '',
          Balance: line.balanceMinor === undefined ? '' : money(data, line.balanceMinor),
        })),
      ),
    },
  ];

  const files: CaPackFile[] = [];
  for (const file of contents) {
    const content = file.content;
    files.push({ name: file.name, sha256: await fileHash(content), bytes: new TextEncoder().encode(content).length });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  const moneyEvents = await db.moneyEvents.where('workspaceId').equals(workspaceId).toArray();
  const manifest: CaPackManifest = {
    schemaVersion: 1,
    period,
    generatedAt,
    voucherCount: data.vouchers.length,
    statementLineCount: data.statementLines.length,
    moneyEventCount: moneyEvents.filter((event) => inPeriod(event.date, period)).length,
    closeItemCount: cockpit.items.length,
    files,
  };
  const questionsForCa: CaPackQuestion[] = cockpit.items
    .filter((item) => item.status === 'asked_ca')
    .map((item) =>
      compact({
        closeItemId: item.id,
        title: item.title,
        note: item.note,
        evidence: item.evidence,
      }) as CaPackQuestion,
    );
  const bundle = JSON.stringify(
    {
      manifest,
      questionsForCa,
      files: Object.fromEntries(contents.map((file) => [file.name, file.content])),
    },
    null,
    2,
  );
  const bundleFile: CaPackFileContent = {
    name: 'ca-pack.json',
    mimeType: 'application/json',
    content: bundle,
  };
  const contentHash = await sha256Hex(bundle);

  const pack = CaPackSchema.parse(
    compact({
      id: newId('cap'),
      workspaceId,
      period,
      generatedAt,
      manifest,
      voucherIds: data.vouchers.map((voucher) => voucher.id).sort(),
      readiness: cockpit.readiness.score,
      readinessStatus: cockpit.readiness.status,
      missingItems: cockpit.items
        .filter((item) => item.status === 'open' || item.status === 'asked_ca')
        .map((item) => item.title),
      questionsForCa,
      contentHash,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    }),
  );
  await db.caPacks.add(pack);
  await markDriveDirty(db, workspaceId);
  return { pack, files: [...contents, bundleFile] };
}

export async function listCaPacks(
  db: LedgerDatabase,
  workspaceId: string,
  period?: string,
): Promise<CaPack[]> {
  const packs = await db.caPacks.where('workspaceId').equals(workspaceId).toArray();
  return packs
    .filter((pack) => !period || pack.period === period)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
