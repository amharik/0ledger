import { newId, nowIso } from '../ids';
import {
  AuditEventSchema,
  NewVoucherSchema,
  type NewVoucher,
  type Voucher,
} from '../model';
import { compact } from '../util/objects';
import type { LedgerDatabase } from '../db/db';
import type { PostedVoucher } from './post-voucher';
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
}
