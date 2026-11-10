import { z } from 'zod';
import { dateOnlySchema, moneyKobo, quantitySchema } from './inventory';
import { paymentMethods } from './sales';
import { uuidSchema } from './contracts';

/**
 * Phase 6 — offline capture and synchronization contracts.
 *
 * An *offline* record is a business intention captured on an Android device while the central
 * server was unreachable. It is NOT a second source of truth: the central server validates every
 * record with the same service functions used by an online request and records the authoritative
 * result in `sync_receipts`. Replays are answered from that receipt and never applied twice.
 *
 * `clientCreatedAt`/`clientDate` exist only so the shop keeps the clerk's real date. Their
 * acceptance window is bounded server-side, so a device clock cannot backdate financial records.
 */

export const allowedOfflineSkewMs = 72 * 60 * 60 * 1000;

export const offlineRecordTypes = [
  'sale',
  'customer',
  'customer_repayment',
  'stock_receipt',
  'purchase_order',
  'expense',
] as const;
export type OfflineRecordType = (typeof offlineRecordTypes)[number];

export const offlineRecordTypeLabels: Record<OfflineRecordType, string> = {
  sale: 'Shop sale',
  customer: 'Customer record',
  customer_repayment: 'Debt repayment',
  stock_receipt: 'Stock receipt',
  purchase_order: 'Purchase order',
  expense: 'Expense',
};

/** Schema versions let a future server reject records it cannot interpret safely. */
export const OFFLINE_SCHEMA_VERSION = 1;
export const SYNC_PROTOCOL_VERSION = 1;

const isoDateTime = z.string().datetime({ offset: true });

export const offlineSaleLineSchema = z.strictObject({
  productId: uuidSchema,
  unitId: uuidSchema,
  quantity: quantitySchema,
  lineDiscountKobo: moneyKobo.default(0),
});
export type OfflineSaleLine = z.infer<typeof offlineSaleLineSchema>;

export const offlineSalePaymentSchema = z.strictObject({
  method: z.enum(paymentMethods),
  amountKobo: z.number().int('Enter an amount in whole kobo.').min(1).max(1_000_000_000_000),
  reference: z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
});
export type OfflineSalePayment = z.infer<typeof offlineSalePaymentSchema>;

/** A customer may be created offline; the server assigns the authoritative code. */
export const offlineCustomerDraftSchema = z.strictObject({
  localId: uuidSchema,
  fullName: z.string().trim().min(2).max(160),
  phone: z
    .string()
    .trim()
    .max(40)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  address: z
    .string()
    .trim()
    .max(300)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  creditLimitKobo: moneyKobo.optional(),
});
export type OfflineCustomerDraft = z.infer<typeof offlineCustomerDraftSchema>;

const salePayload = z.strictObject({
  customerId: uuidSchema.nullable().default(null),
  customerDraft: offlineCustomerDraftSchema.nullable().default(null),
  items: z.array(offlineSaleLineSchema).min(1).max(100),
  cartDiscountKobo: moneyKobo.default(0),
  discountReason: z.string().trim().max(300).nullable().default(null),
  payments: z.array(offlineSalePaymentSchema).max(10).default([]),
  dueDate: dateOnlySchema.nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
});

/** Direct stock receipt. The central server still applies its own batch and ledger rules. */
export const offlineStockReceiptSchema = z.strictObject({
  productId: uuidSchema,
  quantity: quantitySchema,
  unitId: uuidSchema.optional(),
  batchNumber: z.string().trim().max(60).nullable().default(null),
  expiryDate: dateOnlySchema.nullable().default(null),
  manufacturingDate: dateOnlySchema.nullable().default(null),
  unitCostKobo: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  supplierId: uuidSchema.nullable().default(null),
  reason: z.string().trim().min(3).max(300),
});
export type OfflineStockReceipt = z.infer<typeof offlineStockReceiptSchema>;

