import { financialYearKey, newId, nowIso } from '../ids';
import { LedgerValidationError, validateNewVoucherInput } from '../ledger/validation';
import { previewNextNumber, validateManualNumber } from '../numbering';
import {
  AuditEventSchema,
  NewVoucherSchema,
  type BillAllocation,
  type CostCenterAllocation,
  type ItemLine,
  type NewVoucher,
  type NumberingScheme,
  type TaxAllocation,
  type Voucher,
  type VoucherLine,
} from '../model';
import { compact } from '../util/objects';
import type { LedgerDatabase } from '../db/db';
import { markDriveDirty } from '../db/sync-state';
import { buildVoucherChildren, buildVoucherRecord } from './voucher-records';

export interface PostedVoucher {
  voucher: Voucher;
  lines: VoucherLine[];
  items: ItemLine[];
  billAllocations: BillAllocation[];
  costCenterAllocations: CostCenterAllocation[];
  taxAllocations: TaxAllocation[];
}

export interface PostVoucherOptions {
  actor?: string;
  /** Override the company's FY start month when numbering. */
  fyStartMonth?: number;
}

async function findDuplicateNumber(
  db: LedgerDatabase,
  workspaceId: string,
  voucherType: string,
  number: string,
  date: string,
  fyStartMonth: number,
): Promise<Voucher | undefined> {
  const candidates = await db.vouchers
    .where('[workspaceId+voucherType]')
    .equals([workspaceId, voucherType])
    .toArray();
  const fy = financialYearKey(date, fyStartMonth);
  return candidates.find(
    (candidate) =>
      candidate.number === number && financialYearKey(candidate.date, fyStartMonth) === fy,
  );
}

async function resolveScheme(
  db: LedgerDatabase,
  input: NewVoucher,
): Promise<NumberingScheme | undefined> {
  if (input.numberingSchemeId) {
    const scheme = await db.numberingSchemes.get(input.numberingSchemeId);
    if (!scheme) throw new Error(`Numbering scheme not found: ${input.numberingSchemeId}`);
    if (scheme.workspaceId !== input.workspaceId) {
      throw new Error('Numbering scheme belongs to a different workspace');
    }
    if (scheme.voucherType !== input.voucherType) {
      throw new Error(
        `Numbering scheme is for ${scheme.voucherType}, not ${input.voucherType}`,
      );
    }
    return scheme;
  }

  const schemes = await db.numberingSchemes
    .where('[workspaceId+voucherType]')
    .equals([input.workspaceId, input.voucherType])
    .toArray();
  return schemes[0];
}

async function assignNumber(
  db: LedgerDatabase,
  input: NewVoucher,
  fyStartMonth: number,
): Promise<{
  number: string;
  scheme: NumberingScheme | undefined;
  schemeToPersist: NumberingScheme | undefined;
}> {
  const scheme = await resolveScheme(db, input);
  const now = nowIso();

  if (input.number) {
    const duplicate = await findDuplicateNumber(
      db,
      input.workspaceId,
      input.voucherType,
      input.number,
      input.date,
      fyStartMonth,
    );
    if (scheme) {
      const manual = validateManualNumber(scheme, input.number, duplicate ? [duplicate.number] : []);
      if (!manual.ok) {
        throw new LedgerValidationError(
          manual.errors.map((message) => ({
            code: 'numbering.invalid',
            severity: 'error',
            message,
          })),
        );
      }
      if (!duplicate) {
        const preview = previewNextNumber(scheme, input.date, fyStartMonth);
        return {
          number: input.number,
          scheme,
          schemeToPersist: {
            ...preview.scheme,
            nextNumber: Math.max(preview.scheme.nextNumber, scheme.nextNumber),
            updatedAt: now,
          },
        };
      }
    } else if (duplicate) {
      throw new LedgerValidationError([
        {
          code: 'numbering.duplicate',
          severity: 'error',
          message: `Voucher number ${input.number} already exists for ${input.voucherType}`,
        },
      ]);
    }
    return { number: input.number, scheme, schemeToPersist: undefined };
  }

  if (!scheme) {
    throw new Error(`No numbering scheme and no manual number for ${input.voucherType}`);
  }
  const preview = previewNextNumber(scheme, input.date, fyStartMonth);
  return {
    number: preview.number,
    scheme,
    schemeToPersist: { ...preview.scheme, updatedAt: now },
  };
}

