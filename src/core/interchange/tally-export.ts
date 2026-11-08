import { minorToDecimalString } from '../money/money';
import type { BillAllocation, CostCenterAllocation, ItemLine, VoucherLine } from '../model';
import { assertTallyReady } from '../ledger/validation';
import type { WorkbookData } from '../template/data';
import { escapeXml } from './xml';

export interface TallyExportOptions {
  allowIncomplete?: boolean;
}

function tallyDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

function amount(currency: string, minor: number): string {
  return minorToDecimalString(minor, currency);
}

function readinessInput(data: WorkbookData, vouchers = data.vouchers.filter((voucher) => voucher.status === 'regular')) {
  const voucherIds = new Set(vouchers.map((voucher) => voucher.id));
  return {
    company: data.company,
    ledgers: data.ledgers,
    parties: data.parties,
    stockItems: data.stockItems,
    vouchers,
    lines: data.voucherLines.filter((line) => voucherIds.has(line.voucherId)),
    billAllocations: data.billAllocations.filter((allocation) => voucherIds.has(allocation.voucherId)),
    taxAllocations: data.taxAllocations.filter((allocation) => voucherIds.has(allocation.voucherId)),
    numberingSchemes: data.numberingSchemes,
    fyStartMonth: data.company.settings.fyStartMonth,
  };
}

function assertReady(data: WorkbookData, options: TallyExportOptions): void {
  if (options.allowIncomplete) return;
  assertTallyReady(readinessInput(data));
}

function groupXml(data: WorkbookData): string {
  const groups = data.groups.filter((group) => !group.isPrimary);
  return groups
    .map((group) => {
      const parent = group.parentId
        ? data.groups.find((candidate) => candidate.id === group.parentId)?.name ?? group.primaryGroup
        : group.primaryGroup;
      return [
        `<GROUP NAME="${escapeXml(group.name)}" ACTION="Create">`,
        `<NAME>${escapeXml(group.name)}</NAME>`,
        `<PARENT>${escapeXml(parent)}</PARENT>`,
        '</GROUP>',
      ].join('');
    })
    .join('\n');
}

function ledgerMastersXml(data: WorkbookData): string {
  const groupById = new Map(data.groups.map((group) => [group.id, group]));
  return data.ledgers
    .map((ledger) => {
      const parent = ledger.groupId
        ? groupById.get(ledger.groupId)?.name ?? ledger.tallyParent
        : ledger.tallyParent;
      const parts = [
        `<LEDGER NAME="${escapeXml(ledger.name)}" ACTION="Create">`,
        `<NAME>${escapeXml(ledger.name)}</NAME>`,
        `<PARENT>${escapeXml(parent)}</PARENT>`,
        `<ISBILLWISEON>${ledger.billwise ? 'Yes' : 'No'}</ISBILLWISEON>`,
        `<OPENINGBALANCE>${escapeXml(amount(ledger.currency, ledger.openingBalanceMinor))}</OPENINGBALANCE>`,
      ];
      if (ledger.openingBalanceDate) parts.push(`<OPENINGBALANCE_DATE>${tallyDate(ledger.openingBalanceDate)}</OPENINGBALANCE_DATE>`);
      if (ledger.gstin) parts.push(`<PARTYGSTIN>${escapeXml(ledger.gstin)}</PARTYGSTIN>`);
      if (ledger.bankAccountNo) parts.push(`<BANKACCOUNTNUMBER>${escapeXml(ledger.bankAccountNo)}</BANKACCOUNTNUMBER>`);
      if (ledger.bankIfsc) parts.push(`<IFSCODE>${escapeXml(ledger.bankIfsc)}</IFSCODE>`);
      if (ledger.bankName) parts.push(`<BANKNAME>${escapeXml(ledger.bankName)}</BANKNAME>`);
      if (ledger.creditPeriodDays !== undefined) parts.push(`<CREDITPERIOD>${ledger.creditPeriodDays}</CREDITPERIOD>`);
      if (ledger.creditLimitMinor !== undefined) {
        parts.push(`<CREDITLIMIT>${escapeXml(amount(ledger.currency, ledger.creditLimitMinor))}</CREDITLIMIT>`);
      }
      parts.push('</LEDGER>');
      return parts.join('');
    })
    .join('\n');
}

function stockMastersXml(data: WorkbookData): string {
  return data.stockItems
    .map((item) => {
      const parts = [
        `<STOCKITEM NAME="${escapeXml(item.name)}" ACTION="Create">`,
        `<NAME>${escapeXml(item.name)}</NAME>`,
        '<PARENT>Primary</PARENT>',
        `<BASEUNITS>${escapeXml(item.uom)}</BASEUNITS>`,
        `<OPENINGBALANCE>${escapeXml(item.openingQuantity ?? '0')} ${escapeXml(item.uom)}</OPENINGBALANCE>`,
        `<OPENINGVALUE>${escapeXml(amount(data.company.currency, item.openingValueMinor ?? 0))}</OPENINGVALUE>`,
        `<RATE>${escapeXml(amount(data.company.currency, item.rateMinor))}/${escapeXml(item.uom)}</RATE>`,
      ];
      if (item.hsnSac) parts.push(`<HSNCODE>${escapeXml(item.hsnSac)}</HSNCODE>`);
      parts.push('</STOCKITEM>');
      return parts.join('');
    })
    .join('\n');
}

