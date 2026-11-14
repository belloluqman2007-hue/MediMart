import { z } from 'zod';
import { uuidSchema } from './contracts';

/**
 * Phase 2 inventory contracts.
 *
 * Money is always an integer amount of kobo. Quantities are always integers in a
 * product's base unit, so no floating-point arithmetic is ever used for stock.
 */
export const productTypes = ['medicine', 'foodstuff', 'drinks', 'snacks', 'general'] as const;
export type ProductType = (typeof productTypes)[number];
export const productTypeLabels: Record<ProductType, string> = {
  medicine: 'Medicine',
  foodstuff: 'Foodstuff',
  drinks: 'Drinks',
  snacks: 'Snacks',
  general: 'General merchandise',
};
/**
 * Dosage forms are a closed list so a pharmacy can filter and group reliably. `other` exists for
 * compounded or unusual preparations rather than forcing a wrong choice.
 */
export const dosageForms = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'solution',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'gel',
  'drops',
  'inhaler',
  'suppository',
  'powder',
  'sachet',
  'patch',
  'spray',
  'lozenge',
  'other',
] as const;
export type DosageForm = (typeof dosageForms)[number];
export const dosageFormLabels: Record<DosageForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Syrup',
  suspension: 'Suspension',
  solution: 'Solution',
  injection: 'Injection',
  infusion: 'Infusion',
  cream: 'Cream',
  ointment: 'Ointment',
  gel: 'Gel',
  drops: 'Drops',
  inhaler: 'Inhaler',
  suppository: 'Suppository',
  powder: 'Powder',
  sachet: 'Sachet',
  patch: 'Patch',
  spray: 'Spray',
  lozenge: 'Lozenge',
  other: 'Other preparation',
};
export const productStatuses = ['active', 'inactive'] as const;
export type ProductStatus = (typeof productStatuses)[number];
export const supplierStatuses = ['active', 'inactive'] as const;
export type SupplierStatus = (typeof supplierStatuses)[number];
export const categoryKinds = ['pharmacy', 'mini_mart', 'general'] as const;
export type CategoryKind = (typeof categoryKinds)[number];
export const stockMovementTypes = [
  'opening_stock',
  'stock_received',
  'adjustment_increase',
  'adjustment_decrease',
  'damaged',
  'expired',
  'correction',
  'sale',
  'sale_void',
  'sale_return',
] as const;
export type StockMovementType = (typeof stockMovementTypes)[number];
export const stockMovementLabels: Record<StockMovementType, string> = {
  opening_stock: 'Opening stock',
  stock_received: 'Stock received',
  adjustment_increase: 'Adjustment (increase)',
  adjustment_decrease: 'Adjustment (decrease)',
  damaged: 'Damaged stock',
  expired: 'Expired stock',
  correction: 'Stock correction',
  sale: 'Sale deduction',
  sale_void: 'Voided sale return',
  sale_return: 'Refunded sale return',
};
/** Movement types that only ever reduce stock. */
export const decreaseMovementTypes = [
  'adjustment_decrease',
  'damaged',
  'expired',
  'sale',
] as const satisfies readonly StockMovementType[];
export const adjustmentMovementTypes = [
  'adjustment_increase',
  'adjustment_decrease',
  'damaged',
  'expired',
  'correction',
] as const satisfies readonly StockMovementType[];

export const moneyKobo = z
  .number()
  .int('Enter an amount in whole kobo.')
  .min(0, 'Amount cannot be negative.')
  .max(1_000_000_000_000, 'Amount is too large.');
export const quantitySchema = z
  .number()
  .int('Quantities must be whole numbers.')
  .min(1, 'Quantity must be at least 1.')
  .max(10_000_000, 'Quantity is too large.');
export const nonNegativeQuantitySchema = z.number().int().min(0).max(10_000_000);
export const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Enter a real calendar date.');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
/** Accepts an empty string from a form field as "not provided". */
const optionalUuid = z
  .union([uuidSchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));
const codeSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters.')
  .max(64, 'Use no more than 64 characters.')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dots, dashes, or underscores.');
/** Accepts an empty string or `null` from a form as "not provided". */
const optionalCode = z
  .union([codeSchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

export const productUnitInputSchema = z.strictObject({
  unitId: uuidSchema,
  factor: z
    .number()
    .int('Conversion factors must be whole numbers.')
    .min(1, 'A conversion factor must be at least 1.')
    .max(1_000_000, 'Conversion factor is too large.'),
});
/**
 * `allowBelowCost` is the caller's explicit acknowledgement that the selling price is below the
 * purchase cost. It never grants authority on its own: the API additionally requires the
 * `products.price.below_cost` permission and records the decision in the audit log.
 */
export const productInputSchema = z
  .strictObject({
    name: text(2, 160),
    genericName: optionalText(160),
    brand: optionalText(120),
    sku: optionalCode,
    barcode: optionalCode,
    productType: z.enum(productTypes),
    categoryId: optionalUuid,
    description: optionalText(2000),
    manufacturer: optionalText(160),
    /** Pharmacy identity. Free text would make "500 mg" unfilterable. */
    dosageForm: z
      .union([z.enum(dosageForms), z.literal(''), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    strength: optionalText(60),
    packSize: z
      .union([z.number().int().min(1).max(1_000_000), z.literal(''), z.null()])
      .optional()
      .transform((value) => (value === '' || value === null ? null : (value ?? null))),
    purchaseCostKobo: moneyKobo,
    sellingPriceKobo: moneyKobo,
    reorderLevel: nonNegativeQuantitySchema,
    baseUnitId: uuidSchema,
    isExpiryTracked: z.boolean(),
    status: z.enum(productStatuses).default('active'),
    units: z.array(productUnitInputSchema).max(20).default([]),
    allowBelowCost: z.boolean().default(false),
  })
  .refine(
    (value) => value.allowBelowCost || value.sellingPriceKobo >= value.purchaseCostKobo,
    'The selling price cannot be below the purchase cost without permission.',
  )
  .refine(
    (value) => !value.sku || value.sku.toUpperCase() !== value.barcode?.toUpperCase(),
    'The SKU and barcode cannot be identical.',
  );
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUnitsInputSchema = z.strictObject({
  units: z.array(productUnitInputSchema).max(20).default([]),
});
export type ProductUnitInput = z.infer<typeof productUnitInputSchema>;

export const productListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    type: z.enum(productTypes).optional(),
    status: z.enum(productStatuses).optional(),
    categoryId: uuidSchema.optional(),
    stock: z.enum(['low', 'out', 'in']).optional(),
    dosageForm: z.enum(dosageForms).optional(),
    /**
     * Expiry status is derived from the batch table, never from a cached column, so it cannot drift:
     * `expired` has at least one batch already past its date, `expiring` has stock inside the alert
     * window, `valid` has none of either.
     */
    expiry: z.enum(['expired', 'expiring', 'valid']).optional(),
    sort: z
      .enum([
        'name',
        'createdAt',
        'updatedAt',
        'sellingPriceKobo',
        'purchaseCostKobo',
        'stockQuantity',
        'reorderLevel',
        'nearestExpiryDate',
      ])
      .default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const categoryInputSchema = z.strictObject({
  name: text(2, 80),
  parentId: optionalUuid,
  kind: z.enum(categoryKinds).default('general'),
  description: optionalText(400),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const unitInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters.')
    .max(32, 'Use no more than 32 characters.')
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers, or underscores.'),
  name: text(2, 40),
  symbol: text(1, 12),
});
export type UnitInput = z.infer<typeof unitInputSchema>;

export const supplierInputSchema = z
  .strictObject({
    name: text(2, 120),
    contactPerson: optionalText(120),
    phone: optionalText(40),
    email: z
      .union([z.string().trim().toLowerCase().max(254).pipe(z.email()), z.literal('')])
      .optional()
      .transform((value) => (value ? value : null)),
    address: optionalText(400),
    businessInfo: optionalText(400),
    notes: optionalText(1000),
    status: z.enum(supplierStatuses).default('active'),
  })
  .refine(
    (value) => !value.phone || /^[0-9+()\-.\s]{6,40}$/.test(value.phone),
    'Enter a valid phone number.',
  );
export type SupplierInput = z.infer<typeof supplierInputSchema>;

const operationId = uuidSchema.optional();

export const optionalBatchFields = {
  batchNumber: z
    .union([codeSchema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  manufacturingDate: z
    .union([dateOnlySchema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
  expiryDate: z
    .union([dateOnlySchema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value ? value : null)),
};

export const stockReceiveSchema = z.strictObject({
  productId: uuidSchema,
  quantity: quantitySchema,
  unitId: uuidSchema,
  unitCostKobo: moneyKobo,
  supplierId: optionalUuid,
  reason: text(2, 500),
  referenceId: optionalText(64),
  operationId,
  ...optionalBatchFields,
  movementType: z.enum(['stock_received', 'opening_stock']).default('stock_received'),
});
export type StockReceiveInput = z.infer<typeof stockReceiveSchema>;

export const stockAdjustmentSchema = z
  .strictObject({
    productId: uuidSchema,
    batchId: optionalUuid,
    movementType: z.enum(adjustmentMovementTypes),
    /** Only a stock correction may go in either direction, so it must say which. */
    direction: z.enum(['increase', 'decrease']).optional(),
    quantity: quantitySchema,
    unitId: uuidSchema,
    reason: text(3, 500),
    referenceId: optionalText(64),
    operationId,
  })
  .refine(
    (value) => value.movementType !== 'correction' || Boolean(value.direction),
    'A stock correction must state whether it increases or decreases stock.',
  );
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export const batchListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    productId: uuidSchema.optional(),
    filter: z.enum(['all', 'expiring', 'expired', 'depleted']).default('all'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const movementListQuerySchema = z.strictObject({
  productId: uuidSchema.optional(),
  batchId: uuidSchema.optional(),
  type: z.enum(stockMovementTypes).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const supplierListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    status: z.enum(supplierStatuses).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const inventorySettingsSchema = z.strictObject({
  expiryAlertDays: z
    .number()
    .int()
    .min(1, 'Use at least 1 day.')
    .max(365, 'Use 365 days or fewer.'),
});
export type InventorySettingsInput = z.infer<typeof inventorySettingsSchema>;

export const fefoQuerySchema = z.strictObject({
  quantity: z.coerce.number().int().min(1).max(10_000_000).default(1),
  asOf: dateOnlySchema.optional(),
});

/** Common paginated envelope used by every inventory list endpoint. */
export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type UnitSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  isSystem: boolean;
};

export type CategorySummary = {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  kind: CategoryKind;
  description: string | null;
  productCount: number;
  childCount: number;
};

export type ProductUnitSummary = {
  unitId: string;
  code: string;
  name: string;
  symbol: string;
  factor: number;
};

export type ProductSummary = {
  id: string;
  name: string;
  genericName: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  productType: ProductType;
  /** Pharmacy identity; null for products where the field does not apply. */
  dosageForm: DosageForm | null;
  strength: string | null;
  packSize: number | null;
  categoryId: string | null;
  categoryName: string | null;
  purchaseCostKobo: number;
  sellingPriceKobo: number;
  reorderLevel: number;
  baseUnitId: string;
  baseUnitName: string;
  baseUnitSymbol: string;
  isExpiryTracked: boolean;
  status: ProductStatus;
  stockQuantity: number;
  stockValueCostKobo: number;
  batchCount: number;
  nearestExpiryDate: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  createdByName: string | null;
};

export type BatchSummary = {
  id: string;
  productId: string;
  productName: string;
  batchNumber: string;
  manufacturingDate: string | null;
  expiryDate: string | null;
  quantityReceived: number;
  quantityRemaining: number;
  purchaseCostKobo: number;
  supplierId: string | null;
  supplierName: string | null;
  status: 'active' | 'depleted' | 'expired' | 'expiring';
  recordedAt: string;
  createdBy: string | null;
};

export type ProductDetail = ProductSummary & {
  description: string | null;
  manufacturer: string | null;
  units: ProductUnitSummary[];
  batches: BatchSummary[];
  recentMovements: MovementSummary[];
  stockByBatchQuantity: number;
};

export type MovementSummary = {
  id: string;
  operationId: string | null;
  productId: string;
  productName: string;
  batchId: string | null;
  batchNumber: string | null;
  movementType: StockMovementType;
  quantity: number;
  previousBalance: number;
  newBalance: number;
  unitCostKobo: number | null;
  reason: string;
  referenceId: string | null;
  userId: string | null;
  userName: string | null;
  deviceId: string | null;
  createdAt: string;
};

export type SupplierSummary = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  businessInfo: string | null;
  notes: string | null;
  status: SupplierStatus;
  productCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupplierReceipt = {
  id: string;
  productId: string;
  productName: string;
  batchNumber: string | null;
  quantity: number;
  unitCostKobo: number | null;
  createdAt: string;
  userName: string | null;
};

export type SupplierDetail = SupplierSummary & {
  products: Array<{ id: string; name: string; sku: string | null; stockQuantity: number }>;
  receipts: SupplierReceipt[];
};

export type InventoryDashboard = {
  totalActiveProducts: number;
  totalInactiveProducts: number;
  totalStockQuantity: number;
  stockValueCostKobo: number;
  retailValueKobo: number;
  lowStockCount: number;
  outOfStockCount: number;
  expiredBatchCount: number;
  expiredUnits: number;
  nearExpiryBatchCount: number;
  nearExpiryUnits: number;
  expiryAlertDays: number;
  totalSuppliers: number;
  totalCategories: number;
  recentMovements: MovementSummary[];
  recentlyAddedProducts: ProductSummary[];
  lowStockProducts: Array<{
    id: string;
    name: string;
    stockQuantity: number;
    reorderLevel: number;
    baseUnitSymbol: string;
  }>;
};

export type ReconciliationRow = {
  productId: string;
  productName: string;
  balanceQuantity: number;
  ledgerQuantity: number;
  batchQuantity: number;
  batchTracked: boolean;
  consistent: boolean;
};

export type ReconciliationReport = {
  checkedAt: string;
  productsChecked: number;
  inconsistentCount: number;
  rows: ReconciliationRow[];
};

export type FefoAllocation = {
  productId: string;
  requestedQuantity: number;
  allocatableQuantity: number;
  allocations: Array<{
    batchId: string;
    batchNumber: string;
    expiryDate: string | null;
    quantity: number;
  }>;
};

// --- Bulk catalogue import ---------------------------------------------------
/**
 * Import is deliberately staged: the same request evaluates every row, reports what would happen,
 * and only a non-preview request writes. Rows are matched on SKU, then barcode, then the exact
 * name plus strength, so re-importing a corrected spreadsheet updates instead of duplicating.
 */
export const productImportRowSchema = z.object({
  /**
   * Structural limits only. Semantic validation (length, known vocabulary, prices) happens in the
   * importer so one bad row is *reported* with its row number instead of rejecting the whole sheet
   * with a field error the shopkeeper cannot map back to a line in their spreadsheet.
   */
  name: z.string().max(400).default(''),
  genericName: z.string().trim().max(160).optional(),
  brand: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(64).optional(),
  barcode: z.string().trim().max(64).optional(),
  productType: z.string().trim().max(40).optional(),
  category: z.string().trim().max(120).optional(),
  dosageForm: z.string().trim().max(40).optional(),
  strength: z.string().trim().max(60).optional(),
  packSize: z.string().trim().max(12).optional(),
  manufacturer: z.string().trim().max(160).optional(),
  purchaseCostKobo: z.string().trim().max(20).optional(),
  sellingPriceKobo: z.string().trim().max(20).optional(),
  reorderLevel: z.string().trim().max(12).optional(),
  baseUnit: z.string().trim().max(40).optional(),
  /** `yes`/`no`; defaults to yes for medicines. */
  expiryTracked: z.string().trim().max(8).optional(),
  status: z.string().trim().max(12).optional(),
});
export type ProductImportRowInput = z.infer<typeof productImportRowSchema>;

export const productImportRequestSchema = z.strictObject({
  rows: z.array(productImportRowSchema).min(1).max(5000),
  /** When true nothing is written; the caller gets the same report. */
  preview: z.boolean().default(true),
  /** Repeat submissions of the same key return the original run. */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  fileName: z.string().trim().max(160).optional(),
  /** Update rows that match an existing product instead of skipping them. */
  updateExisting: z.boolean().default(false),
});

export type ProductImportIssue = {
  row: number;
  field: string;
  message: string;
  severity: 'error' | 'warning';
};
export type ProductImportRowResult = {
  row: number;
  name: string;
  action: 'create' | 'update' | 'skip' | 'error';
  productId: string | null;
  matchedOn: 'sku' | 'barcode' | 'name' | null;
  messages: string[];
};
export type ProductImportReport = {
  id: string | null;
  preview: boolean;
  totalRows: number;
  createCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  issues: ProductImportIssue[];
  rows: ProductImportRowResult[];
  /** True when nothing was written because the run contained errors. */
  blocked: boolean;
  createdAt: string | null;
};

/**
 * A stored import run, as returned by the history endpoint. Field names mirror the API response
 * exactly; the wizard previously guessed them and silently rendered blank cells.
 */
export type ProductImportRun = {
  id: string;
  fileName: string | null;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  dryRun: boolean;
  status: string;
  createdAt: string;
  createdByName: string | null;
};

/** The column headers the parser accepts, in the order it suggests them. */
export const productImportColumns = [
  'name',
  'genericName',
  'brand',
  'sku',
  'barcode',
  'productType',
  'category',
  'dosageForm',
  'strength',
  'packSize',
  'manufacturer',
  'purchaseCostKobo',
  'sellingPriceKobo',
  'reorderLevel',
  'baseUnit',
  'expiryTracked',
  'status',
] as const;
export const productImportTemplate = [
  'name,genericName,brand,sku,barcode,productType,category,dosageForm,strength,packSize,manufacturer,purchaseCostKobo,sellingPriceKobo,reorderLevel,baseUnit,expiryTracked,status',
  'Paracetamol 500 mg Tablet,Paracetamol,Emzor,PCM-500-EMZ,6151100010019,medicine,Analgesics,tablet,500 mg,10,Emzor,50.00,100.00,20,tablet,yes,active',
  'Amoxicillin 250 mg Capsule,Amoxicillin,,AMX-250,,medicine,Antibiotics,capsule,250 mg,10,,120.00,220.00,15,capsule,yes,active',
].join('\n');

// --- Clinical addenda --------------------------------------------------------
/**
 * A saved clinical note is never rewritten. A correction is a separate, attributed, dated entry
 * that cites the record it amends, mirroring the append-only discipline of the stock ledger.
 */
export const clinicalAddendumSchema = z.strictObject({
  entityType: z.enum(['consultation', 'prescription', 'patient']),
  entityId: uuidSchema,
  body: z.string().trim().min(3, 'Describe the correction.').max(4000),
  reason: z.string().trim().min(3, 'State why the record is being amended.').max(500),
});
export type ClinicalAddendumInput = z.infer<typeof clinicalAddendumSchema>;
export type ClinicalAddendum = ClinicalAddendumInput & {
  id: string;
  patientId: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
};
