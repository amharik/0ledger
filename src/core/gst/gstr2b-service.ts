import type { LedgerDatabase } from '../db/db';
import { monthKey } from '../ids';
import {
  reconcileGstr2bWithBooks,
  type BookPurchase,
  type Gstr2bRecord,
  type Gstr2bReconItem,
  type Gstr2bSummary,
} from './gstr2b';

/**
 * Loads purchase vouchers and lines from Dexie for the given month period (YYYY-MM).
 */
export async function loadBookPurchases(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
): Promise<BookPurchase[]> {
  const vouchers = await db.vouchers
    .where('workspaceId')
    .equals(workspaceId)
    .toArray();

  const periodVouchers = vouchers.filter(
    (v) => v.status === 'regular' && v.voucherType === 'Purchase' && monthKey(v.date) === period,
  );

  const voucherIds = new Set(periodVouchers.map((v) => v.id));
  const [lines, ledgers, parties] = await Promise.all([
    db.voucherLines.where('voucherId').anyOf([...voucherIds]).toArray(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
  ]);

  const ledgerMap = new Map(ledgers.map((l) => [l.id, l]));
  const partyByLedgerId = new Map(parties.map((p) => [p.ledgerId, p]));

  const results: BookPurchase[] = [];

  for (const voucher of periodVouchers) {
    const vLines = lines.filter((l) => l.voucherId === voucher.id);

    // Identify party ledger (Sundry Creditors or has party flag)
    const partyLine = vLines.find((l) => {
      const led = ledgerMap.get(l.ledgerId);
      return led?.isParty || led?.tallyParent === 'Sundry Creditors';
    });

    const partyLedger = partyLine ? ledgerMap.get(partyLine.ledgerId) : undefined;
    const linkedParty = partyLedger ? partyByLedgerId.get(partyLedger.id) : undefined;

    // Identify tax lines (SGST, CGST, IGST)
    const taxLines = vLines.filter((l) => {
      const led = ledgerMap.get(l.ledgerId);
      return led?.isTax || /GST|Tax/i.test(led?.name ?? '');
    });

    const totalTaxMinor = taxLines.reduce((sum, l) => sum + Math.abs(l.amountMinor), 0);
    const totalAmountMinor = voucher.totalDebitMinor;
    const taxableValueMinor = Math.max(0, totalAmountMinor - totalTaxMinor);

    results.push({
      voucherId: voucher.id,
      voucherNumber: voucher.number,
      voucherDate: voucher.date,
      partyName: partyLedger?.name ?? 'Sundry Creditor',
      partyGstin: linkedParty?.gstin,
      invoiceNumber: voucher.reference || voucher.number,
      taxableValueMinor,
      taxAmountMinor: totalTaxMinor,
      totalAmountMinor,
    });
  }

  return results;
}

/**
 * Executes full GSTR-2B reconciliation for a workspace and period.
 */
export async function executeGstr2bReconciliation(
  db: LedgerDatabase,
  workspaceId: string,
  period: string,
  gstr2bRecords: Gstr2bRecord[],
): Promise<{ items: Gstr2bReconItem[]; summary: Gstr2bSummary }> {
  const bookPurchases = await loadBookPurchases(db, workspaceId, period);
  return reconcileGstr2bWithBooks(gstr2bRecords, bookPurchases, period);
}
