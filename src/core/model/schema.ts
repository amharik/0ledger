import { z } from 'zod';
import {
  BILL_TYPES,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
  LEDGER_NATURES,
  MATCH_STATUSES,
  NUMBERING_RESET_PERIODS,
  PARTY_TYPES,
  RECONCILIATION_METHODS,
  RECONCILIATION_STATUSES,
  ROUNDING_MODES,
  TALLY_PRIMARY_GROUPS,
  TAX_ROUNDING_LEVELS,
  TAX_TYPES,
  VOUCHER_SOURCES,
  VOUCHER_STATUSES,
  VOUCHER_TYPES,
} from './enums';

export { type VoucherType, VOUCHER_TYPES } from './enums';

export const entityId = z
  .string()
  .regex(
    /^[a-z]{2,6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid entity id',
  );

export const minorAmount = z.number().int().refine(Number.isSafeInteger, 'Unsafe integer amount');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const isoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'Expected ISO-8601 timestamp',
  );

export const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/, 'Expected decimal string');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Expected ISO-4217 currency code');

export const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected lowercase slug');

export const shortText = z.string().min(1).max(256);
export const longText = z.string().max(4000);
export const optionalText = z.string().max(2048).optional();

export const RoundingModeSchema = z.enum(ROUNDING_MODES);
export const TaxRoundingLevelSchema = z.enum(TAX_ROUNDING_LEVELS);
export const LedgerNatureSchema = z.enum(LEDGER_NATURES);
export const TallyPrimaryGroupSchema = z.enum(TALLY_PRIMARY_GROUPS);
export const VoucherTypeSchema = z.enum(VOUCHER_TYPES);
export const VoucherStatusSchema = z.enum(VOUCHER_STATUSES);
export const VoucherSourceSchema = z.enum(VOUCHER_SOURCES);
export const BillTypeSchema = z.enum(BILL_TYPES);
export const TaxTypeSchema = z.enum(TAX_TYPES);
export const PartyTypeSchema = z.enum(PARTY_TYPES);
export const NumberingResetPeriodSchema = z.enum(NUMBERING_RESET_PERIODS);

export const TimestampedSchema = z.object({
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const CompanySettingsSchema = z
  .object({
    fyStartMonth: z.number().int().min(1).max(12).default(4),
    roundToMinor: z.number().int().positive().default(1),
    roundingMode: RoundingModeSchema.default('half-up'),
    taxRoundingLevel: TaxRoundingLevelSchema.default('invoice'),
    decimalPlaces: z.number().int().min(0).max(6).default(2),
    defaultCurrency: currencyCode.default('INR'),
  })
  .strict();

export const CompanyProfileSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    legalName: shortText,
    tradeName: shortText.optional(),
    gstin: z
      .string()
      .regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 characters')
      .optional(),
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
      .optional(),
    state: shortText.optional(),
    pincode: z.string().regex(/^\d{6}$/).optional(),
    address: longText.optional(),
    country: z.string().length(2).default('IN'),
    currency: currencyCode.default('INR'),
    booksBegin: isoDate,
    settings: CompanySettingsSchema,
  })
  .merge(TimestampedSchema)
  .strict();

export const WorkspaceSchema = z
  .object({
    id: entityId,
    slug,
    name: shortText,
    readableName: shortText,
    companyId: entityId,
    archived: z.boolean().default(false),
  })
  .merge(TimestampedSchema)
  .strict();

export const LedgerGroupSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    name: shortText,
    parentId: entityId.optional(),
    primaryGroup: TallyPrimaryGroupSchema,
    nature: LedgerNatureSchema,
    isPrimary: z.boolean().default(false),
  })
  .merge(TimestampedSchema)
  .strict();