function envelope(data: WorkbookData, reportName: string, body: string): string {
  return [
    '<ENVELOPE>',
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>',
    '<BODY><IMPORTDATA>',
    '<REQUESTDESC>',
    `<REPORTNAME>${reportName}</REPORTNAME>`,
    '<STATICVARIABLES>',
    `<SVCURRENTCOMPANY>${escapeXml(data.company.legalName)}</SVCURRENTCOMPANY>`,
    '</STATICVARIABLES>',
    '</REQUESTDESC>',
    '<REQUESTDATA>',
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    body,
    '</TALLYMESSAGE>',
    '</REQUESTDATA>',
    '</IMPORTDATA></BODY>',
    '</ENVELOPE>',
  ].join('\n');
}

export function exportTallyMasters(
  data: WorkbookData,
  options: TallyExportOptions = {},
): string {
  assertReady(data, options);
  return envelope(
    data,
    'All Masters',
    [groupXml(data), ledgerMastersXml(data), stockMastersXml(data)].filter(Boolean).join('\n'),
  );
}

function ledgerEntryXml(
  data: WorkbookData,
  line: VoucherLine,
  ledgerName: string,
  bills: BillAllocation[],
  costCentres: CostCenterAllocation[],
): string {
  const costCentreById = new Map(data.costCenters.map((costCentre) => [costCentre.id, costCentre]));
  const parts = [
    '<ALLLEDGERENTRIES.LIST>',
    `<LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>${line.amountMinor >= 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${escapeXml(amount(line.currency, line.amountMinor))}</AMOUNT>`,
  ];
  if (line.narration) parts.push(`<NARRATION>${escapeXml(line.narration)}</NARRATION>`);
  for (const bill of bills) {
    parts.push('<BILLALLOCATIONS.LIST>');
    parts.push(`<BILLNAME>${escapeXml(bill.billRef)}</BILLNAME>`);
    parts.push(`<BILLTYPE>${escapeXml(bill.billType)}</BILLTYPE>`);
    parts.push(`<AMOUNT>${escapeXml(amount(data.company.currency, Math.abs(bill.amountMinor)))}</AMOUNT>`);
    if (bill.dueDate) parts.push(`<BILLDATE>${tallyDate(bill.dueDate)}</BILLDATE>`);
    parts.push('</BILLALLOCATIONS.LIST>');
  }
  for (const allocation of costCentres) {
    const costCentre = costCentreById.get(allocation.costCenterId);
    if (!costCentre) continue;
    parts.push('<COSTCENTREALLOCATIONS.LIST>');
    parts.push(`<NAME>${escapeXml(costCentre.name)}</NAME>`);
    parts.push(`<AMOUNT>${escapeXml(amount(data.company.currency, Math.abs(allocation.amountMinor)))}</AMOUNT>`);
    parts.push('</COSTCENTREALLOCATIONS.LIST>');
  }
  parts.push('</ALLLEDGERENTRIES.LIST>');
  return parts.join('');
}

function inventoryEntryXml(data: WorkbookData, item: ItemLine): string {
  const stockItem = item.stockItemId
    ? data.stockItems.find((candidate) => candidate.id === item.stockItemId)
    : undefined;
  const name = stockItem?.name ?? item.description;
  const uom = item.uom ?? stockItem?.uom ?? 'NOS';
  const quantity = item.quantity ?? '0';
  const godown = item.godownId
    ? data.godowns.find((candidate) => candidate.id === item.godownId)
    : undefined;
  const batch = item.batchId ? data.batches.find((candidate) => candidate.id === item.batchId) : undefined;
  const parts = [
    '<ALLINVENTORYENTRIES.LIST>',
    `<STOCKITEMNAME>${escapeXml(name)}</STOCKITEMNAME>`,
    `<ISDEEMEDPOSITIVE>${item.direction === 'out' ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE>`,
    `<RATE>${escapeXml(amount(data.company.currency, item.rateMinor ?? 0))}/${escapeXml(uom)}</RATE>`,
    `<AMOUNT>${escapeXml(amount(data.company.currency, Math.abs(item.amountMinor)))}</AMOUNT>`,
    `<ACTUALQTY>${escapeXml(quantity)} ${escapeXml(uom)}</ACTUALQTY>`,
    `<BILLEDQTY>${escapeXml(quantity)} ${escapeXml(uom)}</BILLEDQTY>`,
  ];
  if (item.hsnSac ?? stockItem?.hsnSac) {
    parts.push(`<HSNCODE>${escapeXml(item.hsnSac ?? stockItem?.hsnSac ?? '')}</HSNCODE>`);
  }
  if (godown) parts.push(`<GODOWNNAME>${escapeXml(godown.name)}</GODOWNNAME>`);
  if (batch) parts.push(`<BATCHNAME>${escapeXml(batch.name)}</BATCHNAME>`);
  if (item.discountMinor !== 0) {
    parts.push(`<DISCOUNT>${escapeXml(amount(data.company.currency, Math.abs(item.discountMinor)))}</DISCOUNT>`);
  }
  parts.push('</ALLINVENTORYENTRIES.LIST>');
  return parts.join('');
}