export async function postVoucher(
  db: LedgerDatabase,
  rawInput: NewVoucher,
  options: PostVoucherOptions = {},
): Promise<PostedVoucher> {
  const input = NewVoucherSchema.parse(rawInput);
  const validation = validateNewVoucherInput(input);
  if (!validation.ok) {
    throw new LedgerValidationError(
      validation.issues.filter((issue) => issue.severity === 'error'),
    );
  }

  const workspace = await db.workspaces.get(input.workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
  const company = await db.companies.get(workspace.companyId);
  const fyStartMonth = options.fyStartMonth ?? company?.settings.fyStartMonth ?? 4;

  const now = nowIso();
  const voucherId = newId('vch');
  const { lines, items, billAllocations, costCenterAllocations, taxAllocations } =
    buildVoucherChildren(input, voucherId, now);

  const audit = AuditEventSchema.parse(
    compact({
      id: newId('aud'),
      workspaceId: input.workspaceId,
      entityType: 'voucher',
      entityId: voucherId,
      action: 'create',
      at: now,
      actor: options.actor,
      meta: { voucherType: input.voucherType },
    }),
  );

  const posted = await db.transaction(
    'rw',
    [
      db.vouchers,
      db.voucherLines,
      db.itemLines,
      db.billAllocations,
      db.costCenterAllocations,
      db.taxAllocations,
      db.numberingSchemes,
      db.auditEvents,
    ],
    async () => {
      const assigned = await assignNumber(db, input, fyStartMonth);
      const voucher = buildVoucherRecord(input, {
        id: voucherId,
        number: assigned.number,
        numberingSchemeId: assigned.scheme?.id ?? input.numberingSchemeId,
        now,
      });

      if (assigned.schemeToPersist) {
        await db.numberingSchemes.put(assigned.schemeToPersist);
      }
      await db.vouchers.add(voucher);
      await db.voucherLines.bulkAdd(lines);
      if (items.length > 0) await db.itemLines.bulkAdd(items);
      if (billAllocations.length > 0) await db.billAllocations.bulkAdd(billAllocations);
      if (costCenterAllocations.length > 0) {
        await db.costCenterAllocations.bulkAdd(costCenterAllocations);
      }
      if (taxAllocations.length > 0) await db.taxAllocations.bulkAdd(taxAllocations);
      await db.auditEvents.add(
        AuditEventSchema.parse({ ...audit, meta: { ...audit.meta, number: assigned.number } }),
      );
      return voucher;
    },
  );

  await markDriveDirty(db, input.workspaceId);
  return {
    voucher: posted,
    lines,
    items,
    billAllocations,
    costCenterAllocations,
    taxAllocations,
  };
}

/** Post an opening-balance journal through the suspense/equity ledgers. */
export async function postOpeningBalance(
  db: LedgerDatabase,
  args: {
    workspaceId: string;
    date: string;
    ledgerId: string;
    amountMinor: number;
    equityLedgerId: string;
    narration?: string;
  },
): Promise<PostedVoucher> {
  return postVoucher(db, {
    workspaceId: args.workspaceId,
    voucherType: 'Journal',
    date: args.date,
    narration: args.narration ?? 'Opening balance',
    source: 'system',
    reverseCharge: false,
    status: 'regular',
    currency: 'INR',
    lines: [
      {
        ledgerId: args.ledgerId,
        amountMinor: args.amountMinor,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
      {
        ledgerId: args.equityLedgerId,
        amountMinor: -args.amountMinor,
        currency: 'INR',
        billAllocations: [],
        costCenterAllocations: [],
        taxAllocations: [],
      },
    ],
    items: [],
    groupIds: [],
    tags: [],
  });
}
