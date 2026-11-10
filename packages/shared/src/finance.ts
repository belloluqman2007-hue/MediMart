import { z } from 'zod';
import { uuidSchema } from './contracts';
import {
  dateOnlySchema,
  moneyKobo,
  nonNegativeQuantitySchema,
  quantitySchema,
  supplierStatuses,
  type Paginated,
  type ProductType,
  type SupplierStatus,
} from './inventory';
import { paymentMethods, type PaymentMethod } from './sales';

/**
 * Phase 5 contracts: purchasing, goods receiving, supplier payments, expenses and
 * financial reporting.
 *
 * Every monetary field is an integer amount of kobo. Nothing in this module ever
 * represents money as a floating-point value. An ordered purchase is not cash paid;
 * a payable only arises when goods are actually received.
 */

// --- Vocabulary --------------------------------------------------------------

export const purchaseStatuses = [
  'draft',
  'ordered',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type PurchaseStatus = (typeof purchaseStatuses)[number];

export const purchaseStatusLabels: Record<PurchaseStatus, string> = {
  draft: 'Draft',
  ordered: 'Ordered',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

export const purchaseLineStatuses = ['pending', 'partial', 'received'] as const;
export type PurchaseLineStatus = (typeof purchaseLineStatuses)[number];

export const purchaseLineStatusLabels: Record<PurchaseLineStatus, string> = {
  pending: 'Awaiting delivery',
  partial: 'Partly delivered',
  received: 'Fully received',
};

export const supplierPaymentKinds = ['payment', 'reversal'] as const;
export type SupplierPaymentKind = (typeof supplierPaymentKinds)[number];

export const supplierPaymentKindLabels: Record<SupplierPaymentKind, string> = {
  payment: 'Payment',
  reversal: 'Reversal',
};

export const supplierPaymentAllocationDirections = ['apply', 'reverse'] as const;
export type SupplierPaymentAllocationDirection =
  (typeof supplierPaymentAllocationDirections)[number];

export const expenseStatuses = ['draft', 'recorded', 'reversed'] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];

export const expenseStatusLabels: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  recorded: 'Recorded',
  reversed: 'Reversed',
};

export const financialReportPeriods = ['daily', 'weekly', 'monthly'] as const;
export type FinancialReportPeriod = (typeof financialReportPeriods)[number];

export const financialReportKinds = [
  'sales',
  'purchases',
  'supplier_payments',
  'outstanding_suppliers',
  'expenses',
  'expense_categories',
  'inventory_valuation',
  'cost_of_goods_sold',
  'gross_profit',
  'operating_profit',
  'cash_movement',
] as const;
export type FinancialReportKind = (typeof financialReportKinds)[number];

export const financialReportLabels: Record<FinancialReportKind, string> = {
  sales: 'Sales report',
  purchases: 'Purchase report',
  supplier_payments: 'Supplier payment report',
  outstanding_suppliers: 'Outstanding supplier balances',
  expenses: 'Expense report',
  expense_categories: 'Expense category breakdown',
  inventory_valuation: 'Inventory valuation',
  cost_of_goods_sold: 'Cost of goods sold',
  gross_profit: 'Gross profit report',
  operating_profit: 'Operating profit report',
  cash_movement: 'Cash movement report',
};

export const cashMovementTypes = [
  'sale_payment',
  'debt_repayment',
  'sale_refund',
  'supplier_payment',
  'supplier_payment_reversal',
  'expense',
  'expense_reversal',
] as const;
export type CashMovementType = (typeof cashMovementTypes)[number];

export const cashMovementTypeLabels: Record<CashMovementType, string> = {
  sale_payment: 'Sale collected',
  debt_repayment: 'Debt repayment collected',
  sale_refund: 'Sale refund paid out',
  supplier_payment: 'Supplier payment',
  supplier_payment_reversal: 'Supplier payment reversed',
  expense: 'Business expense',
  expense_reversal: 'Expense reversed',
};

