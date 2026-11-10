import { z } from 'zod';
import { emailSchema, type ShopSettings, uuidSchema } from './contracts';
import {
  dateOnlySchema,
  moneyKobo,
  productTypes,
  quantitySchema,
  type Paginated,
  type ProductType,
} from './inventory';

/**
 * Phase 3 contracts: Point of Sale, Sales, Receipts, Payments, Customers & Debts.
 *
 * Every monetary field is an integer amount of kobo. Credit sales are tracked as
 * outstanding balances on `customer_debts` and are never represented as received cash.
 */

export const paymentMethods = ['cash', 'bank_transfer', 'pos_terminal'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  pos_terminal: 'POS terminal',
};

export const ledgerPaymentMethods = [
  'cash',
  'bank_transfer',
  'pos_terminal',
  'credit_reduction',
] as const;
export type LedgerPaymentMethod = (typeof ledgerPaymentMethods)[number];

export const ledgerPaymentMethodLabels: Record<LedgerPaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  pos_terminal: 'POS terminal',
  credit_reduction: 'Credit debt reduction',
};

export const paymentKinds = ['sale_payment', 'void_reversal', 'refund_payout'] as const;
export type PaymentKind = (typeof paymentKinds)[number];

export const saleStatuses = ['completed', 'voided', 'partially_refunded', 'refunded'] as const;
export type SaleStatus = (typeof saleStatuses)[number];

export const saleStatusLabels: Record<SaleStatus, string> = {
  completed: 'Completed',
  voided: 'Voided',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
};

export const salePaymentStatuses = ['paid', 'partial', 'credit', 'voided', 'refunded'] as const;
export type SalePaymentStatus = (typeof salePaymentStatuses)[number];

export const salePaymentStatusLabels: Record<SalePaymentStatus, string> = {
  paid: 'Paid in full',
  partial: 'Part payment',
  credit: 'Credit sale',
  voided: 'Voided',
  refunded: 'Refunded',
};

export const customerStatuses = ['active', 'inactive'] as const;
export type CustomerStatus = (typeof customerStatuses)[number];

export const debtStatuses = ['open', 'partial', 'settled', 'cancelled'] as const;
export type DebtStatus = (typeof debtStatuses)[number];

