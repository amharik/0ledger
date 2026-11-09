import { newId, nowIso } from '../ids';
import { parseAmountToMinor } from '../money/money';
import {
  CostCenterSchema,
  LedgerGroupSchema,
  TALLY_PRIMARY_GROUPS,
  VOUCHER_TYPES,
  type BillAllocationInput,
  type CostCenterAllocationInput,
  type CostCenter,
  type ItemLineInput,
  type Ledger,
  type LedgerGroup,
  type NewVoucherInput,
  type StockItem,
  type TallyPrimaryGroup,
  type TaxAllocationInput,
  type TaxType,
  type VoucherStatus,
  type VoucherType,
} from '../model';
import type { LedgerDatabase } from '../db/db';
import { createLedger } from '../db/ledger-service';
import { createStockItem } from '../db/master-service';
import { markDriveDirty } from '../db/sync-state';
import { postVoucher } from '../ledger/post-voucher';
import { sha256Hex } from '../util/hash';
import { compact } from '../util/objects';
import { attributeValue, tagElements, tagValue } from './xml';

const PRIMARY_SET = new Set<string>(TALLY_PRIMARY_GROUPS);
const VOUCHER_TYPE_SET = new Set<string>(VOUCHER_TYPES);

const VOUCHER_TYPE_ALIASES: Record<string, VoucherType> = {
  'Payment Voucher': 'Payment',
  'Receipt Voucher': 'Receipt',
  'Journal Voucher': 'Journal',
  'Contra Voucher': 'Contra',
  'Sales Voucher': 'Sales',
  'Purchase Voucher': 'Purchase',
};

const DEBIT_PRIMARY_GROUPS = new Set<TallyPrimaryGroup>([
  'Fixed Assets',
  'Current Assets',
  'Investments',
  'Sundry Debtors',
  'Purchase Accounts',
  'Direct Expenses',
  'Indirect Expenses',
  'Bank Accounts',
  'Cash-in-Hand',
  'Branch/Divisions',
  'Miscellaneous Expenses (Asset)',
]);

function parseTallyDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compactDate = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (compactDate) {
    const iso = `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
    return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? undefined : iso;
  }
  const separated = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(value.trim());
  if (separated) {
    const iso = `${separated[3]}-${separated[2]!.padStart(2, '0')}-${separated[1]!.padStart(2, '0')}`;
    return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? undefined : iso;
  }
  return undefined;
}

function quantityValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /-?[\d,]+(?:\.\d+)?/.exec(value);
  return match ? match[0].replace(/,/g, '') : undefined;
}

function amountValue(value: string | undefined, currency: string): number | undefined {
  if (!value || value.trim() === '') return undefined;
  try {
    return parseAmountToMinor(value, currency);
  } catch {
    return undefined;
  }
}

function normalizeVoucherType(value: string | undefined): VoucherType {
  const trimmed = value?.trim();
  if (!trimmed) return 'Journal';
  return VOUCHER_TYPE_SET.has(trimmed) ? (trimmed as VoucherType) : VOUCHER_TYPE_ALIASES[trimmed] ?? 'Journal';
}

function voucherStatus(value: string | undefined): VoucherStatus {
  if (value === 'Yes') return 'cancelled';
  return 'regular';
}

function billType(value: string | undefined): BillAllocationInput['billType'] {
  if (value === 'Against Ref' || value === 'Advance' || value === 'On Account') return value;
  return 'New Ref';
}

export interface TallyImportResult {
  masters: { groups: number; ledgers: number; stockItems: number };
  imported: number;
  skipped: number;
  errors: { voucher?: string | undefined; message: string }[];
  warnings: string[];
}

export async function importTallyXml(
  db: LedgerDatabase,
  workspaceId: string,
  xml: string,
): Promise<TallyImportResult> {
  const workspace = await db.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const company = await db.companies.get(workspace.companyId);
  if (!company) throw new Error(`Company not found for workspace: ${workspaceId}`);
  const currency = company.currency;
  const now = nowIso();
  const result: TallyImportResult = {
    masters: { groups: 0, ledgers: 0, stockItems: 0 },
    imported: 0,
    skipped: 0,
    errors: [],
    warnings: [],
  };

  let groups = await db.ledgerGroups.where('workspaceId').equals(workspaceId).toArray();
  let ledgers = await db.ledgers.where('workspaceId').equals(workspaceId).toArray();
  const stockItems = await db.stockItems.where('workspaceId').equals(workspaceId).toArray();
  const costCenters = await db.costCenters.where('workspaceId').equals(workspaceId).toArray();
  const groupByName = new Map(groups.map((group) => [group.name.trim().toLocaleLowerCase(), group]));
  const ledgerByName = new Map(ledgers.map((ledger) => [ledger.name.trim().toLocaleLowerCase(), ledger]));
  const ledgerById = new Map(ledgers.map((ledger) => [ledger.id, ledger]));
  const stockByName = new Map(stockItems.map((item) => [item.name.trim().toLocaleLowerCase(), item]));
  const costCenterByName = new Map(costCenters.map((item) => [item.name.trim().toLocaleLowerCase(), item]));
  let dirty = false;

  for (const element of tagElements(xml, 'GROUP')) {
    const name = tagValue(element.inner, 'NAME') ?? attributeValue(element.attributes, 'NAME');
    if (!name) continue;
    const key = name.trim().toLocaleLowerCase();
    if (groupByName.has(key)) continue;
    const parentName = tagValue(element.inner, 'PARENT') ?? 'Suspense Account';
    const parentGroup = groupByName.get(parentName.trim().toLocaleLowerCase());
    const primaryGroup: TallyPrimaryGroup = PRIMARY_SET.has(parentName)
      ? (parentName as TallyPrimaryGroup)
      : parentGroup?.primaryGroup ?? 'Suspense Account';
    const primary = groupByName.get(primaryGroup.toLocaleLowerCase());
    const nature = primary?.nature ?? (DEBIT_PRIMARY_GROUPS.has(primaryGroup) ? 'debit' : 'credit');
    const group = LedgerGroupSchema.parse(
      compact({
        id: newId('grp'),
        workspaceId,
        name: name.trim(),
        parentId: parentGroup?.id,
        primaryGroup,
        nature,
        isPrimary: false,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await db.ledgerGroups.add(group);
    groups = [...groups, group];
    groupByName.set(key, group);
    result.masters.groups += 1;
    dirty = true;
  }

  function inferTaxType(name: string): TaxType | undefined {
    const upper = name.toLocaleUpperCase();
    if (upper.includes('CGST')) return 'CGST';
    if (upper.includes('SGST')) return 'SGST';
    if (upper.includes('IGST')) return 'IGST';
    if (upper.includes('CESS')) return 'CESS';
    if (upper.includes('TDS')) return 'TDS';
    if (upper.includes('TCS')) return 'TCS';
    if (upper.includes('VAT')) return 'VAT';
    return undefined;
  }

  async function resolveLedger(name: string, parentOverride?: string): Promise<Ledger | undefined> {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const key = trimmed.toLocaleLowerCase();
    const existing = ledgerByName.get(key);
    if (existing) return existing;
    const parentName = parentOverride ?? 'Suspense Account';
    const group = groupByName.get(parentName.trim().toLocaleLowerCase());
    const taxType = inferTaxType(trimmed);
    const created = await createLedger(db, {
      workspaceId,
      name: trimmed,
      ...(group
        ? { groupId: group.id }
        : {
            tallyParent:
              taxType !== undefined
                ? 'Duties & Taxes'
                : PRIMARY_SET.has(parentName)
                  ? parentName
                  : 'Suspense Account',
          }),
    });
    const ledger = taxType
      ? await db.ledgers
          .update(created.ledger.id, { isTax: true, taxType })
          .then(() => db.ledgers.get(created.ledger.id))
      : created.ledger;
    if (!ledger) return undefined;
    ledgerByName.set(key, ledger);
    ledgerById.set(ledger.id, ledger);
    ledgers = [...ledgers, ledger];
    result.masters.ledgers += 1;
    dirty = true;
    return ledger;
  }

  for (const element of tagElements(xml, 'LEDGER')) {
    const name = tagValue(element.inner, 'NAME') ?? attributeValue(element.attributes, 'NAME');
    if (!name) continue;
    const key = name.trim().toLocaleLowerCase();
    if (ledgerByName.has(key)) continue;
    const parentName = tagValue(element.inner, 'PARENT') ?? 'Suspense Account';
    const group = groupByName.get(parentName.trim().toLocaleLowerCase());
    const opening = amountValue(tagValue(element.inner, 'OPENINGBALANCE'), currency);
    const openingDate = parseTallyDate(tagValue(element.inner, 'OPENINGBALANCE_DATE'));
    const code = tagValue(element.inner, 'LEDGERCODE');
    const created = await createLedger(db, {
      workspaceId,
      name: name.trim(),
      ...(group
        ? { groupId: group.id }
        : { tallyParent: PRIMARY_SET.has(parentName) ? parentName : 'Suspense Account' }),
      ...(code ? { code } : {}),
      ...(opening !== undefined ? { openingBalanceMinor: opening } : {}),
      ...(openingDate ? { openingBalanceDate: openingDate } : {}),
      ...(tagValue(element.inner, 'ISBILLWISEON') === 'Yes' ? { billwise: true } : {}),
    });
    const taxType = inferTaxType(name);
    const gstin = tagValue(element.inner, 'PARTYGSTIN') ?? tagValue(element.inner, 'GSTIN');
    const bankAccountNo = tagValue(element.inner, 'BANKACCOUNTNUMBER');
    const bankIfsc = tagValue(element.inner, 'IFSCODE');
    const bankName = tagValue(element.inner, 'BANKNAME');
    const creditPeriodDays = Number.parseInt(tagValue(element.inner, 'CREDITPERIOD') ?? '', 10);
    const creditLimitMinor = amountValue(tagValue(element.inner, 'CREDITLIMIT'), currency);
    const patch = compact({
      gstin,
      bankAccountNo,
      bankIfsc,
      bankName,
      creditPeriodDays: Number.isFinite(creditPeriodDays) ? creditPeriodDays : undefined,
      creditLimitMinor,
      ...(taxType ? { isTax: true, taxType } : {}),
    });
    const ledger = Object.keys(patch).length > 0
      ? await db.ledgers.update(created.ledger.id, patch).then(() => db.ledgers.get(created.ledger.id))
      : created.ledger;
    if (ledger) {
      ledgerByName.set(key, ledger);
      ledgerById.set(ledger.id, ledger);
      ledgers = [...ledgers.filter((candidate) => candidate.id !== ledger.id), ledger];
    }
    result.masters.ledgers += 1;
    dirty = true;
  }

  for (const element of tagElements(xml, 'STOCKITEM')) {
    const name = tagValue(element.inner, 'NAME') ?? attributeValue(element.attributes, 'NAME');
    if (!name) continue;
    const key = name.trim().toLocaleLowerCase();
    if (stockByName.has(key)) continue;
    const uom = tagValue(element.inner, 'BASEUNITS')?.trim() || 'NOS';
    try {
      const hsnSac = tagValue(element.inner, 'HSNCODE');
      const rateMinor = amountValue(tagValue(element.inner, 'RATE')?.split('/')[0], currency);
      const openingQuantity = quantityValue(tagValue(element.inner, 'OPENINGBALANCE'));
      const openingValueMinor = amountValue(tagValue(element.inner, 'OPENINGVALUE'), currency);
      const item = await createStockItem(db, {
        workspaceId,
        name: name.trim(),
        uom,
        ...(hsnSac ? { hsnSac } : {}),
        ...(rateMinor !== undefined ? { rateMinor } : {}),
        ...(openingQuantity ? { openingQuantity } : {}),
        ...(openingValueMinor !== undefined ? { openingValueMinor } : {}),
      });
      stockByName.set(key, item);
      result.masters.stockItems += 1;
      dirty = true;
    } catch (error) {
      result.warnings.push(
        `Stock item "${name}" skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function resolveCostCenter(name: string): Promise<CostCenter> {
    const trimmed = name.trim();
    const key = trimmed.toLocaleLowerCase();
    const existing = costCenterByName.get(key);
    if (existing) return existing;
    const costCenter = CostCenterSchema.parse({
      id: newId('cc'),
      workspaceId,
      name: trimmed,
      category: 'Primary',
      revenue: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.costCenters.add(costCenter);
    costCenterByName.set(key, costCenter);
    dirty = true;
    return costCenter;
  }

  const existingVouchers = await db.vouchers.where('workspaceId').equals(workspaceId).toArray();
  const sourceRefs = new Set(existingVouchers.flatMap((voucher) => (voucher.sourceRef ? [voucher.sourceRef] : [])));
  const numberKeys = new Set(
    existingVouchers.map((voucher) => `${voucher.voucherType}|${voucher.date}|${voucher.number}`),
  );

  for (const element of tagElements(xml, 'VOUCHER')) {
    const typeName = tagValue(element.inner, 'VOUCHERTYPENAME') ?? attributeValue(element.attributes, 'VCHTYPE');
    const voucherType = normalizeVoucherType(typeName);
    const number = tagValue(element.inner, 'VOUCHERNUMBER')?.trim();
    const date = parseTallyDate(tagValue(element.inner, 'DATE'));
    if (!date) {
      result.errors.push({ voucher: number, message: 'Voucher has an invalid or missing date' });
      continue;
    }
    const partyName = tagValue(element.inner, 'PARTYLEDGERNAME');
    const partyParent =
      voucherType === 'Sales' || voucherType === 'Credit Note'
        ? 'Sundry Debtors'
        : voucherType === 'Purchase' || voucherType === 'Debit Note'
          ? 'Sundry Creditors'
          : undefined;

    try {
      const lines: (NewVoucherInput['lines'][number] & {
        billAllocations: BillAllocationInput[];
        costCenterAllocations: CostCenterAllocationInput[];
      })[] = [];
      for (const entry of tagElements(element.inner, 'ALLLEDGERENTRIES.LIST')) {
        const ledgerName = tagValue(entry.inner, 'LEDGERNAME');
        if (!ledgerName) continue;
        const ledger = await resolveLedger(
          ledgerName,
          partyName && ledgerName.trim().toLocaleLowerCase() === partyName.trim().toLocaleLowerCase()
            ? partyParent
            : undefined,
        );
        if (!ledger) continue;
        const signed = amountValue(tagValue(entry.inner, 'AMOUNT'), currency);
        if (signed === undefined) {
          result.warnings.push(`Voucher ${number ?? '(no number)'}: ledger entry ${ledgerName} has no amount`);
          continue;
        }
        const billAllocations: BillAllocationInput[] = tagElements(entry.inner, 'BILLALLOCATIONS.LIST')
          .map((bill) => {
            const billName = tagValue(bill.inner, 'BILLNAME') ?? tagValue(bill.inner, 'BILLREF');
            const billAmount = amountValue(tagValue(bill.inner, 'AMOUNT'), currency);
            if (!billName || billAmount === undefined) return undefined;
            const dueDate = parseTallyDate(tagValue(bill.inner, 'BILLDATE'));
            return compact({
              billRef: billName,
              billType: billType(tagValue(bill.inner, 'BILLTYPE')),
              amountMinor: Math.abs(billAmount),
              dueDate,
            }) as BillAllocationInput;
          })
          .filter((bill): bill is BillAllocationInput => bill !== undefined);
        const costCenterAllocations: CostCenterAllocationInput[] = [];
        for (const allocation of tagElements(entry.inner, 'COSTCENTREALLOCATIONS.LIST')) {
          const centerName = tagValue(allocation.inner, 'NAME');
          const centerAmount = amountValue(tagValue(allocation.inner, 'AMOUNT'), currency);
          if (!centerName || centerAmount === undefined) continue;
          const center = await resolveCostCenter(centerName);
          costCenterAllocations.push({ costCenterId: center.id, amountMinor: Math.abs(centerAmount) });
        }
        const taxType = ledger.taxType ?? inferTaxType(ledger.name);
        const taxAllocations: TaxAllocationInput[] =
          ledger.isTax && taxType
            ? [{ ledgerId: ledger.id, taxType, amountMinor: Math.abs(signed) }]
            : [];
        const forexAmount = amountValue(tagValue(entry.inner, 'FOREXAMOUNT'), currency);
        const exchangeRate = tagValue(entry.inner, 'EXCHANGERATE');
        lines.push({
          ledgerId: ledger.id,
          amountMinor: signed,
          currency,
          ...(tagValue(entry.inner, 'NARRATION') ? { narration: tagValue(entry.inner, 'NARRATION')! } : {}),
          ...(forexAmount !== undefined ? { forexAmountMinor: forexAmount } : {}),
          ...(exchangeRate ? { exchangeRate } : {}),
          billAllocations,
          costCenterAllocations,
          taxAllocations,
        });
      }

      const items: ItemLineInput[] = [];
      for (const entry of tagElements(element.inner, 'ALLINVENTORYENTRIES.LIST')) {
        const stockName = tagValue(entry.inner, 'STOCKITEMNAME');
        if (!stockName) continue;
        let item = stockByName.get(stockName.trim().toLocaleLowerCase());
        if (!item) {
          try {
            const stockHsn = tagValue(entry.inner, 'HSNCODE');
            item = await createStockItem(db, {
              workspaceId,
              name: stockName.trim(),
              uom: /(?:^|\s)([A-Za-z]{1,8})$/.exec(tagValue(entry.inner, 'ACTUALQTY') ?? '')?.[1] ?? 'NOS',
              ...(stockHsn ? { hsnSac: stockHsn } : {}),
            });
            stockByName.set(stockName.trim().toLocaleLowerCase(), item);
            result.masters.stockItems += 1;
            dirty = true;
          } catch {
            item = undefined;
          }
        }
        const signed = amountValue(tagValue(entry.inner, 'AMOUNT'), currency) ?? 0;
        const quantity = quantityValue(tagValue(entry.inner, 'ACTUALQTY'));
        items.push(
          compact({
            stockItemId: item?.id,
            description: stockName.trim(),
            hsnSac: tagValue(entry.inner, 'HSNCODE') ?? item?.hsnSac,
            quantity,
            uom: item?.uom,
            rateMinor: amountValue(tagValue(entry.inner, 'RATE')?.split('/')[0], currency),
            amountMinor: Math.abs(signed),
            discountMinor: Math.abs(amountValue(tagValue(entry.inner, 'DISCOUNT'), currency) ?? 0),
            direction: tagValue(entry.inner, 'ISDEEMEDPOSITIVE') === 'No' ? 'out' : 'in',
          }) as ItemLineInput,
        );
      }

      if (lines.length < 2) {
        result.errors.push({ voucher: number, message: 'Voucher has fewer than two accounting lines' });
        continue;
      }
      const ref = `tally:${await sha256Hex(
        JSON.stringify({
          date,
          voucherType,
          number,
          narration: tagValue(element.inner, 'NARRATION') ?? '',
          lines: lines.map((line) => [line.ledgerId, line.amountMinor]),
        }),
      )}`;
      if (sourceRefs.has(ref)) {
        result.skipped += 1;
        continue;
      }
      if (number && numberKeys.has(`${voucherType}|${date}|${number}`)) {
        result.skipped += 1;
        continue;
      }
      const partyLedger = partyName ? ledgerByName.get(partyName.trim().toLocaleLowerCase()) : undefined;
      const statusValue = voucherStatus(tagValue(element.inner, 'ISCANCELLED'));
      const effectiveDate = parseTallyDate(tagValue(element.inner, 'EFFECTIVEDATE'));
      const invoiceDate = parseTallyDate(tagValue(element.inner, 'VOUCHERINVOICEDATE'));
      const dueDate = parseTallyDate(tagValue(element.inner, 'DUEDATE'));
      const creditDays = Number.parseInt(tagValue(element.inner, 'CREDITDAYS') ?? '', 10);
      const roundOffLedgerName = tagValue(element.inner, 'ROUNDOFFLEDGERNAME');
      const roundOffLedger = roundOffLedgerName
        ? await resolveLedger(roundOffLedgerName)
        : undefined;
      const roundOffAmount = amountValue(tagValue(element.inner, 'ROUNDOFFAMOUNT'), currency);
      const guid = tagValue(element.inner, 'GUID');
      const masterId = tagValue(element.inner, 'MASTERID');
      const alterId = Number.parseInt(tagValue(element.inner, 'ALTERID') ?? '', 10);
      const base: NewVoucherInput = compact({
        workspaceId,
        voucherType,
        date,
        ...(number ? { number } : {}),
        ...(partyLedger ? { partyLedgerId: partyLedger.id } : {}),
        ...(tagValue(element.inner, 'VOUCHERINVOICENUMBER')
          ? { invoiceNumber: tagValue(element.inner, 'VOUCHERINVOICENUMBER') }
          : {}),
        ...(effectiveDate ? { effectiveDate } : {}),
        ...(invoiceDate ? { invoiceDate } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(Number.isFinite(creditDays) ? { creditDays } : {}),
        ...(roundOffLedger ? { roundOffLedgerId: roundOffLedger.id } : {}),
        ...(tagValue(element.inner, 'REFERENCE') ? { reference: tagValue(element.inner, 'REFERENCE') } : {}),
        ...(tagValue(element.inner, 'NARRATION') ? { narration: tagValue(element.inner, 'NARRATION') } : {}),
        ...(tagValue(element.inner, 'PLACEOFSUPPLY')
          ? { placeOfSupply: tagValue(element.inner, 'PLACEOFSUPPLY') }
          : {}),
        ...(tagValue(element.inner, 'GSTREGISTRATION')
          ? { gstRegistration: tagValue(element.inner, 'GSTREGISTRATION') }
          : {}),
        reverseCharge: tagValue(element.inner, 'REVERSECHARGE') === 'Yes',
        ...(statusValue !== 'regular' ? { status: statusValue } : {}),
        currency,
        source: 'import' as const,
        sourceRef: ref,
        lines,
        items,
        tally: compact({
          guid,
          masterId,
          alterId: Number.isFinite(alterId) ? alterId : undefined,
          roundOffLedgerName,
          roundOffAmountMinor: roundOffAmount,
          extra: { tallyNumber: number },
        }),
      });
      try {
        await postVoucher(db, base);
      } catch (error) {
        if (!number) throw error;
        delete (base as { number?: string }).number;
        await postVoucher(db, base);
        result.warnings.push(
          `Voucher ${number}: kept the Tally number in metadata because the local numbering scheme rejected it`,
        );
      }
      sourceRefs.add(ref);
      result.imported += 1;
    } catch (error) {
      result.errors.push({
        voucher: number,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (dirty) await markDriveDirty(db, workspaceId);
  return result;
}
