import { newId, nowIso } from '../ids';
import {
  PartySchema,
  StockItemSchema,
  type Ledger,
  type Party,
  type StockItem,
} from '../model';
import { compact } from '../util/objects';
import type { LedgerDatabase } from './db';
import { markDriveDirty } from './sync-state';

export interface PartyView {
  party: Party;
  ledger: Ledger;
}

export async function listParties(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<PartyView[]> {
  const [parties, ledgers] = await Promise.all([
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  const ledgerById = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
  return parties
    .map((party) => {
      const ledger = ledgerById.get(party.ledgerId);
      return ledger ? { party, ledger } : undefined;
    })
    .filter((row): row is PartyView => row !== undefined)
    .sort((a, b) => a.ledger.name.localeCompare(b.ledger.name));
}

export interface UpdatePartyInput {
  legalName?: string;
  gstin?: string;
  gstRegistrationType?: string;
  billingAddress?: string;
  shippingAddress?: string;
  state?: string;
  pincode?: string;
  email?: string;
  phone?: string;
  creditPeriodDays?: number;
  creditLimitMinor?: number;
}

export async function updateParty(
  db: LedgerDatabase,
  partyId: string,
  input: UpdatePartyInput,
): Promise<Party> {
  const current = await db.parties.get(partyId);
  if (!current) throw new Error(`Party not found: ${partyId}`);
  const updated = PartySchema.parse({
    ...current,
    ...compact({
      legalName: input.legalName?.trim() || undefined,
      gstin: input.gstin?.trim().toUpperCase() || undefined,
      gstRegistrationType: input.gstRegistrationType?.trim() || undefined,
      billingAddress: input.billingAddress?.trim() || undefined,
      shippingAddress: input.shippingAddress?.trim() || undefined,
      state: input.state?.trim() || undefined,
      pincode: input.pincode?.trim() || undefined,
      email: input.email?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      creditPeriodDays: input.creditPeriodDays,
      creditLimitMinor: input.creditLimitMinor,
    }),
    updatedAt: nowIso(),
  });
  await db.parties.put(updated);
  await markDriveDirty(db, current.workspaceId);
  return updated;
}

export interface CreateStockItemInput {
  workspaceId: string;
  name: string;
  hsnSac?: string;
  uom?: string;
  rateMinor?: number;
  taxRate?: string;
  openingQuantity?: string;
  openingValueMinor?: number;
  valuationMethod?: 'fifo' | 'weighted-average' | 'standard-cost';
}

async function assertStockNameFree(
  db: LedgerDatabase,
  workspaceId: string,
  name: string,
  ignoreId?: string,
): Promise<void> {
  const items = await db.stockItems.where('workspaceId').equals(workspaceId).toArray();
  const normalized = name.trim().toLocaleLowerCase();
  const clash = items.find(
    (item) => item.id !== ignoreId && item.name.trim().toLocaleLowerCase() === normalized,
  );
  if (clash) throw new Error(`A stock item named “${clash.name}” already exists`);
}

export async function createStockItem(
  db: LedgerDatabase,
  input: CreateStockItemInput,
): Promise<StockItem> {
  const name = input.name.trim();
  if (!name) throw new Error('Stock item name is required');
  await assertStockNameFree(db, input.workspaceId, name);
  const now = nowIso();
  const item = StockItemSchema.parse(
    compact({
      id: newId('item'),
      workspaceId: input.workspaceId,
      name,
      hsnSac: input.hsnSac?.trim() || undefined,
      uom: input.uom?.trim() || 'NOS',
      rateMinor: input.rateMinor ?? 0,
      taxRate: input.taxRate,
      openingQuantity: input.openingQuantity,
      openingValueMinor: input.openingValueMinor,
      valuationMethod: input.valuationMethod,
      archived: false,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await db.stockItems.add(item);
  await markDriveDirty(db, input.workspaceId);
  return item;
}

export interface UpdateStockItemInput {
  name?: string;
  hsnSac?: string;
  uom?: string;
  rateMinor?: number;
  taxRate?: string;
  openingQuantity?: string;
  openingValueMinor?: number;
  valuationMethod?: 'fifo' | 'weighted-average' | 'standard-cost';
  archived?: boolean;
}

export async function updateStockItem(
  db: LedgerDatabase,
  stockItemId: string,
  input: UpdateStockItemInput,
): Promise<StockItem> {
  const current = await db.stockItems.get(stockItemId);
  if (!current) throw new Error(`Stock item not found: ${stockItemId}`);
  const name = input.name?.trim();
  if (name !== undefined) {
    if (!name) throw new Error('Stock item name is required');
    await assertStockNameFree(db, current.workspaceId, name, stockItemId);
  }
  const updated = StockItemSchema.parse({
    ...current,
    ...compact({
      name,
      hsnSac: input.hsnSac?.trim() || undefined,
      uom: input.uom?.trim() || undefined,
      rateMinor: input.rateMinor,
      taxRate: input.taxRate,
      openingQuantity: input.openingQuantity,
      openingValueMinor: input.openingValueMinor,
      valuationMethod: input.valuationMethod,
      archived: input.archived,
    }),
    updatedAt: nowIso(),
  });
  await db.stockItems.put(updated);
  await markDriveDirty(db, current.workspaceId);
  return updated;
}

export async function listStockItems(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<StockItem[]> {
  return db.stockItems
    .where('workspaceId')
    .equals(workspaceId)
    .toArray()
    .then((items) => items.sort((a, b) => a.name.localeCompare(b.name)));
}
