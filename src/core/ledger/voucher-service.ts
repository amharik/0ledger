import { newId, nowIso } from '../ids';
import { markDriveDirty } from '../db/sync-state';
import {
  AuditEventSchema,
  NewVoucherSchema,
  type NewVoucher,
  type Voucher,
} from '../model';
import { compact } from '../util/objects';
import type { LedgerDatabase } from '../db/db';
import { postVoucher, type PostedVoucher } from './post-voucher';
import { LedgerValidationError, validateNewVoucherInput } from './validation';
import { buildVoucherChildren, buildVoucherRecord } from './voucher-records';

export interface VoucherMutationOptions {
  actor?: string;
}

export async function getPostedVoucher(
  db: LedgerDatabase,
  voucherId: string,
): Promise<PostedVoucher | undefined> {
  const [voucher, lines, items, billAllocations, costCenterAllocations, taxAllocations] =
    await Promise.all([
      db.vouchers.get(voucherId),
      db.voucherLines.where('voucherId').equals(voucherId).sortBy('lineNo'),
      db.itemLines.where('voucherId').equals(voucherId).sortBy('lineNo'),
      db.billAllocations.where('voucherId').equals(voucherId).toArray(),
      db.costCenterAllocations.where('voucherId').equals(voucherId).toArray(),
      db.taxAllocations.where('voucherId').equals(voucherId).toArray(),
    ]);

  if (!voucher) return undefined;
  return { voucher, lines, items, billAllocations, costCenterAllocations, taxAllocations };
}

export async function updateVoucher(
  db: LedgerDatabase,
  voucherId: string,
  rawInput: NewVoucher,
  options: VoucherMutationOptions = {},
): Promise<PostedVoucher> {
  const input = NewVoucherSchema.parse(rawInput);
  const existing = await db.vouchers.get(voucherId);
  if (!existing) throw new Error(`Voucher not found: ${voucherId}`);
  if (existing.workspaceId !== input.workspaceId) {
    throw new Error('Voucher belongs to a different workspace');
  }
  if (existing.status !== 'regular') {
    throw new Error('Only regular vouchers can be edited');
  }
  if (input.status !== 'regular') {
    throw new Error('Use cancelVoucher to change voucher status');
  }
  if (existing.voucherType !== input.voucherType) {
    throw new Error('Voucher type cannot be changed after posting');
  }
  if (input.number && input.number !== existing.number) {
    throw new Error('Voucher number cannot be changed after posting');
  }

  const validation = validateNewVoucherInput(input);
  if (!validation.ok) {
    throw new LedgerValidationError(
      validation.issues.filter((issue) => issue.severity === 'error'),
    );
  }

  const now = nowIso();
  const existingLines = await db.voucherLines
    .where('voucherId')
    .equals(voucherId)
    .sortBy('lineNo');
  const children = buildVoucherChildren(
    input,
    voucherId,
    now,
    existingLines.map((line) => ({ id: line.id, createdAt: line.createdAt })),
  );
  const voucher = buildVoucherRecord(input, {
    id: voucherId,
    number: existing.number,
    numberingSchemeId: existing.numberingSchemeId,
    now,
    createdAt: existing.createdAt,
  });
  const audit = AuditEventSchema.parse(
    compact({
      id: newId('aud'),
      workspaceId: input.workspaceId,
      entityType: 'voucher',
      entityId: voucherId,
      action: 'update',
      at: now,
      actor: options.actor,
      meta: { number: voucher.number, voucherType: voucher.voucherType },
    }),
  );

  await db.transaction(
    'rw',
    [
      db.vouchers,
      db.voucherLines,
      db.itemLines,
      db.billAllocations,
      db.costCenterAllocations,
      db.taxAllocations,
      db.auditEvents,
    ],
    async () => {
      await db.voucherLines.where('voucherId').equals(voucherId).delete();
      await db.itemLines.where('voucherId').equals(voucherId).delete();
      await db.billAllocations.where('voucherId').equals(voucherId).delete();
      await db.costCenterAllocations.where('voucherId').equals(voucherId).delete();
      await db.taxAllocations.where('voucherId').equals(voucherId).delete();

      await db.vouchers.put(voucher);
      await db.voucherLines.bulkAdd(children.lines);
      if (children.items.length > 0) await db.itemLines.bulkAdd(children.items);
      if (children.billAllocations.length > 0) {
        await db.billAllocations.bulkAdd(children.billAllocations);
      }
      if (children.costCenterAllocations.length > 0) {
        await db.costCenterAllocations.bulkAdd(children.costCenterAllocations);
      }
      if (children.taxAllocations.length > 0) {
        await db.taxAllocations.bulkAdd(children.taxAllocations);
      }
      await db.auditEvents.add(audit);
    },
  );

  await markDriveDirty(db, input.workspaceId);
  return { voucher, ...children };
}