export const LedgerSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    code: z.string().max(32).optional(),
    name: shortText,
    readableName: shortText.optional(),
    groupId: entityId.optional(),
    tallyParent: TallyPrimaryGroupSchema,
    nature: LedgerNatureSchema,
    isParty: z.boolean().default(false),
    isBank: z.boolean().default(false),
    isCash: z.boolean().default(false),
    isTax: z.boolean().default(false),
    isSystem: z.boolean().default(false),
    openingBalanceMinor: minorAmount.default(0),
    openingBalanceDate: isoDate.optional(),
    currency: currencyCode.default('INR'),
    billwise: z.boolean().default(false),
    costCenterApplicable: z.boolean().default(false),
    gstin: z.string().max(15).optional(),
    bankAccountNo: z.string().max(34).optional(),
    bankIfsc: z.string().max(11).optional(),
    bankName: shortText.optional(),
    creditPeriodDays: z.number().int().nonnegative().optional(),
    creditLimitMinor: minorAmount.optional(),
    taxType: TaxTypeSchema.optional(),
    archived: z.boolean().default(false),
    notes: longText.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const PartySchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    ledgerId: entityId,
    type: PartyTypeSchema,
    legalName: shortText,
    gstin: z.string().max(15).optional(),
    gstRegistrationType: z.string().max(64).optional(),
    billingAddress: longText.optional(),
    shippingAddress: longText.optional(),
    state: shortText.optional(),
    pincode: z.string().max(10).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(20).optional(),
    creditPeriodDays: z.number().int().nonnegative().optional(),
    creditLimitMinor: minorAmount.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const StockItemSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    name: shortText,
    hsnSac: z.string().max(16).optional(),
    uom: z.string().min(1).max(16).default('NOS'),
    rateMinor: minorAmount.default(0),
    taxRate: decimalString.optional(),
    openingQuantity: decimalString.optional(),
    openingValueMinor: minorAmount.optional(),
    valuationMethod: z.enum(['fifo', 'weighted-average', 'standard-cost']).optional(),
    archived: z.boolean().default(false),
  })
  .merge(TimestampedSchema)
  .strict();

export const GodownSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    name: shortText,
    parentId: entityId.optional(),
    archived: z.boolean().default(false),
  })
  .merge(TimestampedSchema)
  .strict();

export const BatchSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    stockItemId: entityId,
    name: shortText,
    expiryDate: isoDate.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const CostCenterSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    name: shortText,
    category: shortText.default('Primary'),
    parentId: entityId.optional(),
    revenue: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .merge(TimestampedSchema)
  .strict();

export const NumberingSchemeSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    voucherType: VoucherTypeSchema,
    name: shortText,
    prefix: z.string().max(32).default(''),
    suffix: z.string().max(32).default(''),
    separator: z.string().max(4).default('/'),
    padding: z.number().int().min(1).max(12).default(4),
    nextNumber: z.number().int().positive().default(1),
    startNumber: z.number().int().positive().default(1),
    resetPeriod: NumberingResetPeriodSchema.default('fy'),
    currentPeriodKey: z.string().max(32).optional(),
    allowManualOverride: z.boolean().default(true),
    enforceUnique: z.boolean().default(true),
    allowGaps: z.boolean().default(true),
  })
  .merge(TimestampedSchema)
  .strict();

