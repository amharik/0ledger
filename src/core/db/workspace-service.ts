import { newId, nowIso, slugify, uniqueSlug } from '../ids';
import type { RoundingMode } from '../money/money';
import {
  CompanyProfileSchema,
  LedgerGroupSchema,
  LedgerSchema,
  NumberingSchemeSchema,
  TALLY_PRIMARY_GROUPS,
  WorkspaceSchema,
  type CompanyProfile,
  type Ledger,
  type LedgerGroup,
  type NumberingScheme,
  type Workspace,
} from '../model';
import type { LedgerDatabase } from './db';
import { markDriveDirty } from './sync-state';
import {
  DEFAULT_LEDGERS,
  DEFAULT_NUMBERING,
  TALLY_GROUP_NATURE,
  defaultBooksBegin,
} from './defaults';

export interface CreateWorkspaceInput {
  name: string;
  readableName?: string;
  slug?: string;
  companyLegalName?: string;
  gstin?: string;
  state?: string;
  pincode?: string;
  address?: string;
  currency?: string;
  fyStartMonth?: number;
  booksBegin?: string;
  roundToMinor?: number;
  roundingMode?: RoundingMode;
}

export interface WorkspaceBundle {
  workspace: Workspace;
  company: CompanyProfile;
  groups: LedgerGroup[];
  ledgers: Ledger[];
  numberingSchemes: NumberingScheme[];
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export async function createWorkspace(
  db: LedgerDatabase,
  input: CreateWorkspaceInput,
): Promise<WorkspaceBundle> {
  const name = input.name.trim();
  if (!name) throw new Error('Workspace name is required');

  const existingSlugs = (await db.workspaces.toArray()).map((workspace) => workspace.slug);
  const slug = uniqueSlug(input.slug ?? name, existingSlugs);
  const now = nowIso();
  const fyStartMonth = input.fyStartMonth ?? 4;
  const booksBegin = input.booksBegin ?? defaultBooksBegin(fyStartMonth);

  const workspaceId = newId('ws');
  const companyId = newId('co');

  const workspace = WorkspaceSchema.parse(
    compact({
      id: workspaceId,
      slug,
      name,
      readableName: input.readableName ?? name,
      companyId,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const company = CompanyProfileSchema.parse(
    compact({
      id: companyId,
      workspaceId,
      legalName: input.companyLegalName ?? name,
      gstin: input.gstin,
      state: input.state,
      pincode: input.pincode,
      address: input.address,
      country: 'IN',
      currency: input.currency ?? 'INR',
      booksBegin,
      settings: {
        fyStartMonth,
        roundToMinor: input.roundToMinor ?? 1,
        roundingMode: input.roundingMode ?? 'half-up',
        taxRoundingLevel: 'invoice',
        decimalPlaces: 2,
        defaultCurrency: input.currency ?? 'INR',
      },
      createdAt: now,
      updatedAt: now,
    }),
  );

  const groups: LedgerGroup[] = TALLY_PRIMARY_GROUPS.map((primaryGroup) =>
    LedgerGroupSchema.parse({
      id: newId('grp'),
      workspaceId,
      name: primaryGroup,
      primaryGroup,
      nature: TALLY_GROUP_NATURE[primaryGroup],
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const groupByName = new Map(groups.map((group) => [group.name, group]));

  const ledgers: Ledger[] = DEFAULT_LEDGERS.map((spec) => {
    const group = groupByName.get(spec.tallyParent);
    return LedgerSchema.parse(
      compact({
        id: newId('led'),
        workspaceId,
        code: spec.code,
        name: spec.name,
        readableName: spec.name,
        groupId: group?.id,
        tallyParent: spec.tallyParent,
        nature: spec.nature,
        isParty: spec.isParty ?? false,
        isBank: spec.isBank ?? false,
        isCash: spec.isCash ?? false,
        isTax: spec.isTax ?? false,
        isSystem: spec.isSystem ?? false,
        openingBalanceMinor: 0,
        openingBalanceDate: booksBegin,
        currency: input.currency ?? 'INR',
        billwise: false,
        costCenterApplicable: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });

  const numberingSchemes: NumberingScheme[] = DEFAULT_NUMBERING.map((spec) =>
    NumberingSchemeSchema.parse({
      id: newId('num'),
      workspaceId,
      voucherType: spec.voucherType,
      name: `${spec.voucherType} default`,
      prefix: spec.prefix,
      suffix: '',
      separator: '/',
      padding: 4,
      nextNumber: 1,
      startNumber: 1,
      resetPeriod: 'fy',
      allowManualOverride: true,
      enforceUnique: true,
      allowGaps: true,
      createdAt: now,
      updatedAt: now,
    }),
  );

  await db.transaction(
    'rw',
    [db.workspaces, db.companies, db.ledgerGroups, db.ledgers, db.numberingSchemes],
    async () => {
      await db.workspaces.add(workspace);
      await db.companies.add(company);
      await db.ledgerGroups.bulkAdd(groups);
      await db.ledgers.bulkAdd(ledgers);
      await db.numberingSchemes.bulkAdd(numberingSchemes);
    },
  );

  await markDriveDirty(db, workspaceId);
  return { workspace, company, groups, ledgers, numberingSchemes };
}

export async function getWorkspaceBundle(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<WorkspaceBundle | undefined> {
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace) return undefined;
  const [company, groups, ledgers, numberingSchemes] = await Promise.all([
    db.companies.get(workspace.companyId),
    db.ledgerGroups.where('workspaceId').equals(workspaceId).toArray(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.numberingSchemes.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  if (!company) return undefined;
  return { workspace, company, groups, ledgers, numberingSchemes };
}

export function workspaceDisplayName(workspace: Workspace): string {
  return workspace.readableName || workspace.name || slugify(workspace.slug);
}
