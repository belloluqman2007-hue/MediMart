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
};
/** Movement types that only ever reduce stock. */
export const decreaseMovementTypes = [
  'adjustment_decrease',
  'damaged',
  'expired',
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
    purchaseCostKobo: moneyKobo,
    sellingPriceKobo: moneyKobo,
    reorderLevel: nonNegativeQuantitySchema,
    baseUnitId: uuidSchema,
    isExpiryTracked: z.boolean(),
    status: z.enum(productStatuses).default('active'),
    units: z.array(productUnitInputSchema).max(20).default([]),
  })
  .refine(
    (value) => value.sellingPriceKobo >= value.purchaseCostKobo,
    'The selling price cannot be below the purchase cost.',
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
    sort: z
      .enum([
        'name',
        'createdAt',
        'sellingPriceKobo',
        'purchaseCostKobo',
        'stockQuantity',
        'reorderLevel',
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