export const TallyFieldsSchema = z
  .object({
    guid: z.string().max(64).optional(),
    masterId: z.string().max(64).optional(),
    alterId: z.number().int().nonnegative().optional(),
    voucherTypeName: z.string().max(64).optional(),
    numberingMethod: z.string().max(32).optional(),
    roundOffLedgerName: z.string().max(128).optional(),
    roundOffAmountMinor: minorAmount.optional(),
    partyGstin: z.string().max(15).optional(),
    auditPeriod: z.string().max(32).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const BillAllocationInputSchema = z
  .object({
    billRef: z.string().min(1).max(128),
    billType: BillTypeSchema,
    amountMinor: minorAmount,
    dueDate: isoDate.optional(),
    creditDays: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CostCenterAllocationInputSchema = z
  .object({
    costCenterId: entityId,
    amountMinor: minorAmount,
  })
  .strict();

export const TaxAllocationInputSchema = z
  .object({
    ledgerId: entityId.optional(),
    taxType: TaxTypeSchema,
    amountMinor: minorAmount,
    taxableValueMinor: minorAmount.optional(),
    rate: decimalString.optional(),
    hsnSac: z.string().max(16).optional(),
    tdsSection: z.string().max(16).optional(),
    tdsRate: decimalString.optional(),
    tdsAmountMinor: minorAmount.optional(),
  })
  .strict();

export const VoucherLineInputSchema = z
  .object({
    lineNo: z.number().int().positive().optional(),
    ledgerId: entityId,
    amountMinor: minorAmount,
    currency: currencyCode.default('INR'),
    forexAmountMinor: minorAmount.optional(),
    exchangeRate: decimalString.optional(),
    narration: longText.optional(),
    hsnSac: z.string().max(16).optional(),
    billAllocations: z.array(BillAllocationInputSchema).default([]),
    costCenterAllocations: z.array(CostCenterAllocationInputSchema).default([]),
    taxAllocations: z.array(TaxAllocationInputSchema).default([]),
  })
  .strict();

export const ItemLineInputSchema = z
  .object({
    lineNo: z.number().int().positive().optional(),
    stockItemId: entityId.optional(),
    description: shortText,
    hsnSac: z.string().max(16).optional(),
    quantity: decimalString.optional(),
    uom: z.string().max(16).optional(),
    rateMinor: minorAmount.optional(),
    amountMinor: minorAmount,
    discountMinor: minorAmount.default(0),
    godownId: entityId.optional(),
    batchId: entityId.optional(),
    direction: z.enum(['in', 'out']).optional(),
  })
  .strict();

export const VoucherSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    voucherType: VoucherTypeSchema,
    number: z.string().min(1).max(64),
    numberingSchemeId: entityId.optional(),
    date: isoDate,
    effectiveDate: isoDate.optional(),
    invoiceNumber: z.string().max(64).optional(),
    invoiceDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    creditDays: z.number().int().nonnegative().optional(),
    partyLedgerId: entityId.optional(),
    reference: z.string().max(256).optional(),
    narration: longText.optional(),
    placeOfSupply: z.string().max(64).optional(),
    gstRegistration: z.string().max(64).optional(),
    reverseCharge: z.boolean().default(false),
    status: VoucherStatusSchema.default('regular'),
    currency: currencyCode.default('INR'),
    totalDebitMinor: minorAmount.default(0),
    totalCreditMinor: minorAmount.default(0),
    roundOffAmountMinor: minorAmount.default(0),
    roundOffLedgerId: entityId.optional(),
    source: VoucherSourceSchema.default('manual'),
    sourceRef: z.string().max(512).optional(),
    groupIds: z.array(entityId).default([]),
    accountingId: z.string().max(128).optional(),
    tags: z.array(z.string().max(64)).default([]),
    tally: TallyFieldsSchema.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const NewVoucherSchema = z
  .object({
    workspaceId: entityId,
    voucherType: VoucherTypeSchema,
    number: z.string().min(1).max(64).optional(),
    numberingSchemeId: entityId.optional(),
    date: isoDate,
    effectiveDate: isoDate.optional(),
    invoiceNumber: z.string().max(64).optional(),
    invoiceDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    creditDays: z.number().int().nonnegative().optional(),
    partyLedgerId: entityId.optional(),
    reference: z.string().max(256).optional(),
    narration: longText.optional(),
    placeOfSupply: z.string().max(64).optional(),
    gstRegistration: z.string().max(64).optional(),
    reverseCharge: z.boolean().default(false),
    status: VoucherStatusSchema.default('regular'),
    currency: currencyCode.default('INR'),
    roundOffLedgerId: entityId.optional(),
    source: VoucherSourceSchema.default('manual'),
    sourceRef: z.string().max(512).optional(),
    groupIds: z.array(entityId).default([]),
    accountingId: z.string().max(128).optional(),
    tags: z.array(z.string().max(64)).default([]),
    lines: z.array(VoucherLineInputSchema).min(2),
    items: z.array(ItemLineInputSchema).default([]),
    tally: TallyFieldsSchema.optional(),
  })
  .strict();

export const VoucherLineSchema = z
  .object({
    id: entityId,
    voucherId: entityId,
    workspaceId: entityId,
    lineNo: z.number().int().positive(),
    ledgerId: entityId,
    amountMinor: minorAmount,
    currency: currencyCode.default('INR'),
    forexAmountMinor: minorAmount.optional(),
    exchangeRate: decimalString.optional(),
    narration: longText.optional(),
    hsnSac: z.string().max(16).optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const ItemLineSchema = z
  .object({
    id: entityId,
    voucherId: entityId,
    workspaceId: entityId,
    lineNo: z.number().int().positive(),
    stockItemId: entityId.optional(),
    description: shortText,
    hsnSac: z.string().max(16).optional(),
    quantity: decimalString.optional(),
    uom: z.string().max(16).optional(),
    rateMinor: minorAmount.optional(),
    amountMinor: minorAmount,
    discountMinor: minorAmount.default(0),
    godownId: entityId.optional(),
    batchId: entityId.optional(),
    direction: z.enum(['in', 'out']).optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const BillAllocationSchema = BillAllocationInputSchema.merge(
  z.object({
    id: entityId,
    workspaceId: entityId,
    voucherId: entityId,
    voucherLineId: entityId,
    ledgerId: entityId,
  }),
).merge(TimestampedSchema);

export const CostCenterAllocationSchema = CostCenterAllocationInputSchema.merge(
  z.object({
    id: entityId,
    workspaceId: entityId,
    voucherId: entityId,
    voucherLineId: entityId,
  }),
).merge(TimestampedSchema);

export const TaxAllocationSchema = TaxAllocationInputSchema.merge(
  z.object({
    id: entityId,
    workspaceId: entityId,
    voucherId: entityId,
    voucherLineId: entityId.optional(),
  }),
).merge(TimestampedSchema);

export const AttachmentSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    voucherId: entityId.optional(),
    fileName: shortText,
    mimeType: z.string().max(128),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    storageKey: z.string().max(512),
  })
  .merge(TimestampedSchema)
  .strict();

export const ImportBatchSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    source: z.enum(IMPORT_SOURCES),
    fileName: z.string().max(512).optional(),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    adapterId: z.string().max(128).optional(),
    adapterVersion: z.string().max(32).optional(),
    status: z.enum(IMPORT_STATUSES).default('staged'),
    totalLines: z.number().int().nonnegative().default(0),
    committedLines: z.number().int().nonnegative().default(0),
    failedLines: z.number().int().nonnegative().default(0),
    error: longText.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const StatementLineSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    importBatchId: entityId,
    accountId: entityId.optional(),
    lineNo: z.number().int().nonnegative(),
    date: isoDate,
    valueDate: isoDate.optional(),
    description: z.string().max(1024),
    reference: z.string().max(256).optional(),
    debitMinor: minorAmount.default(0),
    creditMinor: minorAmount.default(0),
    balanceMinor: minorAmount.optional(),
    currency: currencyCode.default('INR'),
    raw: z.record(z.string(), z.unknown()).optional(),
    matchStatus: z.enum(MATCH_STATUSES).default('unmatched'),
    matchedVoucherId: entityId.optional(),
    matchConfidence: z.number().min(0).max(1).optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const ReconciliationSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    statementLineId: entityId,
    voucherId: entityId,
    amountMinor: minorAmount,
    method: z.enum(RECONCILIATION_METHODS).default('manual'),
    status: z.enum(RECONCILIATION_STATUSES).default('confirmed'),
    confidence: z.number().min(0).max(1).default(1),
    note: longText.optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export const AuditEventSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    entityType: z.string().max(64),
    entityId: entityId.or(z.string().max(128)),
    action: z.enum(['create', 'update', 'delete', 'void', 'restore', 'import', 'export', 'sync']),
    at: isoTimestamp,
    actor: z.string().max(128).optional(),
    beforeHash: z.string().max(128).optional(),
    afterHash: z.string().max(128).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const DriveLinkSchema = z
  .object({
    id: entityId,
    workspaceId: entityId,
    fileId: z.string().min(1).max(256),
    fileName: shortText,
    mimeType: z.string().max(128),
    kind: z.enum(['sheets', 'xlsx']),
    lastSyncedAt: isoTimestamp.optional(),
    lastModifiedAt: isoTimestamp.optional(),
    contentHash: z.string().max(128).optional(),
  })
  .merge(TimestampedSchema)
  .strict();

export type CompanySettings = z.infer<typeof CompanySettingsSchema>;
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type LedgerGroup = z.infer<typeof LedgerGroupSchema>;
export type Ledger = z.infer<typeof LedgerSchema>;
export type Party = z.infer<typeof PartySchema>;
export type StockItem = z.infer<typeof StockItemSchema>;
export type Godown = z.infer<typeof GodownSchema>;
export type Batch = z.infer<typeof BatchSchema>;
export type CostCenter = z.infer<typeof CostCenterSchema>;
export type NumberingScheme = z.infer<typeof NumberingSchemeSchema>;
export type TallyFields = z.infer<typeof TallyFieldsSchema>;
export type BillAllocationInput = z.infer<typeof BillAllocationInputSchema>;
export type BillAllocation = z.infer<typeof BillAllocationSchema>;
export type CostCenterAllocationInput = z.infer<typeof CostCenterAllocationInputSchema>;
export type CostCenterAllocation = z.infer<typeof CostCenterAllocationSchema>;
export type TaxAllocationInput = z.infer<typeof TaxAllocationInputSchema>;
export type TaxAllocation = z.infer<typeof TaxAllocationSchema>;
export type VoucherLineInput = z.infer<typeof VoucherLineInputSchema>;
export type ItemLineInput = z.infer<typeof ItemLineInputSchema>;
export type NewVoucher = z.infer<typeof NewVoucherSchema>;
export type NewVoucherInput = z.input<typeof NewVoucherSchema>;
export type Voucher = z.infer<typeof VoucherSchema>;
export type VoucherLine = z.infer<typeof VoucherLineSchema>;
export type ItemLine = z.infer<typeof ItemLineSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type ImportBatch = z.infer<typeof ImportBatchSchema>;
export type Reconciliation = z.infer<typeof ReconciliationSchema>;
export type StatementLine = z.infer<typeof StatementLineSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type DriveLink = z.infer<typeof DriveLinkSchema>;
