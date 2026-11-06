import { newId } from '../ids';
import { compact } from '../util/objects';
import { computeTotals } from './validation';
import {
  BillAllocationSchema,
  CostCenterAllocationSchema,
  ItemLineSchema,
  TaxAllocationSchema,
  VoucherLineSchema,
  VoucherSchema,
  type BillAllocation,
  type CostCenterAllocation,
  type ItemLine,
  type NewVoucher,
  type TaxAllocation,
  type Voucher,
  type VoucherLine,
} from '../model';

export interface VoucherChildren {
  lines: VoucherLine[];
  items: ItemLine[];
  billAllocations: BillAllocation[];
  costCenterAllocations: CostCenterAllocation[];
  taxAllocations: TaxAllocation[];
}

export interface PreservedVoucherLine {
  id: string;
  createdAt: string;
}

export function computeRoundOffAmount(input: NewVoucher): number {
  if (!input.roundOffLedgerId) return 0;
  return input.lines
    .filter((line) => line.ledgerId === input.roundOffLedgerId)
    .reduce((sum, line) => sum + line.amountMinor, 0);
}

export function buildVoucherChildren(
  input: NewVoucher,
  voucherId: string,
  now: string,
  preservedLines: PreservedVoucherLine[] = [],
): VoucherChildren {
  const lines: VoucherLine[] = input.lines.map((line, index) => {
    const preserved = preservedLines[index];
    return VoucherLineSchema.parse(
      compact({
        id: preserved?.id ?? newId('vln'),
        voucherId,
        workspaceId: input.workspaceId,
        lineNo: line.lineNo ?? index + 1,
        ledgerId: line.ledgerId,
        amountMinor: line.amountMinor,
        currency: line.currency,
        forexAmountMinor: line.forexAmountMinor,
        exchangeRate: line.exchangeRate,
        narration: line.narration,
        hsnSac: line.hsnSac,
        createdAt: preserved?.createdAt ?? now,
        updatedAt: now,
      }),
    );
  });

  const lineByNo = new Map(lines.map((line) => [line.lineNo, line]));
  const items: ItemLine[] = input.items.map((item, index) =>
    ItemLineSchema.parse(
      compact({
        id: newId('iln'),
        voucherId,
        workspaceId: input.workspaceId,
        lineNo: item.lineNo ?? index + 1,
        stockItemId: item.stockItemId,
        description: item.description,
        hsnSac: item.hsnSac,
        quantity: item.quantity,
        uom: item.uom,
        rateMinor: item.rateMinor,
        amountMinor: item.amountMinor,
        discountMinor: item.discountMinor,
        godownId: item.godownId,
        batchId: item.batchId,
        direction: item.direction,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  );

  const billAllocations: BillAllocation[] = [];
  const costCenterAllocations: CostCenterAllocation[] = [];
  const taxAllocations: TaxAllocation[] = [];

  input.lines.forEach((lineInput, index) => {
    const lineNo = lineInput.lineNo ?? index + 1;
    const line = lineByNo.get(lineNo);
    if (!line) throw new Error(`Internal error: line ${lineNo} was not created`);

    for (const allocation of lineInput.billAllocations) {
      billAllocations.push(
        BillAllocationSchema.parse(
          compact({
            id: newId('bil'),
            workspaceId: input.workspaceId,
            voucherId,
            voucherLineId: line.id,
            ledgerId: line.ledgerId,
            billRef: allocation.billRef,
            billType: allocation.billType,
            amountMinor: allocation.amountMinor,
            dueDate: allocation.dueDate,
            creditDays: allocation.creditDays,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
    }

    for (const allocation of lineInput.costCenterAllocations) {
      costCenterAllocations.push(
        CostCenterAllocationSchema.parse({
          id: newId('ccl'),
          workspaceId: input.workspaceId,
          voucherId,
          voucherLineId: line.id,
          costCenterId: allocation.costCenterId,
          amountMinor: allocation.amountMinor,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    for (const allocation of lineInput.taxAllocations) {
      taxAllocations.push(
        TaxAllocationSchema.parse(
          compact({
            id: newId('tax'),
            workspaceId: input.workspaceId,
            voucherId,
            voucherLineId: line.id,
            ledgerId: allocation.ledgerId,
            taxType: allocation.taxType,
            amountMinor: allocation.amountMinor,
            taxableValueMinor: allocation.taxableValueMinor,
            rate: allocation.rate,
            hsnSac: allocation.hsnSac,
            tdsSection: allocation.tdsSection,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
    }
  });

  return { lines, items, billAllocations, costCenterAllocations, taxAllocations };
}

export interface VoucherRecordMeta {
  id: string;
  number: string;
  numberingSchemeId?: string | undefined;
  now: string;
  createdAt?: string | undefined;
}

export function buildVoucherRecord(input: NewVoucher, meta: VoucherRecordMeta): Voucher {
  const totals = computeTotals(input.lines);
  return VoucherSchema.parse(
    compact({
      id: meta.id,
      workspaceId: input.workspaceId,
      voucherType: input.voucherType,
      number: meta.number,
      numberingSchemeId: meta.numberingSchemeId,
      date: input.date,
      effectiveDate: input.effectiveDate,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      creditDays: input.creditDays,
      partyLedgerId: input.partyLedgerId,
      reference: input.reference,
      narration: input.narration,
      placeOfSupply: input.placeOfSupply,
      gstRegistration: input.gstRegistration,
      reverseCharge: input.reverseCharge,
      status: input.status,
      currency: input.currency,
      totalDebitMinor: totals.totalDebitMinor,
      totalCreditMinor: totals.totalCreditMinor,
      roundOffAmountMinor: computeRoundOffAmount(input),
      roundOffLedgerId: input.roundOffLedgerId,
      source: input.source,
      sourceRef: input.sourceRef,
      groupIds: input.groupIds,
      accountingId: input.accountingId,
      tags: input.tags,
      tally: input.tally,
      createdAt: meta.createdAt ?? meta.now,
      updatedAt: meta.now,
    }),
  );
}