export const debtStatusLabels: Record<DebtStatus, string> = {
  open: 'Unpaid',
  partial: 'Part paid',
  settled: 'Settled',
  cancelled: 'Cancelled',
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const optionalUuid = z
  .union([uuidSchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const optionalDate = z
  .union([dateOnlySchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const positiveMoneyKobo = z
  .number()
  .int('Enter an amount in whole kobo.')
  .min(1, 'Payment amount must be greater than zero.')
  .max(1_000_000_000_000, 'Amount is too large.');

// --- POS Catalog -------------------------------------------------------------

export const posCatalogQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    type: z.enum(productTypes).optional(),
    categoryId: uuidSchema.optional(),
    inStockOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const posLookupQuerySchema = z.strictObject({
  code: z.string().trim().min(1, 'Enter or scan a barcode or SKU.').max(64),
});

export type PosSellingUnit = {
  unitId: string;
  code: string;
  name: string;
  symbol: string;
  factor: number;
  sellingPriceKobo: number;
};

export type PosProduct = {
  id: string;
  name: string;
  genericName: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  productType: ProductType;
  categoryId: string | null;
  categoryName: string | null;
  sellingPriceKobo: number;
  reorderLevel: number;
  baseUnitId: string;
  baseUnitName: string;
  baseUnitSymbol: string;
  isExpiryTracked: boolean;
  totalStockQuantity: number;
  sellableQuantity: number;
  expiredQuantity: number;
  nearestValidExpiryDate: string | null;
  units: PosSellingUnit[];
};

// --- Sales & Checkout --------------------------------------------------------

export const saleLineInputSchema = z.strictObject({
  productId: uuidSchema,
  unitId: uuidSchema,
  quantity: quantitySchema,
  lineDiscountKobo: moneyKobo.default(0),
});
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

export const salePaymentInputSchema = z.strictObject({
  method: z.enum(paymentMethods),
  amountKobo: positiveMoneyKobo,
  reference: optionalText(100),
});
export type SalePaymentInput = z.infer<typeof salePaymentInputSchema>;

export const discountAuthorizationSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type DiscountAuthorizationInput = z.infer<typeof discountAuthorizationSchema>;

export const saleCreateSchema = z
  .strictObject({
    operationId: uuidSchema,
    customerId: optionalUuid,
    items: z
      .array(saleLineInputSchema)
      .min(1, 'Add at least one item to the cart.')
      .max(100, 'A single sale cannot exceed 100 line items.'),
    cartDiscountKobo: moneyKobo.default(0),
    discountReason: optionalText(300),
    discountAuthorization: discountAuthorizationSchema.optional(),
    payments: z.array(salePaymentInputSchema).max(10).default([]),
    dueDate: optionalDate,
    notes: optionalText(500),
  })
  .superRefine((value, ctx) => {
    const hasDiscount =
      value.cartDiscountKobo > 0 || value.items.some((item) => item.lineDiscountKobo > 0);
    if (hasDiscount && (!value.discountReason || value.discountReason.trim().length < 3)) {
      ctx.addIssue({
        code: 'custom',
        path: ['discountReason'],
        message: 'Provide a reason (at least 3 characters) when applying a discount.',
      });
    }
  });
export type SaleCreateInput = z.infer<typeof saleCreateSchema>;

export const saleListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    customerId: uuidSchema.optional(),
    status: z.enum(saleStatuses).optional(),
    paymentStatus: z.enum(salePaymentStatuses).optional(),
    method: z.enum(paymentMethods).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const saleVoidSchema = z.strictObject({
  operationId: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(3, 'Enter a reason of at least 3 characters.')
    .max(500, 'Reason cannot exceed 500 characters.'),
  refundMethod: z.enum(paymentMethods).optional(),
});
export type SaleVoidInput = z.infer<typeof saleVoidSchema>;

export const saleRefundItemInputSchema = z.strictObject({
  saleItemId: uuidSchema,
  quantity: quantitySchema,
});

export const saleRefundSchema = z.strictObject({
  operationId: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(3, 'Enter a reason of at least 3 characters.')
    .max(500, 'Reason cannot exceed 500 characters.'),
  restockItems: z.boolean().default(true),
  refundMethod: z.enum(paymentMethods).default('cash'),
  reference: optionalText(100),
  items: z
    .array(saleRefundItemInputSchema)
    .min(1, 'Select at least one item to refund.')
    .max(100)
    .refine(
      (items) => new Set(items.map((item) => item.saleItemId)).size === items.length,
      'Each sale item can only appear once in a refund request.',
    ),
});
export type SaleRefundInput = z.infer<typeof saleRefundSchema>;

// --- Customers & Debts -------------------------------------------------------

export const customerInputSchema = z
  .strictObject({
    fullName: z.string().trim().min(2, 'Enter at least 2 characters.').max(160),
    phone: optionalText(40),
    email: z
      .union([emailSchema, z.literal(''), z.null()])
      .optional()
      .transform((value) => (value ? value : null)),
    address: optionalText(400),
    notes: optionalText(1000),
    creditLimitKobo: z
      .union([moneyKobo, z.null()])
      .optional()
      .transform((value) => (value === undefined ? null : value)),
    status: z.enum(customerStatuses).default('active'),
  })
  .refine(
    (value) => !value.phone || /^[0-9+()\-.\s]{6,40}$/.test(value.phone),
    'Enter a valid phone number.',
  );
export type CustomerInput = z.infer<typeof customerInputSchema>;

export const customerListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    status: z.enum(customerStatuses).optional(),
    hasDebt: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const debtListQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    customerId: uuidSchema.optional(),
    status: z.enum(['outstanding', ...debtStatuses]).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .transform((value) => ({ ...value, search: value.search || undefined }));

export const debtRepaymentSchema = z.strictObject({
  operationId: uuidSchema,
  amountKobo: positiveMoneyKobo,
  method: z.enum(paymentMethods),
  reference: optionalText(100),
  notes: optionalText(400),
});
export type DebtRepaymentInput = z.infer<typeof debtRepaymentSchema>;

export const customerRepaymentSchema = z
  .strictObject({
    operationId: uuidSchema,
    amountKobo: positiveMoneyKobo.optional(),
    settleAll: z.boolean().default(false),
    method: z.enum(paymentMethods),
    reference: optionalText(100),
    notes: optionalText(400),
  })
  .refine(
    (value) => value.settleAll || (typeof value.amountKobo === 'number' && value.amountKobo > 0),
    'Enter a repayment amount or choose full settlement.',
  );
export type CustomerRepaymentInput = z.infer<typeof customerRepaymentSchema>;

export const salesReportQuerySchema = z.strictObject({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

// --- Response DTOs -----------------------------------------------------------

export type SaleAllocationSummary = {
  id: string;
  batchId: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  movementId: string;
  baseQuantity: number;
  unitCostKobo: number;
  quantityReversed: number;
};

export type SaleItemDetail = {
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
  unitPriceKobo: number;
  lineSubtotalKobo: number;
  lineDiscountKobo: number;
  lineTotalKobo: number;
  netTotalKobo: number;
  quantityRefunded: number;
  quantityRefundedBase: number;
  refundableQuantity: number;
  amountRefundedKobo: number;
  allocations: SaleAllocationSummary[];
};

export type SalePaymentSummary = {
  id: string;
  paymentKind: PaymentKind;
  method: LedgerPaymentMethod;
  tenderedKobo: number;
  changeKobo: number;
  netAmountKobo: number;
  reference: string | null;
  recordedBy: string;
  recordedByName: string | null;
  createdAt: string;
};

export type SaleReversalItemSummary = {
  id: string;
  saleItemId: string;
  productId: string;
  productName: string;
  unitSymbol: string;
  quantity: number;
  baseQuantity: number;
  amountKobo: number;
  restocked: boolean;
};

export type SaleReversalSummary = {
  id: string;
  reversalNumber: string;
  reversalType: 'void' | 'refund';
  reason: string;
  restockItems: boolean;
  totalReversedKobo: number;
  cashRefundedKobo: number;
  debtReducedKobo: number;
  refundMethod: PaymentMethod | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  items: SaleReversalItemSummary[];
};

export type SaleSummary = {
  id: string;
  receiptNumber: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  itemCount: number;
  subtotalKobo: number;
  lineDiscountTotalKobo: number;
  cartDiscountKobo: number;
  discountTotalKobo: number;
  discountReason: string | null;
  discountAuthorizedBy: string | null;
  discountAuthorizedByName: string | null;
  totalKobo: number;
  tenderedKobo: number;
  changeDueKobo: number;
  amountPaidKobo: number;
  initialOutstandingKobo: number;
  currentOutstandingKobo: number;
  refundedTotalKobo: number;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  notes: string | null;
  soldBy: string;
  soldByName: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SaleDetail = SaleSummary & {
  items: SaleItemDetail[];
  payments: SalePaymentSummary[];
  reversals: SaleReversalSummary[];
  debt: DebtSummary | null;
  shop: ShopSettings;
};

export type CustomerSummary = {
  id: string;
  code: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  creditLimitKobo: number | null;
  status: CustomerStatus;
  salesCount: number;
  totalPurchasesKobo: number;
  totalCreditKobo: number;
  totalRepaidKobo: number;
  outstandingBalanceKobo: number;
  openDebtCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DebtPaymentSummary = {
  id: string;
  receiptNumber: string;
  debtId: string;
  customerId: string;
  customerName: string;
  saleId: string;
  saleReceiptNumber: string;
  amountKobo: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  balanceBeforeKobo: number;
  balanceAfterKobo: number;
  recordedBy: string;
  recordedByName: string | null;
  createdAt: string;
};

export type DebtSummary = {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  customerPhone: string | null;
  saleId: string;
  saleReceiptNumber: string;
  saleTotalKobo: number;
  originalAmountKobo: number;
  amountPaidKobo: number;
  amountCancelledKobo: number;
  outstandingKobo: number;
  dueDate: string | null;
  isOverdue: boolean;
  status: DebtStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DebtDetail = DebtSummary & {
  payments: DebtPaymentSummary[];
  shop: ShopSettings;
};

export type CustomerDetail = CustomerSummary & {
  recentSales: SaleSummary[];
  debts: DebtSummary[];
  repayments: DebtPaymentSummary[];
  shop: ShopSettings;
};

export type DebtReport = {
  totalOriginalCreditKobo: number;
  totalRepaidKobo: number;
  totalCancelledKobo: number;
  totalOutstandingKobo: number;
  openDebtCount: number;
  overdueDebtCount: number;
  overdueAmountKobo: number;
  customersWithDebtCount: number;
  topDebtors: Array<{
    customerId: string;
    customerCode: string;
    customerName: string;
    phone: string | null;
    openDebtCount: number;
    outstandingBalanceKobo: number;
    oldestDebtDate: string;
  }>;
  recentRepayments: DebtPaymentSummary[];
};

export type SalesTrendPoint = {
  date: string;
  transactionsCount: number;
  netSalesRevenueKobo: number;
  moneyReceivedKobo: number;
  creditSalesKobo: number;
  cogsKobo: number | null;
  grossProfitKobo: number | null;
};

export type FinancialSeparation = {
  grossSalesKobo: number;
  discountsGivenKobo: number;
  refundsKobo: number;
  voidedSalesKobo: number;
  /** Net sales revenue (includes paid and credit sales; excludes voided and refunded amounts). */
  salesRevenueKobo: number;
  /** Actual money received across cash, transfer, and POS (checkout + debt repayments - refunds). Never includes unpaid credit. */
  cashActuallyReceivedKobo: number;
  cashMethodReceivedKobo: number;
  bankTransferReceivedKobo: number;
  posReceivedKobo: number;
  salesPaymentsReceivedKobo: number;
  debtRepaymentsReceivedKobo: number;
  /** Credit issued during the period that remained unpaid at checkout. */
  periodCreditSalesKobo: number;
  /** Live total unpaid customer debt across the business. */
  outstandingCreditKobo: number;
  /** Cost of goods sold for net completed sales (`null` when caller lacks `reports.view`). */
  costOfGoodsSoldKobo: number | null;
  /** Gross profit = Sales revenue - Cost of goods sold (`null` when caller lacks `reports.view`). */
  grossProfitKobo: number | null;
  /** Operating expenses (separate financial concept; Expenses module is Phase 4+). */
  expensesKobo: number;
  expensesTracked: false;
};

export type SalesDashboardSummary = {
  today: string;
  todayTransactionsCount: number;
  todayVoidedCount: number;
  todayFinancials: FinancialSeparation;
  openDebtCount: number;
  customersWithDebtCount: number;
  trends: SalesTrendPoint[];
  recentSales: SaleSummary[];
};

export type SalesReport = {
  from: string;
  to: string;
  completedTransactionsCount: number;
  voidedTransactionsCount: number;
  refundCount: number;
  financials: FinancialSeparation;
  trends: SalesTrendPoint[];
  topProducts: Array<{
    productId: string;
    productName: string;
    productType: ProductType;
    baseUnitSymbol: string;
    baseQuantitySold: number;
    revenueKobo: number;
    cogsKobo: number;
    grossProfitKobo: number;
  }>;
  debtSummary: {
    openDebtCount: number;
    customersWithDebtCount: number;
    totalOutstandingKobo: number;
    overdueAmountKobo: number;
  };
};

export type CustomerRepaymentResult = {
  customer: CustomerSummary;
  totalAppliedKobo: number;
  payments: DebtPaymentSummary[];
  shop: ShopSettings;
};

export type PosCategoryOption = {
  id: string;
  name: string;
  kind: 'pharmacy' | 'mini_mart' | 'general';
};

export type PosBootstrap = {
  categories: PosCategoryOption[];
  shop: ShopSettings;
};

export type PaginatedSales = Paginated<SaleSummary>;
export type PaginatedCustomers = Paginated<CustomerSummary>;
export type PaginatedDebts = Paginated<DebtSummary>;
export type PaginatedPosProducts = Paginated<PosProduct>;