function voucherXml(data: WorkbookData, voucherId: string): string {
  const voucher = data.vouchers.find((candidate) => candidate.id === voucherId);
  if (!voucher) return '';
  const ledgerById = new Map(data.ledgers.map((ledger) => [ledger.id, ledger]));
  const lines = data.voucherLines
    .filter((line) => line.voucherId === voucher.id)
    .sort((a, b) => a.lineNo - b.lineNo);
  const items = data.itemLines
    .filter((item) => item.voucherId === voucher.id)
    .sort((a, b) => a.lineNo - b.lineNo);
  const bills = data.billAllocations.filter((allocation) => allocation.voucherId === voucher.id);
  const costCentres = data.costCenterAllocations.filter((allocation) => allocation.voucherId === voucher.id);
  const party = voucher.partyLedgerId ? ledgerById.get(voucher.partyLedgerId) : undefined;
  const parts = [
    `<VOUCHER VCHTYPE="${escapeXml(voucher.voucherType)}" ACTION="Create">`,
    `<DATE>${tallyDate(voucher.date)}</DATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucher.voucherType)}</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${escapeXml(voucher.number)}</VOUCHERNUMBER>`,
    `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    `<ISOPTIONAL>${voucher.status === 'optional' ? 'Yes' : 'No'}</ISOPTIONAL>`,
    `<ISCANCELLED>${voucher.status === 'cancelled' ? 'Yes' : 'No'}</ISCANCELLED>`,
  ];
  if (voucher.reference) parts.push(`<REFERENCE>${escapeXml(voucher.reference)}</REFERENCE>`);
  if (voucher.invoiceNumber) parts.push(`<VOUCHERINVOICENUMBER>${escapeXml(voucher.invoiceNumber)}</VOUCHERINVOICENUMBER>`);
  if (party) parts.push(`<PARTYLEDGERNAME>${escapeXml(party.name)}</PARTYLEDGERNAME>`);
  if (voucher.narration) parts.push(`<NARRATION>${escapeXml(voucher.narration)}</NARRATION>`);
  if (voucher.placeOfSupply) parts.push(`<PLACEOFSUPPLY>${escapeXml(voucher.placeOfSupply)}</PLACEOFSUPPLY>`);
  if (voucher.gstRegistration) parts.push(`<GSTREGISTRATION>${escapeXml(voucher.gstRegistration)}</GSTREGISTRATION>`);
  if (voucher.reverseCharge) parts.push('<REVERSECHARGE>Yes</REVERSECHARGE>');

  for (const line of lines) {
    const ledger = ledgerById.get(line.ledgerId);
    const lineBills = bills.filter((bill) => bill.voucherLineId === line.id);
    const lineCostCentres = costCentres.filter((allocation) => allocation.voucherLineId === line.id);
    parts.push(ledgerEntryXml(data, line, ledger?.name ?? line.ledgerId, lineBills, lineCostCentres));
  }
  for (const item of items) parts.push(inventoryEntryXml(data, item));
  parts.push('</VOUCHER>');
  return parts.join('');
}

export function exportTallyVouchers(
  data: WorkbookData,
  options: TallyExportOptions = {},
): string {
  const vouchers = data.vouchers
    .filter((voucher) => (options.allowIncomplete ? true : voucher.status === 'regular'))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  if (!options.allowIncomplete) assertTallyReady(readinessInput(data, vouchers));
  return envelope(data, 'Vouchers', vouchers.map((voucher) => voucherXml(data, voucher.id)).join('\n'));
}

export function exportTallyXml(
  data: WorkbookData,
  options: TallyExportOptions = {},
): string {
  assertReady(data, options);
  const masters = [groupXml(data), ledgerMastersXml(data), stockMastersXml(data)].filter(Boolean).join('\n');
  const vouchers = data.vouchers
    .filter((voucher) => voucher.status === 'regular')
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
    .map((voucher) => voucherXml(data, voucher.id))
    .join('\n');
  return envelope(data, 'All Masters', `${masters}\n${vouchers}`);
}
