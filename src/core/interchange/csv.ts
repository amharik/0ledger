import Papa from 'papaparse';
import type { WorkbookData } from '../template/data';
import { minorToDecimalString } from '../money/money';

function money(data: WorkbookData, minor: number): string {
  return minorToDecimalString(minor, data.company.currency);
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
        Date: voucher?.date ?? '',
        'Voucher Type': voucher?.voucherType ?? '',
        Number: voucher?.number ?? '',
        Reference: voucher?.reference ?? '',
        'Invoice No': voucher?.invoiceNumber ?? '',
        Narration: voucher?.narration ?? '',
        Ledger: ledger?.name ?? line.ledgerId,
        'Tally Group': ledger?.tallyParent ?? '',
        Debit: line.amountMinor > 0 ? money(data, line.amountMinor) : '',
        Credit: line.amountMinor < 0 ? money(data, -line.amountMinor) : '',
        Currency: line.currency,
        'Line Narration': line.narration ?? '',
        'HSN/SAC': line.hsnSac ?? '',
      };
    });
  return Papa.unparse(rows);
}

export function trialBalanceCsv(data: WorkbookData): string {
  const rows = data.trialBalance.rows.map((row) => ({
    Group: row.tallyParent,
    Ledger: row.name,
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
    Name: ledger.name,
    Group: ledger.groupId ? groups.get(ledger.groupId) ?? ledger.tallyParent : ledger.tallyParent,
    'Tally Parent': ledger.tallyParent,
    Nature: ledger.nature,
    Opening: money(data, ledger.openingBalanceMinor),
    Currency: ledger.currency,
    GSTIN: ledger.gstin ?? '',
    'Bank Account': ledger.bankAccountNo ?? '',
    IFSC: ledger.bankIfsc ?? '',
    Archived: ledger.archived ? 'Yes' : 'No',
  }));
  return Papa.unparse(rows);
}
