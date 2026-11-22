import type {
  CompanyProfile,
  Ledger,
  Party,
  Voucher,
  VoucherLine,
  Workspace,
} from '@/core/model';
import { trialBalance, type TrialBalance } from '@/core/ledger/reports';
import type { LedgerDatabase } from './db';
import {
  isNativeStoreAvailable,
  nativeStore,
  type ImportBundle,
  type ImportSummary,
  type MirrorEntityType,
  type RustCompany,
  type RustLedger,
  type RustNewVoucher,
  type RustParty,
  type RustVoucher,
  type RustVoucherLine,
  type RustWorkspace,
} from './native-store';

/**
 * Converts the richer Dexie records into the Rust engine's serde contract and
 * writes them through to authoritative SQLite. Dexie stays the immediate UI
 * cache; SQLite is the system of record for the ledger core.
 */

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function toRustWorkspace(workspace: Workspace): RustWorkspace {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    readableName: workspace.readableName,
    companyId: workspace.companyId,
    archived: workspace.archived,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export function toRustCompany(company: CompanyProfile): RustCompany {
  return {
    id: company.id,
    workspaceId: company.workspaceId,
    legalName: company.legalName,
    ...optionalField('tradeName', company.tradeName),
    ...optionalField('gstin', company.gstin),
    ...optionalField('pan', company.pan),
    ...optionalField('state', company.state),
    currency: company.currency,
    booksBegin: company.booksBegin,
    settings: {
      fyStartMonth: company.settings.fyStartMonth,
      roundToMinor: company.settings.roundToMinor,
      roundingMode: company.settings.roundingMode,
      decimalPlaces: company.settings.decimalPlaces,
      defaultCurrency: company.settings.defaultCurrency,
    },
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

export function toRustLedger(ledger: Ledger): RustLedger {
  return {
    id: ledger.id,
    workspaceId: ledger.workspaceId,
    name: ledger.name,
    tallyParent: ledger.tallyParent,
    nature: ledger.nature,
    openingBalanceMinor: ledger.openingBalanceMinor,
    isParty: ledger.isParty,
    isBank: ledger.isBank,
    isTax: ledger.isTax,
    billwise: ledger.billwise,
    archived: ledger.archived,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
  };
}

export function toRustParty(party: Party): RustParty {
  return {
    id: party.id,
    workspaceId: party.workspaceId,
    ledgerId: party.ledgerId,
    name: party.legalName,
    ...optionalField('gstin', party.gstin),
    partyType: party.type,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
  };
}

export function toRustVoucherLine(line: VoucherLine): RustVoucherLine {
  return {
    id: line.id,
    voucherId: line.voucherId,
    workspaceId: line.workspaceId,
    lineNo: line.lineNo,
    ledgerId: line.ledgerId,
    amountMinor: line.amountMinor,
    currency: line.currency,
    ...optionalField('narration', line.narration),
  };
}

export function toRustVoucher(voucher: Voucher, lines: VoucherLine[]): RustNewVoucher {
  const rustVoucher: RustVoucher = {
    id: voucher.id,
    workspaceId: voucher.workspaceId,
    voucherType: voucher.voucherType,
    number: voucher.number,
    date: voucher.date,
    status: voucher.status,
    currency: voucher.currency,
    ...optionalField('partyLedgerId', voucher.partyLedgerId),
    ...optionalField('invoiceNumber', voucher.invoiceNumber),
    ...optionalField('narration', voucher.narration),
    roundOffAmountMinor: voucher.roundOffAmountMinor,
    ...optionalField('roundOffLedgerId', voucher.roundOffLedgerId),
    source: voucher.source,
    createdAt: voucher.createdAt,
    updatedAt: voucher.updatedAt,
  };
  return {
    voucher: rustVoucher,
    lines: lines
      .slice()
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(toRustVoucherLine),
  };
}

function emptyBundle(): ImportBundle {
  return { workspaces: [], companies: [], ledgers: [], parties: [], vouchers: [] };
}

export async function buildImportBundle(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ImportBundle> {
  const [workspace, company, ledgers, parties, vouchers, lines] = await Promise.all([
    db.workspaces.get(workspaceId),
    db.companies.where('workspaceId').equals(workspaceId).first(),
    db.ledgers.where('workspaceId').equals(workspaceId).toArray(),
    db.parties.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
    db.voucherLines.where('workspaceId').equals(workspaceId).toArray(),
  ]);

  const linesByVoucher = new Map<string, VoucherLine[]>();
  for (const line of lines) {
    const list = linesByVoucher.get(line.voucherId) ?? [];
    list.push(line);
    linesByVoucher.set(line.voucherId, list);
  }

  return {
    workspaces: workspace ? [toRustWorkspace(workspace)] : [],
    companies: company ? [toRustCompany(company)] : [],
    ledgers: ledgers.map(toRustLedger),
    parties: parties.map(toRustParty),
    vouchers: vouchers.map((voucher) =>
      toRustVoucher(voucher, linesByVoucher.get(voucher.id) ?? []),
    ),
  };
}

/** Mirror a whole workspace. Safe to re-run; SQLite upserts by id. */
export async function mirrorWorkspace(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<ImportSummary | undefined> {
  if (!isNativeStoreAvailable()) return undefined;
  return nativeStore.importBundle(await buildImportBundle(db, workspaceId));
}

/** Mirror every workspace in the local Dexie cache. */
export async function mirrorAllWorkspaces(
  db: LedgerDatabase,
): Promise<ImportSummary | undefined> {
  if (!isNativeStoreAvailable()) return undefined;
  const workspaces = await db.workspaces.toArray();
  const total: ImportSummary = {
    workspaces: 0,
    companies: 0,
    ledgers: 0,
    parties: 0,
    vouchers: 0,
  };
  for (const workspace of workspaces) {
    const summary = await mirrorWorkspace(db, workspace.id);
    if (!summary) continue;
    total.workspaces += summary.workspaces;
    total.companies += summary.companies;
    total.ledgers += summary.ledgers;
    total.parties += summary.parties;
    total.vouchers += summary.vouchers;
  }
  return total;
}

export type MirrorEntity =
  | { kind: 'workspace'; value: Workspace }
  | { kind: 'company'; value: CompanyProfile }
  | { kind: 'ledger'; value: Ledger }
  | { kind: 'party'; value: Party };

/** Mirror one master-data entity without re-importing the whole workspace. */
export async function mirrorEntity(entity: MirrorEntity): Promise<void> {
  if (!isNativeStoreAvailable()) return;
  const bundle = emptyBundle();
  switch (entity.kind) {
    case 'workspace':
      bundle.workspaces.push(toRustWorkspace(entity.value));
      break;
    case 'company':
      bundle.companies.push(toRustCompany(entity.value));
      break;
    case 'ledger':
      bundle.ledgers.push(toRustLedger(entity.value));
      break;
    case 'party':
      bundle.parties.push(toRustParty(entity.value));
      break;
  }
  await nativeStore.importBundle(bundle);
}

export interface PostedVoucherLike {
  voucher: Voucher;
  lines: VoucherLine[];
}

/**
 * Write a posted or updated voucher to SQLite. If a referenced ledger has not
 * reached SQLite yet, mirror the workspace once and retry.
 */
export async function mirrorPostedVoucher(
  db: LedgerDatabase,
  posted: PostedVoucherLike,
): Promise<void> {
  if (!isNativeStoreAvailable()) return;
  const input = toRustVoucher(posted.voucher, posted.lines);
  try {
    await nativeStore.postVoucher(input);
    return;
  } catch {
    await mirrorWorkspace(db, posted.voucher.workspaceId);
  }
  await nativeStore.postVoucher(input);
}

export async function deleteMirroredEntity(
  entityType: MirrorEntityType,
  entityId: string,
): Promise<void> {
  if (!isNativeStoreAvailable()) return;
  await nativeStore.deleteEntity(entityType, entityId);
}

export interface LedgerVerification {
  ok: boolean;
  issues: string[];
  dexie: TrialBalance;
  sqlite?: TrialBalance;
}

/**
 * Compare the Dexie cache with authoritative SQLite. Used by the engine panel
 * and by tests that guard the migration against drift.
 */
export async function verifyWorkspace(
  db: LedgerDatabase,
  workspaceId: string,
): Promise<LedgerVerification> {
  const dexie = await trialBalance(db, workspaceId);
  if (!isNativeStoreAvailable()) {
    return { ok: dexie.balanced, issues: [], dexie };
  }
  const sqlite = await nativeStore.trialBalance(workspaceId);
  const issues: string[] = [];

  const compare = (label: string, a: number, b: number) => {
    if (a !== b) issues.push(`${label}: Dexie ${a} vs SQLite ${b}`);
  };
  compare('total opening', dexie.totalOpeningMinor, sqlite.totalOpeningMinor);
  compare('total debit', dexie.totalDebitMinor, sqlite.totalDebitMinor);
  compare('total credit', dexie.totalCreditMinor, sqlite.totalCreditMinor);
  if (!dexie.balanced) issues.push('Dexie trial balance is not balanced');
  if (!sqlite.balanced) issues.push('SQLite trial balance is not balanced');

  const localById = new Map(dexie.rows.map((row) => [row.ledgerId, row]));
  for (const row of sqlite.rows) {
    const local = localById.get(row.ledgerId);
    if (!local) {
      issues.push(`ledger ${row.name} is missing from Dexie`);
      continue;
    }
    compare(`ledger ${row.name} closing`, local.closingMinor, row.closingMinor);
    localById.delete(row.ledgerId);
  }
  for (const row of localById.values()) {
    issues.push(`ledger ${row.name} is missing from SQLite`);
  }

  return { ok: issues.length === 0, issues, dexie, sqlite };
}