// --- Input schemas -----------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const optionalDate = z
  .union([dateOnlySchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const optionalMoney = z
  .union([moneyKobo, z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : value));

const positiveMoneyKobo = z
  .number()
  .int('Enter an amount in whole kobo.')
  .min(1, 'Amount must be greater than zero.')
  .max(1_000_000_000_000, 'Amount is too large.');

const batchCodeSchema = z
  .string()
  .trim()
  .min(1, 'Enter a batch number.')
  .max(64, 'Use no more than 64 characters.')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'Use letters, numbers, dots, dashes or slashes.');

const todayIso = () => new Date().toISOString().slice(0, 10);
const notFutureDate = (value: string | null | undefined) => !value || value <= todayIso();

export const purchaseLineInputSchema = z
  .strictObject({
    productId: uuidSchema,
    unitId: uuidSchema,
    quantity: quantitySchema.max(1_000_000, 'Quantity is too large for one purchase line.'),
    unitCostKobo: moneyKobo,
    lineDiscountKobo: moneyKobo.default(0),
  })
  .refine(
    (line) => line.lineDiscountKobo <= line.unitCostKobo * line.quantity,
    'A line discount cannot exceed the line subtotal.',
  );
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

const purchaseFieldsSchema = z.strictObject({
  supplierId: uuidSchema,
  items: z
    .array(purchaseLineInputSchema)
    .min(1, 'Add at least one product to this purchase.')
    .max(100, 'A purchase cannot exceed 100 lines.')
    .refine(
      (items) =>
        new Set(items.map((item) => `${item.productId}:${item.unitId}`)).size === items.length,
      'Each product and unit may only appear once on a purchase.',
    ),
  orderDiscountKobo: moneyKobo.default(0),
  discountReason: optionalText(300),
  additionalChargesKobo: moneyKobo.default(0),
  additionalChargesReason: optionalText(300),
  expectedDeliveryDate: optionalDate,
  notes: optionalText(1000),
});

function refinePurchase(value: z.infer<typeof purchaseFieldsSchema>, ctx: z.RefinementCtx) {
  const hasDiscount =
    value.orderDiscountKobo > 0 || value.items.some((item) => item.lineDiscountKobo > 0);
  if (hasDiscount && (!value.discountReason || value.discountReason.trim().length < 3)) {
    ctx.addIssue({
      code: 'custom',
      path: ['discountReason'],
      message: 'Give a reason of at least 3 characters for the discount.',
    });
  }
  if (
    value.additionalChargesKobo > 0 &&
    (!value.additionalChargesReason || value.additionalChargesReason.trim().length < 3)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['additionalChargesReason'],
      message: 'Describe the additional charge (for example delivery or handling).',
    });
  }
}

export const purchaseCreateSchema = z
  .strictObject({
    operationId: uuidSchema,
    ...purchaseFieldsSchema.shape,
    status: z.enum(['draft', 'ordered']).default('draft'),
  })
  .superRefine(refinePurchase);
export type PurchaseCreateInput = z.infer<typeof purchaseCreateSchema>;

export const purchaseUpdateSchema = z
  .strictObject({
    version: z.number().int().min(1),
    ...purchaseFieldsSchema.shape,
  })
  .superRefine(refinePurchase);
export type PurchaseUpdateInput = z.infer<typeof purchaseUpdateSchema>;

export const purchaseListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    supplierId: uuidSchema.optional(),
    status: z.enum(purchaseStatuses).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }))
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const purchaseCancelSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(3, 'Enter a cancellation reason of at least 3 characters.')
    .max(500),
});

export const goodsReceiptItemInputSchema = z
  .strictObject({
    purchaseOrderItemId: uuidSchema,
    quantityReceived: nonNegativeQuantitySchema,
    quantityRejected: nonNegativeQuantitySchema.default(0),
    rejectionReason: optionalText(300),
    unitCostKobo: optionalMoney,
    batchNumber: z
      .union([batchCodeSchema, z.literal(''), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    manufacturingDate: optionalDate,
    expiryDate: optionalDate,
  })
  .superRefine((item, ctx) => {
    if (item.quantityReceived + item.quantityRejected <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantityReceived'],
        message: 'Enter a received or rejected quantity.',
      });
    }
    if (
      item.quantityRejected > 0 &&
      (!item.rejectionReason || item.rejectionReason.trim().length < 3)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejectionReason'],
        message: 'Explain why goods were rejected, damaged or missing.',
      });
    }
    if (item.manufacturingDate && item.expiryDate && item.manufacturingDate > item.expiryDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['manufacturingDate'],
        message: 'The manufacturing date must be on or before the expiry date.',
      });
    }
  });
export type GoodsReceiptItemInput = z.infer<typeof goodsReceiptItemInputSchema>;

