import type { LedgerDatabase } from '../db/db';
import type { ItemLine, StockItem, Voucher, VoucherType } from '../model';

export type ValuationMethod = 'fifo' | 'weighted-average' | 'standard-cost';

export interface StockMovement {
  itemLineId: string;
  stockItemId?: string;
  name: string;
  uom: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: VoucherType;
  date: string;
  direction: 'in' | 'out';
  quantity: number;
  rateMinor: number;
  valueMinor: number;
  costMinor: number;
  runningQuantity: number;
  runningValueMinor: number;
}

export interface StockSummaryRow {
  key: string;
  stockItemId?: string;
  name: string;
  uom: string;
  valuationMethod: ValuationMethod;
  openingQuantity: number;
  openingValueMinor: number;
  inwardQuantity: number;
  inwardValueMinor: number;
  outwardQuantity: number;
  outwardCostMinor: number;
  closingQuantity: number;
  closingValueMinor: number;
  warnings: string[];
}

export interface StockReport {
  asOf: string;
  rows: StockSummaryRow[];
  movements: StockMovement[];
  totalClosingValueMinor: number;
  warnings: string[];
}

interface MovementInput {
  line: ItemLine;
  voucher: Voucher;
  direction: 'in' | 'out';
}

interface ItemState {
  key: string;
  stockItem?: StockItem;
  name: string;
  uom: string;
  method: ValuationMethod;
  openingQuantity: number;
  openingValueMinor: number;
  quantity: number;
  valueMinor: number;
  lots: { quantity: number; valueMinor: number }[];
  lastUnitCostMinor: number;
  inwardQuantity: number;
  inwardValueMinor: number;
  outwardQuantity: number;
  outwardCostMinor: number;
  warnings: string[];
}

const INBOUND_TYPES = new Set<VoucherType>([
  'Purchase',
  'Credit Note',
  'Receipt Note',
  'Rejection In',
]);

const OUTBOUND_TYPES = new Set<VoucherType>([
  'Sales',
  'Debit Note',
  'Delivery Note',
  'Rejection Out',
]);

