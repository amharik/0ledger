import Papa from 'papaparse';
import type { WorkbookData } from '../template/data';
import { minorToDecimalString } from '../money/money';

function money(data: WorkbookData, minor: number): string {
  return minorToDecimalString(minor, data.company.currency);
}

function text(value: string): string {
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
        Date: text(voucher?.date ?? ''),
        'Voucher Type': text(voucher?.voucherType ?? ''),
        Number: text(voucher?.number ?? ''),
        Reference: text(voucher?.reference ?? ''),
        'Invoice No': text(voucher?.invoiceNumber ?? ''),
        Narration: text(voucher?.narration ?? ''),
        Ledger: text(ledger?.name ?? line.ledgerId),
        'Tally Group': text(ledger?.tallyParent ?? ''),
        Debit: line.amountMinor > 0 ? money(data, line.amountMinor) : '',
        Credit: line.amountMinor < 0 ? money(data, -line.amountMinor) : '',
        Currency: line.currency,
        'Line Narration': text(line.narration ?? ''),
        'HSN/SAC': text(line.hsnSac ?? ''),
      };
    });
  return Papa.unparse(rows);
}

export function trialBalanceCsv(data: WorkbookData): string {
  const rows = data.trialBalance.rows.map((row) => ({
    Group: text(row.tallyParent),
    Ledger: text(row.name),
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
    Name: text(ledger.name),
    Group: text(ledger.groupId ? groups.get(ledger.groupId) ?? ledger.tallyParent : ledger.tallyParent),
    'Tally Parent': text(ledger.tallyParent),
    Nature: text(ledger.nature),
    Opening: money(data, ledger.openingBalanceMinor),
    Currency: ledger.currency,
    GSTIN: text(ledger.gstin ?? ''),
    'Bank Account': text(ledger.bankAccountNo ?? ''),
    IFSC: text(ledger.bankIfsc ?? ''),
    Archived: ledger.archived ? 'Yes' : 'No',
  }));
  return Papa.unparse(rows);
}