export async function cancelVoucher(
  db: LedgerDatabase,
  voucherId: string,
  options: VoucherMutationOptions = {},
): Promise<Voucher> {
  const existing = await db.vouchers.get(voucherId);
  if (!existing) throw new Error(`Voucher not found: ${voucherId}`);
  if (existing.status === 'cancelled') return existing;

  const now = nowIso();
  const cancelled: Voucher = { ...existing, status: 'cancelled', updatedAt: now };
  const audit = AuditEventSchema.parse(
    compact({
      id: newId('aud'),
      workspaceId: existing.workspaceId,
      entityType: 'voucher',
      entityId: voucherId,
      action: 'void',
      at: now,
      actor: options.actor,
      meta: { number: existing.number, voucherType: existing.voucherType },
    }),
  );

  await db.transaction('rw', [db.vouchers, db.auditEvents], async () => {
    await db.vouchers.put(cancelled);
    await db.auditEvents.add(audit);
  });
  await markDriveDirty(db, existing.workspaceId);
  return cancelled;
}

export async function deleteVoucher(
  db: LedgerDatabase,
  voucherId: string,
  options: VoucherMutationOptions = {},
): Promise<void> {
  const existing = await db.vouchers.get(voucherId);
  if (!existing) throw new Error(`Voucher not found: ${voucherId}`);
  if (existing.status !== 'cancelled') {
    throw new Error('Cancel the voucher before deleting it');
  }

  const now = nowIso();
  const audit = AuditEventSchema.parse(
    compact({
      id: newId('aud'),
      workspaceId: existing.workspaceId,
      entityType: 'voucher',
      entityId: voucherId,
      action: 'delete',
      at: now,
      actor: options.actor,
      meta: { number: existing.number, voucherType: existing.voucherType },
    }),
  );

  await db.transaction(
    'rw',
    [
      db.vouchers,
      db.voucherLines,
      db.itemLines,
      db.billAllocations,
      db.costCenterAllocations,
      db.taxAllocations,
      db.attachments,
      db.auditEvents,
    ],
    async () => {
      await db.voucherLines.where('voucherId').equals(voucherId).delete();
      await db.itemLines.where('voucherId').equals(voucherId).delete();
      await db.billAllocations.where('voucherId').equals(voucherId).delete();
      await db.costCenterAllocations.where('voucherId').equals(voucherId).delete();
      await db.taxAllocations.where('voucherId').equals(voucherId).delete();
      await db.attachments.where('voucherId').equals(voucherId).delete();
      await db.vouchers.delete(voucherId);
      await db.auditEvents.add(audit);
    },
  );
  await markDriveDirty(db, existing.workspaceId);
}

