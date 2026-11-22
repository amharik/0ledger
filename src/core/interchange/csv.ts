import Papa from 'papaparse';
import type { WorkbookData } from '../template/data';
import { minorToDecimalString } from '../money/money';

function money(data: WorkbookData, minor: number): string {
  return minorToDecimalString(minor, data.company.currency);
}

export function csvText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function voucherLinesCsv(data: WorkbookData): string {
  const voucherById = new Map(data.vouchers.map((voucher) => [voucher.id, voucher]));
  const ledgerById = new Map(data.ledgers.map((ledger) => [ledger.id, ledger]));
  const rows = data.voucherLines
    .filter((line) => voucherById.get(line.voucherId)?.status === 'regular')
    .sort((a, b) => {
      const voucherA = voucherById.get(a.voucherId);
      const voucherB = voucherById.get(b.voucherId);
      return (
        (voucherA?.date ?? '').localeCompare(voucherB?.date ?? '') ||
        (voucherA?.number ?? '').localeCompare(voucherB?.number ?? '') ||
        a.lineNo - b.lineNo
      );
    })
    .map((line) => {
      const voucher = voucherById.get(line.voucherId);
      const ledger = ledgerById.get(line.ledgerId);
      return {
        Date: csvText(voucher?.date ?? ''),
        'Voucher Type': csvText(voucher?.voucherType ?? ''),
        Number: csvText(voucher?.number ?? ''),
        Reference: csvText(voucher?.reference ?? ''),
        'Invoice No': csvText(voucher?.invoiceNumber ?? ''),
        Narration: csvText(voucher?.narration ?? ''),
        Ledger: csvText(ledger?.name ?? line.ledgerId),
        'Tally Group': csvText(ledger?.tallyParent ?? ''),
        Debit: line.amountMinor > 0 ? money(data, line.amountMinor) : '',
        Credit: line.amountMinor < 0 ? money(data, -line.amountMinor) : '',
        Currency: line.currency,
        'Line Narration': csvText(line.narration ?? ''),
        'HSN/SAC': csvText(line.hsnSac ?? ''),
      };
    });
  return Papa.unparse(rows);
}

export function trialBalanceCsv(data: WorkbookData): string {
  const rows = data.trialBalance.rows.map((row) => ({
    Group: csvText(row.tallyParent),
    Ledger: csvText(row.name),
    Opening: money(data, row.openingMinor),
    Debit: money(data, row.debitMinor),
    Credit: money(data, row.creditMinor),
    Closing: money(data, row.closingMinor),
  }));
  rows.push({
    Group: '',
    Ledger: 'Total',
    Opening: money(data, data.trialBalance.totalOpeningMinor),
    Debit: money(data, data.trialBalance.totalDebitMinor),
    Credit: money(data, data.trialBalance.totalCreditMinor),
    Closing: money(data, 0),
  });
  return Papa.unparse(rows);
}

export function ledgersCsv(data: WorkbookData): string {
  const groups = new Map(data.groups.map((group) => [group.id, group.name]));
  const rows = data.ledgers.map((ledger) => ({
    Name: csvText(ledger.name),
    Group: csvText(ledger.groupId ? groups.get(ledger.groupId) ?? ledger.tallyParent : ledger.tallyParent),
    'Tally Parent': csvText(ledger.tallyParent),
    Nature: csvText(ledger.nature),
    Opening: money(data, ledger.openingBalanceMinor),
    Currency: ledger.currency,
    GSTIN: csvText(ledger.gstin ?? ''),
    'Bank Account': csvText(ledger.bankAccountNo ?? ''),
    IFSC: csvText(ledger.bankIfsc ?? ''),
    Archived: ledger.archived ? 'Yes' : 'No',
  }));
  return Papa.unparse(rows);
}