function numericQuantity(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferDirection(line: ItemLine, voucher: Voucher, warnings: string[]): 'in' | 'out' {
  if (line.direction) return line.direction;
  if (INBOUND_TYPES.has(voucher.voucherType)) return 'in';
  if (OUTBOUND_TYPES.has(voucher.voucherType)) return 'out';
  warnings.push(
    `${voucher.voucherType} ${voucher.number} item "${line.description}" has no direction; treated as inward`,
  );
  return 'in';
}

function itemKey(line: ItemLine): string {
  return line.stockItemId
    ? `stock:${line.stockItemId}`
    : `name:${line.description.trim().toLocaleLowerCase()}`;
}

function netInboundValue(line: ItemLine): number {
  if (line.amountMinor !== 0) return Math.max(0, line.amountMinor - line.discountMinor);
  const quantity = numericQuantity(line.quantity);
  if (quantity > 0 && line.rateMinor) return Math.round(quantity * line.rateMinor);
  return 0;
}

function roundedShare(totalMinor: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((totalMinor * part) / whole);
}

function consumeFifo(state: ItemState, quantity: number): number {
  let remaining = quantity;
  let cost = 0;
  while (remaining > 0 && state.lots.length > 0) {
    const lot = state.lots[0]!;
    const taken = Math.min(remaining, lot.quantity);
    const portion = roundedShare(lot.valueMinor, taken, lot.quantity);
    cost += portion;
    lot.quantity -= taken;
    lot.valueMinor -= portion;
    remaining -= taken;
    if (lot.quantity <= 1e-9) state.lots.shift();
  }
  if (remaining > 0) cost += Math.round(remaining * state.lastUnitCostMinor);
  return cost;
}

function consumeAverage(state: ItemState, quantity: number): number {
  const unitCost = state.quantity > 0 ? state.valueMinor / state.quantity : state.lastUnitCostMinor;
  return Math.round(quantity * unitCost);
}

function consumeStandard(state: ItemState, quantity: number): number {
  const unitCost =
    state.stockItem && state.stockItem.rateMinor > 0
      ? state.stockItem.rateMinor
      : state.quantity > 0
        ? state.valueMinor / state.quantity
        : state.lastUnitCostMinor;
  return Math.round(quantity * unitCost);
}

function applyInbound(state: ItemState, quantity: number, valueMinor: number): void {
  state.quantity += quantity;
  if (state.method === 'standard-cost') {
    const unit =
      state.stockItem && state.stockItem.rateMinor > 0
        ? state.stockItem.rateMinor
        : quantity > 0
          ? valueMinor / quantity
          : 0;
    const standardValue = Math.round(quantity * unit);
    state.valueMinor += standardValue;
    state.lastUnitCostMinor = Math.round(unit);
    state.lots.push({ quantity, valueMinor: standardValue });
  } else {
    state.valueMinor += valueMinor;
    state.lots.push({ quantity, valueMinor });
    if (quantity > 0) state.lastUnitCostMinor = Math.round(valueMinor / quantity);
  }
  state.inwardQuantity += quantity;
  state.inwardValueMinor += valueMinor;
}

function applyOutbound(state: ItemState, quantity: number): number {
  const cost =
    state.method === 'fifo'
      ? consumeFifo(state, quantity)
      : state.method === 'standard-cost'
        ? consumeStandard(state, quantity)
        : consumeAverage(state, quantity);
  state.quantity -= quantity;
  state.valueMinor -= cost;
  state.outwardQuantity += quantity;
  state.outwardCostMinor += cost;
  return cost;
}

function stateFor(
  key: string,
  stockItem: StockItem | undefined,
  incoming: ItemLine,
): ItemState {
  const openingQuantity = numericQuantity(stockItem?.openingQuantity);
  const openingValueMinor =
    stockItem?.openingValueMinor ?? (openingQuantity > 0 ? Math.round(openingQuantity * (stockItem?.rateMinor ?? 0)) : 0);
  const method = stockItem?.valuationMethod ?? 'weighted-average';
  return {
    key,
    ...(stockItem ? { stockItem } : {}),
    name: stockItem?.name ?? incoming.description,
    uom: incoming.uom ?? stockItem?.uom ?? 'NOS',
    method,
    openingQuantity,
    openingValueMinor,
    quantity: openingQuantity,
    valueMinor: openingValueMinor,
    lots:
      openingQuantity > 0
        ? [{ quantity: openingQuantity, valueMinor: openingValueMinor }]
        : [],
    lastUnitCostMinor:
      openingQuantity > 0
        ? Math.round(openingValueMinor / openingQuantity)
        : stockItem?.rateMinor ?? 0,
    inwardQuantity: 0,
    inwardValueMinor: 0,
    outwardQuantity: 0,
    outwardCostMinor: 0,
    warnings: [],
  };
}

export interface StockReportOptions {
  asOf?: string;
  stockItemId?: string;
}

export async function stockReport(
  db: LedgerDatabase,
  workspaceId: string,
  options: StockReportOptions = {},
): Promise<StockReport> {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const [stockItems, itemLines, vouchers] = await Promise.all([
    db.stockItems.where('workspaceId').equals(workspaceId).toArray(),
    db.itemLines.where('workspaceId').equals(workspaceId).toArray(),
    db.vouchers.where('workspaceId').equals(workspaceId).toArray(),
  ]);
  const stockItemById = new Map(stockItems.map((item) => [item.id, item]));
  const voucherById = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
  const states = new Map<string, ItemState>();
  const globalWarnings: string[] = [];

  const movements: MovementInput[] = [];
  for (const line of itemLines) {
    const voucher = voucherById.get(line.voucherId);
    if (!voucher || voucher.status !== 'regular' || voucher.date > asOf) continue;
    if (options.stockItemId && line.stockItemId !== options.stockItemId) continue;
    movements.push({
      line,
      voucher,
      direction: inferDirection(line, voucher, globalWarnings),
    });
  }
  movements.sort(
    (a, b) =>
      a.voucher.date.localeCompare(b.voucher.date) ||
      a.voucher.number.localeCompare(b.voucher.number) ||
      a.line.lineNo - b.line.lineNo,
  );

  const output: StockMovement[] = [];
  for (const movement of movements) {
    const { line, voucher, direction } = movement;
    const key = itemKey(line);
    let state = states.get(key);
    if (!state) {
      state = stateFor(key, line.stockItemId ? stockItemById.get(line.stockItemId) : undefined, line);
      states.set(key, state);
    }
    const quantity = Math.abs(numericQuantity(line.quantity));
    if (quantity <= 0) {
      state.warnings.push(
        `${voucher.voucherType} ${voucher.number}: item "${line.description}" has no quantity`,
      );
      continue;
    }
    const rateMinor = line.rateMinor ?? (quantity > 0 ? Math.round(line.amountMinor / quantity) : 0);
    let valueMinor = 0;
    let costMinor = 0;
    if (direction === 'in') {
      valueMinor = netInboundValue(line);
      applyInbound(state, quantity, valueMinor);
    } else {
      costMinor = applyOutbound(state, quantity);
    }
    output.push({
      itemLineId: line.id,
      ...(line.stockItemId ? { stockItemId: line.stockItemId } : {}),
      name: state.name,
      uom: state.uom,
      voucherId: voucher.id,
      voucherNumber: voucher.number,
      voucherType: voucher.voucherType,
      date: voucher.date,
      direction,
      quantity,
      rateMinor,
      valueMinor,
      costMinor,
      runningQuantity: state.quantity,
      runningValueMinor: state.valueMinor,
    });
  }

  for (const state of states.values()) {
    if (state.quantity < -1e-9) {
      state.warnings.push(`${state.name} is oversold by ${Math.abs(state.quantity)} ${state.uom}`);
    }
    if (Math.abs(state.valueMinor) > 0 && state.quantity <= 1e-9) {
      state.warnings.push(`${state.name} has value without quantity (rounding or oversell)`);
    }
  }

  const rows = [...states.values()]
    .map<StockSummaryRow>((state) => ({
      key: state.key,
      ...(state.stockItem ? { stockItemId: state.stockItem.id } : {}),
      name: state.name,
      uom: state.uom,
      valuationMethod: state.method,
      openingQuantity: state.openingQuantity,
      openingValueMinor: state.openingValueMinor,
      inwardQuantity: state.inwardQuantity,
      inwardValueMinor: state.inwardValueMinor,
      outwardQuantity: state.outwardQuantity,
      outwardCostMinor: state.outwardCostMinor,
      closingQuantity: state.quantity,
      closingValueMinor: state.valueMinor,
      warnings: state.warnings,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    asOf,
    rows,
    movements: output,
    totalClosingValueMinor: rows.reduce((sum, row) => sum + row.closingValueMinor, 0),
    warnings: [...globalWarnings, ...rows.flatMap((row) => row.warnings)],
  };
}