export async function reverseVoucher(
  db: LedgerDatabase,
  voucherId: string,
  options: VoucherMutationOptions & { date?: string; narration?: string } = {},
): Promise<PostedVoucher> {
  const original = await getPostedVoucher(db, voucherId);
  if (!original) throw new Error(`Voucher not found: ${voucherId}`);
  if (original.voucher.status !== 'regular') throw new Error('Only regular vouchers can be reversed');

  const existing = await db.vouchers.where('workspaceId').equals(original.voucher.workspaceId).toArray();
  if (existing.some((voucher) => voucher.reversesVoucherId === voucherId)) {
    throw new Error('Voucher has already been reversed');
  }
  if (original.voucher.reversesVoucherId) throw new Error('A reversal voucher cannot be reversed');

  const billByLine = new Map<string, typeof original.billAllocations>();
  for (const allocation of original.billAllocations) {
    const list = billByLine.get(allocation.voucherLineId) ?? [];
    list.push(allocation);
    billByLine.set(allocation.voucherLineId, list);
  }
  const costByLine = new Map<string, typeof original.costCenterAllocations>();
  for (const allocation of original.costCenterAllocations) {
    const list = costByLine.get(allocation.voucherLineId) ?? [];
    list.push(allocation);
    costByLine.set(allocation.voucherLineId, list);
  }
  const firstLineId = original.lines[0]?.id ?? '';
  const taxByLine = new Map<string, typeof original.taxAllocations>();
  for (const allocation of original.taxAllocations) {
    const key = allocation.voucherLineId ?? firstLineId;
    const list = taxByLine.get(key) ?? [];
    list.push(allocation);
    taxByLine.set(key, list);
  }

  return postVoucher(
    db,
    compact({
      workspaceId: original.voucher.workspaceId,
      voucherType: original.voucher.voucherType,
      date: options.date ?? original.voucher.date,
      narration:
        options.narration ??
        `Reversal of ${original.voucher.number}${original.voucher.narration ? `: ${original.voucher.narration}` : ''}`,
      partyLedgerId: original.voucher.partyLedgerId,
      effectiveDate: original.voucher.effectiveDate,
      reference: original.voucher.reference,
      placeOfSupply: original.voucher.placeOfSupply,
      gstRegistration: original.voucher.gstRegistration,
      reverseCharge: original.voucher.reverseCharge,
      status: 'regular',
      currency: original.voucher.currency,
      source: 'system',
      sourceRef: `reversal:${original.voucher.id}`,
      reversesVoucherId: original.voucher.id,
      groupIds: original.voucher.groupIds,
      tags: original.voucher.tags,
      lines: original.lines.map((line) => ({
        lineNo: line.lineNo,
        ledgerId: line.ledgerId,
        amountMinor: -line.amountMinor,
        currency: line.currency,
        forexAmountMinor: line.forexAmountMinor === undefined ? undefined : -line.forexAmountMinor,
        exchangeRate: line.exchangeRate,
        narration: `Reversal of ${original.voucher.number}`,
        hsnSac: line.hsnSac,
        billAllocations: (billByLine.get(line.id) ?? []).map((allocation) => ({
          billRef: allocation.billRef,
          billType: allocation.billType,
          amountMinor: -allocation.amountMinor,
          dueDate: allocation.dueDate,
          creditDays: allocation.creditDays,
        })),
        costCenterAllocations: (costByLine.get(line.id) ?? []).map((allocation) => ({
          costCenterId: allocation.costCenterId,
          amountMinor: -allocation.amountMinor,
        })),
        taxAllocations: (taxByLine.get(line.id) ?? []).map((allocation) => ({
          ledgerId: allocation.ledgerId,
          taxType: allocation.taxType,
          amountMinor: -allocation.amountMinor,
          taxableValueMinor:
            allocation.taxableValueMinor === undefined ? undefined : -allocation.taxableValueMinor,
          rate: allocation.rate,
          hsnSac: allocation.hsnSac,
          tdsSection: allocation.tdsSection,
        })),
      })),
      items: [],
    }),
    { ...(options.actor ? { actor: options.actor } : {}) },
  );
}