export const offlinePurchaseLineSchema = z.strictObject({
  productId: uuidSchema,
  unitId: uuidSchema,
  quantity: quantitySchema,
  unitCostKobo: z.number().int().min(0).max(1_000_000_000_000),
  lineDiscountKobo: moneyKobo.default(0),
});
export const offlinePurchaseOrderSchema = z.strictObject({
  supplierId: uuidSchema,
  items: z.array(offlinePurchaseLineSchema).min(1).max(100),
  orderDiscountKobo: moneyKobo.default(0),
  discountReason: z.string().trim().max(300).nullable().default(null),
  additionalChargesKobo: moneyKobo.default(0),
  additionalChargesReason: z.string().trim().max(300).nullable().default(null),
  expectedDeliveryDate: dateOnlySchema.nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type OfflinePurchaseOrder = z.infer<typeof offlinePurchaseOrderSchema>;

export const offlineExpenseSchema = z.strictObject({
  categoryId: uuidSchema,
  description: z.string().trim().min(3).max(500),
  amountKobo: z.number().int().min(1).max(1_000_000_000_000),
  paymentMethod: z.enum(paymentMethods),
  expenseDate: dateOnlySchema,
  payee: z.string().trim().max(160).nullable().default(null),
  reference: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type OfflineExpense = z.infer<typeof offlineExpenseSchema>;

const customerPayload = z.strictObject({
  customer: offlineCustomerDraftSchema,
});

const repaymentPayload = z.strictObject({
  customerId: uuidSchema,
  amountKobo: z.number().int().min(1).max(1_000_000_000_000),
  method: z.enum(paymentMethods),
  reference: z.string().trim().max(100).nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
});

export const offlineRecordSchema = z.discriminatedUnion('recordType', [
  z.strictObject({
    recordType: z.literal('sale'),
    payload: salePayload,
    /** Set when a refund/void happened offline; refused server-side, never silently dropped. */
    requiresOnlineReview: z.boolean().default(false),
  }),
  z.strictObject({
    recordType: z.literal('customer'),
    payload: customerPayload,
    requiresOnlineReview: z.boolean().default(false),
  }),
  z.strictObject({
    recordType: z.literal('customer_repayment'),
    payload: repaymentPayload,
    requiresOnlineReview: z.boolean().default(false),
  }),
  z.strictObject({
    recordType: z.literal('stock_receipt'),
    payload: z.strictObject({ receipt: offlineStockReceiptSchema }),
    requiresOnlineReview: z.boolean().default(false),
  }),
  z.strictObject({
    recordType: z.literal('purchase_order'),
    payload: z.strictObject({ order: offlinePurchaseOrderSchema }),
    requiresOnlineReview: z.boolean().default(false),
  }),
  z.strictObject({
    recordType: z.literal('expense'),
    payload: z.strictObject({ expense: offlineExpenseSchema }),
    requiresOnlineReview: z.boolean().default(false),
  }),
]);

export const offlineEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(OFFLINE_SCHEMA_VERSION),
  /** Stable idempotency key generated exactly once when the clerk saved the record. */
  operationId: uuidSchema,
  deviceId: uuidSchema,
  /** Device clock at save time. Validated for plausible skew, never trusted blindly. */
  clientCreatedAt: isoDateTime,
  /** Business date for receipts/reports, derived from the clerk's device date. */
  clientDate: dateOnlySchema,
  /** The staff member who captured the record; the server also knows the session's user. */
  capturedByUserId: uuidSchema,
  record: offlineRecordSchema,
  /** SHA-256 of the canonical envelope; a mismatch means the record was altered at rest. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OfflineEnvelope = z.infer<typeof offlineEnvelopeSchema>;
export type OfflineRecord = z.infer<typeof offlineRecordSchema>;

export const offlineStatuses = ['pending', 'syncing', 'synced', 'rejected', 'conflict'] as const;
export type OfflineStatus = (typeof offlineStatuses)[number];

export const offlineStatusLabels: Record<OfflineStatus, string> = {
  pending: 'Waiting to sync',
  syncing: 'Syncing',
  synced: 'Synchronized',
  rejected: 'Needs attention',
  conflict: 'Needs review',
};

export const offlineQuerySchema = z
  .strictObject({
    status: z.enum(offlineStatuses).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .transform((value) => ({ ...value }));

/** Body for one accepted record; the receipt is what makes the acknowledgment authoritative. */
export const syncAcceptedRecordSchema = z.strictObject({
  operationId: uuidSchema,
  recordType: z.enum(offlineRecordTypes),
  outcome: z.enum(['applied', 'duplicate']),
  /** Authoritative identifier produced by the server (sale id, customer id, receipt number). */
  reference: z.string().min(1).max(120),
  receiptNumber: z.string().min(1).max(120).nullable(),
  auditIds: z.array(uuidSchema).max(50).default([]),
  warnings: z.array(z.string().max(300)).max(20).default([]),
});
export type SyncAcceptedRecord = z.infer<typeof syncAcceptedRecordSchema>;

export const syncRejectedRecordSchema = z.strictObject({
  operationId: uuidSchema,
  recordType: z.enum(offlineRecordTypes),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(600),
  /** True when the record can never succeed; false when a supervisor must review or correct it. */
  terminal: z.boolean(),
});
export type SyncRejectedRecord = z.infer<typeof syncRejectedRecordSchema>;

export const syncConflictRecordSchema = z.strictObject({
  operationId: uuidSchema,
  recordType: z.enum(offlineRecordTypes),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(600),
  currentVersion: z.number().int().positive(),
});
export type SyncConflictRecord = z.infer<typeof syncConflictRecordSchema>;

export const syncBatchResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  serverTime: isoDateTime,
  accepted: z.array(syncAcceptedRecordSchema),
  rejected: z.array(syncRejectedRecordSchema),
  conflicts: z.array(syncConflictRecordSchema),
  /** Records whose batch limit was reached; the device keeps them pending and asks again. */
  remaining: z.number().int().nonnegative(),
});
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

export const syncStatusResponseSchema = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  implemented: z.literal(true),
  serverTime: isoDateTime,
  pending: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  device: z.strictObject({
    id: uuidSchema,
    status: z.enum(['pending', 'approved', 'revoked']),
    lastSyncedAt: isoDateTime.nullable(),
  }),
});
export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

export type OfflineSummary = {
  pending: number;
  syncedToday: number;
  rejected: number;
  conflict: number;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type BackupSummary = {
  id: string;
  createdAt: string;
  kind: 'manual' | 'automatic';
  fileName: string;
  sizeBytes: number;
  checksum: string;
  tableCounts: Record<string, number>;
  countsTotal: number;
  verified: boolean;
  note: string | null;
};

export type BackupVerification = {
  fileName: string;
  checksum: string;
  expectedChecksum: string;
  integrityOk: boolean;
  checksumOk: boolean;
  migrationVersion: number;
  tableCounts: Record<string, number>;
  createdAt: string;
};