export const goodsReceiptCreateSchema = z.strictObject({
  operationId: uuidSchema,
  receivedDate: dateOnlySchema.default(() => todayIso()),
  notes: optionalText(1000),
  items: z
    .array(goodsReceiptItemInputSchema)
    .min(1, 'Record at least one received line.')
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.purchaseOrderItemId)).size === items.length,
      'Each purchase line may only be received once per delivery.',
    ),
});
export type GoodsReceiptCreateInput = z.infer<typeof goodsReceiptCreateSchema>;

export const goodsReceiptListQuerySchema = z
  .strictObject({
    purchaseOrderId: uuidSchema.optional(),
    supplierId: uuidSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const supplierPaymentAllocationInputSchema = z.strictObject({
  purchaseOrderId: uuidSchema,
  amountKobo: positiveMoneyKobo,
});
export type SupplierPaymentAllocationInput = z.infer<typeof supplierPaymentAllocationInputSchema>;

export const supplierPaymentCreateSchema = z
  .strictObject({
    operationId: uuidSchema,
    supplierId: uuidSchema,
    amountKobo: positiveMoneyKobo,
    method: z.enum(paymentMethods),
    paidAt: dateOnlySchema.default(() => todayIso()),
    reference: optionalText(100),
    notes: optionalText(500),
    allocations: z
      .array(supplierPaymentAllocationInputSchema)
      .min(1, 'Allocate this payment to at least one invoice.')
      .max(100)
      .refine(
        (allocations) =>
          new Set(allocations.map((entry) => entry.purchaseOrderId)).size === allocations.length,
        'Each invoice may only be allocated once per payment.',
      ),
  })
  .superRefine((value, ctx) => {
    if (!notFutureDate(value.paidAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['paidAt'],
        message: 'The payment date cannot be in the future.',
      });
    }
    const total = value.allocations.reduce((sum, entry) => sum + entry.amountKobo, 0);
    if (total !== value.amountKobo) {
      ctx.addIssue({
        code: 'custom',
        path: ['allocations'],
        message: 'Allocate the full payment amount across the selected invoices.',
      });
    }
  });
export type SupplierPaymentCreateInput = z.infer<typeof supplierPaymentCreateSchema>;

export const supplierPaymentListQuerySchema = z
  .strictObject({
    supplierId: uuidSchema.optional(),
    kind: z.enum(supplierPaymentKinds).optional(),
    method: z.enum(paymentMethods).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const supplierPaymentReversalSchema = z.strictObject({
  operationId: uuidSchema,
  reason: z.string().trim().min(3, 'Enter a reason of at least 3 characters.').max(500),
});
export type SupplierPaymentReversalInput = z.infer<typeof supplierPaymentReversalSchema>;

export const supplierAccountQuerySchema = z.strictObject({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export const supplierBalanceListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    outstandingOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

const supportedAttachmentTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const expenseAttachmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  mime: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (value) => supportedAttachmentTypes.includes(value),
      'Attach a JPEG, PNG, WebP image or a PDF document.',
    ),
  dataBase64: z
    .string()
    .min(1, 'The attachment is empty.')
    .max(48_000, 'The attachment must be 36 KB or smaller.')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The attachment could not be read.'),
});
export type ExpenseAttachmentInput = z.infer<typeof expenseAttachmentSchema>;

const expenseFieldsSchema = z.strictObject({
  categoryId: uuidSchema,
  description: z.string().trim().min(3, 'Describe the expense in at least 3 characters.').max(500),
  amountKobo: positiveMoneyKobo,
  paymentMethod: z.enum(paymentMethods),
  expenseDate: dateOnlySchema.refine(
    (value) => value <= todayIso(),
    'The expense date cannot be in the future.',
  ),
  payee: optionalText(160),
  reference: optionalText(100),
  notes: optionalText(1000),
  attachment: z
    .union([expenseAttachmentSchema, z.null()])
    .optional()
    .transform((value) => value ?? null),
});

export const expenseCreateSchema = z.strictObject({
  operationId: uuidSchema,
  ...expenseFieldsSchema.shape,
  status: z.enum(['draft', 'recorded']).default('recorded'),
});
export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;

export const expenseUpdateSchema = z.strictObject({
  version: z.number().int().min(1),
  ...expenseFieldsSchema.shape,
});
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;

export const expenseListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    categoryId: uuidSchema.optional(),
    status: z.enum(expenseStatuses).optional(),
    method: z.enum(paymentMethods).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }))
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const expenseReversalSchema = z.strictObject({
  operationId: uuidSchema,
  reason: z.string().trim().min(3, 'Enter a reason of at least 3 characters.').max(500),
});
export type ExpenseReversalInput = z.infer<typeof expenseReversalSchema>;

