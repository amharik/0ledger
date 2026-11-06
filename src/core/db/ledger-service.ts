import { newId, nowIso } from '../ids';
import { compact } from '../util/objects';
import {
  LedgerSchema,
  PartySchema,
  type Ledger,
  type LedgerGroup,
  type Party,
} from '../model';
import type { LedgerDatabase } from './db';

export interface CreateLedgerInput {
  workspaceId: string;
  name: string;
  groupId?: string;
  tallyParent?: string;
  code?: string;
  openingBalanceMinor?: number;
  openingBalanceDate?: string;
  currency?: string;
  billwise?: boolean;
  costCenterApplicable?: boolean;
  notes?: string;
  createPartyMaster?: boolean;
}

export interface UpdateLedgerInput {
  name?: string;
  code?: string;
  openingBalanceMinor?: number;
  openingBalanceDate?: string;
  billwise?: boolean;
  costCenterApplicable?: boolean;
  notes?: string;
  archived?: boolean;
}

export interface CreatedLedger {
  ledger: Ledger;
  party?: Party;
}

async function findGroup(
  db: LedgerDatabase,
  workspaceId: string,
  groupId?: string,
  tallyParent?: string,
): Promise<LedgerGroup> {
  const group = groupId
    ? await db.ledgerGroups.get(groupId)
    : tallyParent
      ? await db.ledgerGroups
          .where('[workspaceId+name]')
          .equals([workspaceId, tallyParent])
          .first()
      : undefined;
  if (!group || group.workspaceId !== workspaceId) {
    throw new Error('Choose a valid ledger group in this workspace');
  }
  return group;
}

async function assertUniqueName(
  db: LedgerDatabase,
  workspaceId: string,
  name: string,
  ignoreId?: string,
): Promise<void> {
  const normalized = name.trim().toLocaleLowerCase();
  const ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
  const clash = ledgers.find(
    (ledger) =>
      ledger.id !== ignoreId && ledger.name.trim().toLocaleLowerCase() === normalized,
  );
  if (clash) throw new Error(`A ledger named “${clash.name}” already exists`);
}

export async function createLedger(
  db: LedgerDatabase,
  input: CreateLedgerInput,
): Promise<CreatedLedger> {
  const name = input.name.trim();
  if (!name) throw new Error('Ledger name is required');
  if (name.length > 256) throw new Error('Ledger name is too long');

  const workspace = await db.workspaces.get(input.workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
  const company = await db.companies.get(workspace.companyId);
  const group = await findGroup(db, input.workspaceId, input.groupId, input.tallyParent);
  await assertUniqueName(db, input.workspaceId, name);

  const isParty =
    group.primaryGroup === 'Sundry Debtors' || group.primaryGroup === 'Sundry Creditors';
  const now = nowIso();
  const ledger = LedgerSchema.parse(
    compact({
      id: newId('led'),
      workspaceId: input.workspaceId,
      code: input.code?.trim() || undefined,
      name,
      readableName: name,
      groupId: group.id,
      tallyParent: group.primaryGroup,
      nature: group.nature,
      isParty,
      isBank: group.primaryGroup === 'Bank Accounts',
      isCash: group.primaryGroup === 'Cash-in-Hand',
      isTax: group.primaryGroup === 'Duties & Taxes',
      isSystem: false,
      openingBalanceMinor: input.openingBalanceMinor ?? 0,
      openingBalanceDate: input.openingBalanceDate ?? company?.booksBegin,
      currency: input.currency ?? company?.currency ?? 'INR',
      billwise: input.billwise ?? isParty,
      costCenterApplicable: input.costCenterApplicable ?? false,
      archived: false,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    }),
  );

  let party: Party | undefined;
  if (isParty && (input.createPartyMaster ?? true)) {
    party = PartySchema.parse(
      compact({
        id: newId('pty'),
        workspaceId: input.workspaceId,
        ledgerId: ledger.id,
        type: group.primaryGroup === 'Sundry Debtors' ? 'debtor' : 'creditor',
        legalName: name,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  await db.transaction('rw', [db.ledgers, db.parties], async () => {
    await db.ledgers.add(ledger);
    if (party) await db.parties.add(party);
  });

  return party ? { ledger, party } : { ledger };
}

export async function updateLedger(
  db: LedgerDatabase,
  ledgerId: string,
  input: UpdateLedgerInput,
): Promise<Ledger> {
  const current = await db.ledgers.get(ledgerId);
  if (!current) throw new Error(`Ledger not found: ${ledgerId}`);

  const name = input.name?.trim();
  if (name !== undefined) {
    if (!name) throw new Error('Ledger name is required');
    await assertUniqueName(db, current.workspaceId, name, ledgerId);
  }

  const patch = compact({
    name,
    code: input.code?.trim() || undefined,
    openingBalanceMinor: input.openingBalanceMinor,
    openingBalanceDate: input.openingBalanceDate,
    billwise: input.billwise,
    costCenterApplicable: input.costCenterApplicable,
    notes: input.notes,
    archived: input.archived,
    updatedAt: nowIso(),
  });
  const updated = LedgerSchema.parse({ ...current, ...patch });
  await db.ledgers.put(updated);
  return updated;
}

export async function removeLedger(
  db: LedgerDatabase,
  ledgerId: string,
): Promise<'deleted' | 'archived'> {
  const ledger = await db.ledgers.get(ledgerId);
  if (!ledger) throw new Error(`Ledger not found: ${ledgerId}`);
  if (ledger.isSystem) throw new Error('System ledgers cannot be deleted');

  const used = await db.voucherLines.where('ledgerId').equals(ledgerId).count();
  if (used > 0) {
    await updateLedger(db, ledgerId, { archived: true });
    return 'archived';
  }

  await db.transaction('rw', [db.ledgers, db.parties], async () => {
    await db.parties.where('ledgerId').equals(ledgerId).delete();
    await db.ledgers.delete(ledgerId);
  });
  return 'deleted';
}