export const financialReportQuerySchema = z
  .strictObject({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    period: z.enum(financialReportPeriods).default('daily'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const financialExportQuerySchema = z
  .strictObject({
    report: z.enum(financialReportKinds),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    period: z.enum(financialReportPeriods).default('daily'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

export const cashRegisterQuerySchema = z
  .strictObject({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
  });

// --- Response DTOs -----------------------------------------------------------

export type PurchaseOrderItemSummary = {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  productType: ProductType;
  unitId: string;
  unitName: string;
  unitSymbol: string;
  conversionFactor: number;
  quantity: number;
  baseQuantity: number;
  unitCostKobo: number;
  lineSubtotalKobo: number;
  lineDiscountKobo: number;
  lineTotalKobo: number;
  receivedBaseQuantity: number;
  receivedQuantity: number;
  pendingQuantity: number;
  receivedValueKobo: number;
  status: PurchaseLineStatus;
};

export type PurchasePaymentSummary = {
  id: string;
  paymentNumber: string;
  paymentKind: SupplierPaymentKind;
  method: PaymentMethod;
  amountKobo: number;
  allocatedToOrderKobo: number;
  paidAt: string;
  reference: string | null;
  recordedBy: string;
  recordedByName: string | null;
  createdAt: string;
};

export type PurchaseOrderSummary = {
  id: string;
  referenceNumber: string;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  status: PurchaseStatus;
  expectedDeliveryDate: string | null;
  subtotalKobo: number;
  lineDiscountTotalKobo: number;
  orderDiscountKobo: number;
  discountTotalKobo: number;
  discountReason: string | null;
  additionalChargesKobo: number;
  additionalChargesReason: string | null;
  totalKobo: number;
  notes: string | null;
  itemCount: number;
  receivedValueKobo: number;
  paidKobo: number;
  outstandingKobo: number;
  orderedAt: string | null;
  orderedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type PurchaseOrderDetail = PurchaseOrderSummary & {
  items: PurchaseOrderItemSummary[];
  receipts: GoodsReceiptSummary[];
  payments: PurchasePaymentSummary[];
};

export type GoodsReceiptSummary = {
  id: string;
  receiptNumber: string;
  purchaseOrderId: string;
  purchaseReference: string;
  supplierId: string;
  supplierName: string;
  receivedDate: string;
  notes: string | null;
  receivedValueKobo: number;
  totalRejectedBaseQuantity: number;
  itemCount: number;
  receivedBy: string;
  receivedByName: string | null;
  createdAt: string;
};

export type GoodsReceiptItemSummary = {
  id: string;
  purchaseOrderItemId: string;
  productId: string;
  productName: string;
  unitName: string;
  unitSymbol: string;
  conversionFactor: number;
  quantityReceived: number;
  baseQuantityReceived: number;
  quantityRejected: number;
  baseQuantityRejected: number;
  rejectionReason: string | null;
  unitCostKobo: number;
  totalCostKobo: number;
  batchId: string | null;
  batchNumber: string | null;
  manufacturingDate: string | null;
  expiryDate: string | null;
  stockMovementId: string | null;
};

export type GoodsReceiptDetail = GoodsReceiptSummary & {
  items: GoodsReceiptItemSummary[];
};

export type SupplierAccountSummary = {
  supplierId: string;
  supplierName: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  status: SupplierStatus;
  totalPurchaseOrders: number;
  totalOrderedValueKobo: number;
  openPurchaseOrderCount: number;
  totalGoodsReceivedKobo: number;
  totalPaidKobo: number;
  totalPaymentReversalsKobo: number;
  netPaidKobo: number;
  outstandingBalanceKobo: number;
  outstandingInvoiceCount: number;
  lastReceiptDate: string | null;
  lastPaymentAt: string | null;
};

export type SupplierInvoiceSummary = {
  purchaseOrderId: string;
  referenceNumber: string;
  status: PurchaseStatus;
  expectedDeliveryDate: string | null;
  orderedValueKobo: number;
  receivedValueKobo: number;
  allocatedPaidKobo: number;
  outstandingKobo: number;
  lastReceiptDate: string | null;
  paymentStatus: 'unpaid' | 'partial' | 'paid';
};

export type SupplierStatementEntry = {
  id: string;
  date: string;
  type: 'goods_received' | 'payment' | 'payment_reversal';
  reference: string;
  description: string;
  debitKobo: number;
  creditKobo: number;
  runningBalanceKobo: number;
  method: PaymentMethod | null;
};

export type SupplierStatement = {
  supplierId: string;
  supplierName: string;
  from: string;
  to: string;
  openingBalanceKobo: number;
  closingBalanceKobo: number;
  totalDebitsKobo: number;
  totalCreditsKobo: number;
  entries: SupplierStatementEntry[];
};

export type SupplierAccountDetail = SupplierAccountSummary & {
  outstandingInvoices: SupplierInvoiceSummary[];
  recentPurchases: PurchaseOrderSummary[];
  recentReceipts: GoodsReceiptSummary[];
  recentPayments: SupplierPaymentSummary[];
  statement: SupplierStatement;
};

export type SupplierBalanceRow = {
  supplierId: string;
  supplierName: string;
  contactPerson: string | null;
  phone: string | null;
  status: SupplierStatus;
  totalGoodsReceivedKobo: number;
  netPaidKobo: number;
  outstandingBalanceKobo: number;
  outstandingInvoiceCount: number;
  lastReceiptDate: string | null;
};

export type SupplierPaymentAllocationSummary = {
  id: string;
  purchaseOrderId: string;
  purchaseReference: string;
  direction: SupplierPaymentAllocationDirection;
  amountKobo: number;
  createdAt: string;
};

export type SupplierPaymentSummary = {
  id: string;
  paymentNumber: string;
  supplierId: string;
  supplierName: string;
  paymentKind: SupplierPaymentKind;
  method: PaymentMethod;
  amountKobo: number;
  paidAt: string;
  reference: string | null;
  notes: string | null;
  reversalOfPaymentId: string | null;
  reversedByPaymentId: string | null;
  reversalReason: string | null;
  recordedBy: string;
  recordedByName: string | null;
  createdAt: string;
  allocations: SupplierPaymentAllocationSummary[];
};

export type SupplierPaymentDetail = SupplierPaymentSummary & {
  account: SupplierAccountSummary;
};

export type ExpenseCategorySummary = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  sortOrder: number;
  status: 'active' | 'inactive';
};

export type ExpenseAttachmentSummary = {
  name: string;
  mime: string;
  dataBase64?: string;
};

export type ExpenseSummary = {
  id: string;
  expenseNumber: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  description: string;
  amountKobo: number;
  paymentMethod: PaymentMethod;
  expenseDate: string;
  payee: string | null;
  reference: string | null;
  notes: string | null;
  hasAttachment: boolean;
  attachmentName: string | null;
  attachmentMime: string | null;
  status: ExpenseStatus;
  recordedAt: string | null;
  recordedByName: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
  reversalId: string | null;
  createdBy: string;
  createdByName: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseDetail = ExpenseSummary & {
  attachment: ExpenseAttachmentSummary | null;
};

export type ExpenseCategoryBreakdown = {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  amountKobo: number;
  count: number;
};

export type ExpenseDatePoint = {
  date: string;
  amountKobo: number;
  count: number;
};

export type SalesFinancials = {
  grossSalesKobo: number;
  discountsKobo: number;
  refundsKobo: number;
  netSalesRevenueKobo: number;
  transactionsCount: number;
  refundCount: number;
  averageSaleKobo: number;
  costOfGoodsSoldKobo: number;
};

export type CollectionsFinancials = {
  cashKobo: number;
  bankTransferKobo: number;
  posKobo: number;
  totalReceivedKobo: number;
  salesPaymentsKobo: number;
  debtRepaymentsKobo: number;
  refundsPaidKobo: number;
};

export type PurchaseFinancials = {
  totalOrderedKobo: number;
  orderCount: number;
  goodsReceivedKobo: number;
  receiptCount: number;
  paidToSuppliersKobo: number;
  paymentCount: number;
  supplierPaymentReversalsKobo: number;
  outstandingSupplierBalanceKobo: number;
  outstandingInvoiceCount: number;
};

export type ExpenseFinancials = {
  recordedGrossKobo: number;
  reversedKobo: number;
  netKobo: number;
  expenseCount: number;
  byCategory: ExpenseCategoryBreakdown[];
  byDate: ExpenseDatePoint[];
};

export type InventoryFinancials = {
  stockValueCostKobo: number;
  stockValueRetailKobo: number;
  stockUnits: number;
  costOfGoodsSoldKobo: number;
};

export type ProfitFinancials = {
  netSalesRevenueKobo: number;
  costOfGoodsSoldKobo: number;
  grossProfitKobo: number;
  operatingExpensesKobo: number;
  operatingProfitKobo: number;
};

export type FinanceSalesTrendPoint = {
  period: string;
  label: string;
  transactionsCount: number;
  grossSalesKobo: number;
  discountsKobo: number;
  refundsKobo: number;
  netSalesRevenueKobo: number;
  moneyReceivedKobo: number;
  costOfGoodsSoldKobo: number;
  grossProfitKobo: number;
};

export type CashMovementRow = {
  id: string;
  occurredAt: string;
  date: string;
  type: CashMovementType;
  direction: 'in' | 'out';
  method: PaymentMethod;
  amountKobo: number;
  signedAmountKobo: number;
  reference: string | null;
  description: string;
  entityId: string;
  entityReference: string;
  isCashDrawer: boolean;
};

export type CashMovementMethodTotal = {
  method: PaymentMethod;
  inflowKobo: number;
  outflowKobo: number;
  netKobo: number;
  cashDrawer: boolean;
};

export type CashMovementReport = {
  from: string;
  to: string;
  rows: CashMovementRow[];
  byMethod: CashMovementMethodTotal[];
  inflowKobo: number;
  outflowKobo: number;
  netKobo: number;
  cashNetKobo: number;
  note: string;
};

export type PurchaseReportRow = {
  id: string;
  referenceNumber: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseStatus;
  orderDate: string;
  totalKobo: number;
  receivedValueKobo: number;
  paidKobo: number;
  outstandingKobo: number;
};

export type SupplierPaymentReportRow = {
  id: string;
  paymentNumber: string;
  supplierName: string;
  paymentKind: SupplierPaymentKind;
  method: PaymentMethod;
  amountKobo: number;
  paidAt: string;
  reference: string | null;
  invoiceCount: number;
};

export type InventoryValuationRow = {
  productId: string;
  productName: string;
  sku: string | null;
  baseUnitSymbol: string;
  stockQuantity: number;
  batchTracked: boolean;
  costValueKobo: number;
  retailValueKobo: number;
};

export type InventoryValuation = {
  rows: InventoryValuationRow[];
  totalCostKobo: number;
  totalRetailKobo: number;
  totalUnits: number;
};

export type CogsRow = {
  productId: string;
  productName: string;
  baseUnitSymbol: string;
  baseQuantitySold: number;
  revenueKobo: number;
  cogsKobo: number;
  grossProfitKobo: number;
};

export type FinancialReport = {
  from: string;
  to: string;
  period: FinancialReportPeriod;
  generatedAt: string;
  sales: SalesFinancials;
  collections: CollectionsFinancials;
  purchases: PurchaseFinancials;
  expenses: ExpenseFinancials;
  inventory: InventoryFinancials;
  profitability: ProfitFinancials;
  salesTrend: FinanceSalesTrendPoint[];
  topProducts: CogsRow[];
  purchaseRows: PurchaseReportRow[];
  supplierPaymentRows: SupplierPaymentReportRow[];
  supplierBalances: SupplierBalanceRow[];
  expenseRows: ExpenseSummary[];
  inventoryValuation: InventoryValuation;
  cogsRows: CogsRow[];
  cashMovement: CashMovementReport;
};

export type FinancialDashboardSummary = {
  from: string;
  to: string;
  sales: SalesFinancials;
  collections: CollectionsFinancials;
  purchases: PurchaseFinancials;
  expenses: ExpenseFinancials;
  inventory: InventoryFinancials;
  profitability: ProfitFinancials;
};

export type FinancialExport = {
  report: FinancialReportKind;
  filename: string;
  contentType: 'text/csv; charset=utf-8';
  from: string;
  to: string;
  rowCount: number;
  csv: string;
};

export type CashRegisterSummary = {
  from: string;
  to: string;
  rows: CashMovementRow[];
  byMethod: CashMovementMethodTotal[];
  inflowKobo: number;
  outflowKobo: number;
  netKobo: number;
  cashNetKobo: number;
  note: string;
};

export type PaginatedPurchases = Paginated<PurchaseOrderSummary>;
export type PaginatedGoodsReceipts = Paginated<GoodsReceiptSummary>;
export type PaginatedSupplierPayments = Paginated<SupplierPaymentSummary>;
export type PaginatedSupplierBalances = Paginated<SupplierBalanceRow>;
export type PaginatedExpenses = Paginated<ExpenseSummary>;
export type SupplierStatusValue = (typeof supplierStatuses)[number];
