import {
  completePrescriptionCheckout,
  protectClinicalSaleReversal,
} from '../prescription-checkout';
import type { Database, SqlExecutor } from '@medimart/database';
import type {
  LedgerPaymentMethod,
  Paginated,
  PaymentKind,
  PaymentMethod,
  ProductType,
  SaleAllocationSummary,
  SaleCreateInput,
  SaleDetail,
  SaleItemDetail,
  SalePaymentStatus,
  SalePaymentSummary,
  SaleRefundInput,
  SaleReversalSummary,
  SaleStatus,
  SaleSummary,
  SaleVoidInput,
} from '@medimart/shared';
import { requireSupervisorGrant, type AuthContext, type AuthService } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import {
  assertPermission,
  likePattern,
  loadProduct,
  paginate,
  todayIso,
} from '../inventory/common';
import { recordMovement } from '../inventory/stock';
import { nextSequenceCode, operationHash, readShopSettings, resolveSellingUnit } from './common';
import { debtSelect, loadCustomerSummary, mapDebt, type DebtRow } from './debts';

export type SaleHeaderRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  receipt_number: string;
  customer_id: string | null;
  customer_name_snapshot: string;
  customer_phone_snapshot: string | null;
  item_count: number;
  subtotal_kobo: number;
  line_discount_total_kobo: number;
  cart_discount_kobo: number;
  discount_total_kobo: number;
  discount_reason: string | null;
  discount_authorized_by: string | null;
  discount_authorized_by_name: string | null;
  total_kobo: number;
  cogs_kobo: number;
  tendered_kobo: number;
  change_due_kobo: number;
  amount_paid_kobo: number;
  initial_outstanding_kobo: number;
  current_outstanding_kobo: number;
  refunded_total_kobo: number;
  status: SaleStatus;
  payment_status: SalePaymentStatus;
  notes: string | null;
  sold_by: string;
  sold_by_name: string | null;
  voided_at: string | null;
  voided_by: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export const saleHeaderSelect = `
  SELECT
    s.*,
    (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
    COALESCE((SELECT cd.outstanding_kobo FROM customer_debts cd WHERE cd.sale_id = s.id), 0) AS current_outstanding_kobo,
    COALESCE((SELECT SUM(sr.total_reversed_kobo) FROM sale_reversals sr WHERE sr.sale_id = s.id AND sr.reversal_type = 'refund'), 0) AS refunded_total_kobo,
    su.full_name AS sold_by_name,
    du.full_name AS discount_authorized_by_name,
    vu.full_name AS voided_by_name
  FROM sales s
  LEFT JOIN users su ON su.id = s.sold_by
  LEFT JOIN users du ON du.id = s.discount_authorized_by
  LEFT JOIN users vu ON vu.id = s.voided_by`;

export function mapSaleSummary(row: SaleHeaderRow): SaleSummary {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    customerId: row.customer_id,
    customerName: row.customer_name_snapshot,
    customerPhone: row.customer_phone_snapshot,
    itemCount: Number(row.item_count),
    subtotalKobo: Number(row.subtotal_kobo),
    lineDiscountTotalKobo: Number(row.line_discount_total_kobo),
    cartDiscountKobo: Number(row.cart_discount_kobo),
    discountTotalKobo: Number(row.discount_total_kobo),
    discountReason: row.discount_reason,
    discountAuthorizedBy: row.discount_authorized_by,
    discountAuthorizedByName: row.discount_authorized_by_name,
    totalKobo: Number(row.total_kobo),
    tenderedKobo: Number(row.tendered_kobo),
    changeDueKobo: Number(row.change_due_kobo),
    amountPaidKobo: Number(row.amount_paid_kobo),
    initialOutstandingKobo: Number(row.initial_outstanding_kobo),
    currentOutstandingKobo: Number(row.current_outstanding_kobo),
    refundedTotalKobo: Number(row.refunded_total_kobo),
    status: row.status,
    paymentStatus: row.payment_status,
    notes: row.notes,
    soldBy: row.sold_by,
    soldByName: row.sold_by_name,
    voidedAt: row.voided_at,
    voidedByName: row.voided_by_name,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type SaleItemRow = {
  id: string;
  sale_id: string;
  product_id: string;
  product_name_snapshot: string;
  product_sku_snapshot: string | null;
  product_type_snapshot: ProductType;
  unit_id: string;
  unit_name_snapshot: string;
  unit_symbol_snapshot: string;
  conversion_factor: number;
  quantity: number;
  base_quantity: number;
  unit_price_kobo: number;
  line_subtotal_kobo: number;
  line_discount_kobo: number;
  line_total_kobo: number;
  net_total_kobo: number;
  cogs_kobo: number;
  quantity_refunded_base: number;
  amount_refunded_kobo: number;
};

type AllocationRow = {
  id: string;
  sale_item_id: string;
  batch_id: string | null;
  batch_number_snapshot: string | null;
  expiry_date_snapshot: string | null;
  movement_id: string;
  base_quantity: number;
  unit_cost_kobo: number;
  quantity_reversed: number;
};

type SalePaymentRow = {
  id: string;
  payment_kind: PaymentKind;
  method: LedgerPaymentMethod;
  tendered_kobo: number;
  change_kobo: number;
  net_amount_kobo: number;
  reference: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  created_at: string;
};

type SaleReversalRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  reversal_number: string;
  reversal_type: 'void' | 'refund';
  reason: string;
  restock_items: number;
  total_reversed_kobo: number;
  cash_refunded_kobo: number;
  debt_reduced_kobo: number;
  refund_method: PaymentMethod | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};

export async function getSaleDetail(db: SqlExecutor, id: string): Promise<SaleDetail> {
  const header = (await db.all<SaleHeaderRow>(`${saleHeaderSelect} WHERE s.id = ?`, [id]))[0];
  if (!header) throw new ApiError(404, 'SALE_NOT_FOUND', 'This sale record does not exist.');

  const itemRows = await db.all<SaleItemRow>(
    'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid ASC',
    [id],
  );
  const allocationRows = await db.all<AllocationRow>(
    `SELECT * FROM sale_item_allocations
     WHERE sale_id = ?
     ORDER BY CASE WHEN expiry_date_snapshot IS NULL THEN 1 ELSE 0 END ASC, expiry_date_snapshot ASC, rowid ASC`,
    [id],
  );
  const allocationsByItem = new Map<string, SaleAllocationSummary[]>();
  for (const alloc of allocationRows) {
    const list = allocationsByItem.get(alloc.sale_item_id) ?? [];
    list.push({
      id: alloc.id,
      batchId: alloc.batch_id,
      batchNumber: alloc.batch_number_snapshot,
      expiryDate: alloc.expiry_date_snapshot,
      movementId: alloc.movement_id,
      baseQuantity: Number(alloc.base_quantity),
      unitCostKobo: Number(alloc.unit_cost_kobo),
      quantityReversed: Number(alloc.quantity_reversed),
    });
    allocationsByItem.set(alloc.sale_item_id, list);
  }

  const items: SaleItemDetail[] = itemRows.map((row) => {
    const factor = Number(row.conversion_factor);
    const qty = Number(row.quantity);
    const baseQty = Number(row.base_quantity);
    const refundedBase = Number(row.quantity_refunded_base);
    const quantityRefunded = Math.floor(refundedBase / factor);
    const remainingBase = baseQty - refundedBase;
    return {
      id: row.id,
      productId: row.product_id,
      productName: row.product_name_snapshot,
      productSku: row.product_sku_snapshot,
      productType: row.product_type_snapshot,
      unitId: row.unit_id,
      unitName: row.unit_name_snapshot,
      unitSymbol: row.unit_symbol_snapshot,
      conversionFactor: factor,
      quantity: qty,
      baseQuantity: baseQty,
      unitPriceKobo: Number(row.unit_price_kobo),
      lineSubtotalKobo: Number(row.line_subtotal_kobo),
      lineDiscountKobo: Number(row.line_discount_kobo),
      lineTotalKobo: Number(row.line_total_kobo),
      netTotalKobo: Number(row.net_total_kobo),
      quantityRefunded,
      quantityRefundedBase: refundedBase,
      refundableQuantity: Math.floor(remainingBase / factor),
      amountRefundedKobo: Number(row.amount_refunded_kobo),
      allocations: allocationsByItem.get(row.id) ?? [],
    };
  });

  const paymentRows = await db.all<SalePaymentRow>(
    `SELECT sp.*, u.full_name AS recorded_by_name
    FROM sale_payments sp LEFT JOIN users u ON u.id = sp.recorded_by
    WHERE sp.sale_id = ? ORDER BY sp.created_at ASC, sp.id ASC`,
    [id],
  );
  const payments: SalePaymentSummary[] = paymentRows.map((row) => ({
    id: row.id,
    paymentKind: row.payment_kind,
    method: row.method,
    tenderedKobo: Number(row.tendered_kobo),
    changeKobo: Number(row.change_kobo),
    netAmountKobo: Number(row.net_amount_kobo),
    reference: row.reference,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    createdAt: row.created_at,
  }));

  const reversalRows = await db.all<SaleReversalRow>(
    `SELECT sr.*, u.full_name AS created_by_name
    FROM sale_reversals sr LEFT JOIN users u ON u.id = sr.created_by
    WHERE sr.sale_id = ? ORDER BY sr.created_at DESC, sr.id DESC`,
    [id],
  );
  const reversalItemRows = reversalRows.length
    ? await db.all<{
        id: string;
        reversal_id: string;
        sale_item_id: string;
        product_id: string;
        product_name_snapshot: string;
        unit_symbol_snapshot: string;
        quantity: number;
        base_quantity: number;
        amount_kobo: number;
        restocked: number;
      }>(
        `SELECT sri.*, si.product_name_snapshot, si.unit_symbol_snapshot
        FROM sale_reversal_items sri
        JOIN sale_items si ON si.id = sri.sale_item_id
        WHERE sri.reversal_id IN (${reversalRows.map(() => '?').join(',')})
        ORDER BY sri.created_at ASC, sri.id ASC`,
        reversalRows.map((r) => r.id),
      )
    : [];
  const revItemsByReversal = new Map<string, SaleReversalSummary['items']>();
  for (const item of reversalItemRows) {
    const list = revItemsByReversal.get(item.reversal_id) ?? [];
    list.push({
      id: item.id,
      saleItemId: item.sale_item_id,
      productId: item.product_id,
      productName: item.product_name_snapshot,
      unitSymbol: item.unit_symbol_snapshot,
      quantity: Number(item.quantity),
      baseQuantity: Number(item.base_quantity),
      amountKobo: Number(item.amount_kobo),
      restocked: item.restocked === 1,
    });
    revItemsByReversal.set(item.reversal_id, list);
  }

  const reversals: SaleReversalSummary[] = reversalRows.map((row) => ({
    id: row.id,
    reversalNumber: row.reversal_number,
    reversalType: row.reversal_type,
    reason: row.reason,
    restockItems: row.restock_items === 1,
    totalReversedKobo: Number(row.total_reversed_kobo),
    cashRefundedKobo: Number(row.cash_refunded_kobo),
    debtReducedKobo: Number(row.debt_reduced_kobo),
    refundMethod: row.refund_method,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    items: revItemsByReversal.get(row.id) ?? [],
  }));

  const debtRow = (await db.all<DebtRow>(`${debtSelect} WHERE d.sale_id = ?`, [id]))[0];

  return {
    ...mapSaleSummary(header),
    items,
    payments,
    reversals,
    debt: debtRow ? mapDebt(debtRow) : null,
    shop: await readShopSettings(db),
  };
}

export async function getSaleByReceiptNumber(
  db: SqlExecutor,
  receiptNumber: string,
): Promise<SaleDetail> {
  const row = (
    await db.all<{ id: string }>('SELECT id FROM sales WHERE receipt_number = ? COLLATE NOCASE', [
      receiptNumber.trim(),
    ])
  )[0];
  if (!row) throw new ApiError(404, 'SALE_NOT_FOUND', 'No sale matches that receipt number.');
  return getSaleDetail(db, row.id);
}

export async function listSales(
  db: SqlExecutor,
  query: {
    search?: string;
    customerId?: string;
    status?: SaleStatus;
    paymentStatus?: SalePaymentStatus;
    method?: PaymentMethod;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<SaleSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (query.customerId) {
    where.push('s.customer_id = ?');
    values.push(query.customerId);
  }
  if (query.status) {
    where.push('s.status = ?');
    values.push(query.status);
  }
  if (query.paymentStatus) {
    where.push('s.payment_status = ?');
    values.push(query.paymentStatus);
  }
  if (query.method) {
    where.push(
      `EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.payment_kind = 'sale_payment' AND sp.method = ?)`,
    );
    values.push(query.method);
  }
  if (query.search) {
    where.push(
      "(s.receipt_number LIKE ? ESCAPE '\\' OR s.customer_name_snapshot LIKE ? ESCAPE '\\' OR s.customer_phone_snapshot LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    values.push(pattern, pattern, pattern);
  }
  if (query.from) {
    where.push('s.created_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    where.push('s.created_at <= ?');
    values.push(`${query.to}T23:59:59.999Z`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM sales s ${clause}`, values)
  )[0]!.count;
  const rows = await db.all<SaleHeaderRow>(
    `${saleHeaderSelect} ${clause} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapSaleSummary), query.page, query.pageSize, Number(total));
}

/**
 * Distribute a cart-level discount proportionally across line totals in exact integer kobo,
 * guaranteeing `0 <= share[i] <= lineTotal[i]` and `sum(lineTotal[i] - share[i]) === subtotalAfterLine - cartDiscount`.
 */
function distributeCartDiscount(lineTotalsKobo: number[], cartDiscountKobo: number): number[] {
  const totalAfterLine = lineTotalsKobo.reduce((sum, v) => sum + v, 0);
  if (cartDiscountKobo <= 0 || totalAfterLine <= 0) {
    return [...lineTotalsKobo];
  }
  const shares = lineTotalsKobo.map((lineTotal) =>
    Math.floor((cartDiscountKobo * lineTotal) / totalAfterLine),
  );
  let remainder = cartDiscountKobo - shares.reduce((sum, s) => sum + s, 0);
  const indices = lineTotalsKobo
    .map((value, idx) => ({ value, idx }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.idx);
  while (remainder > 0) {
    let progressed = false;
    for (const idx of indices) {
      if (remainder <= 0) break;
      if (shares[idx]! < lineTotalsKobo[idx]!) {
        shares[idx]! += 1;
        remainder -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return lineTotalsKobo.map((lineTotal, idx) => lineTotal - shares[idx]!);
}

export async function createSale(
  db: Database,
  authService: AuthService,
  auth: AuthContext,
  requestId: string,
  input: SaleCreateInput,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  const fingerprint = await operationHash('sale-create-v1', {
    ...(input.prescription ? { prescription: input.prescription } : {}),
    customerId: input.customerId ?? null,
    items: input.items.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      lineDiscountKobo: item.lineDiscountKobo,
    })),
    cartDiscountKobo: input.cartDiscountKobo,
    discountReason: input.discountReason ?? null,
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amountKobo: payment.amountKobo,
      reference: payment.reference ?? null,
    })),
    dueDate: input.dueDate ?? null,
    notes: input.notes ?? null,
  });

  if (input.prescription) await assertPermission(db, auth, 'prescriptions.dispense');

  // Fast idempotency check before any Argon2id supervisor password verification.
  const preExisting = (
    await db.all<{ id: string; operation_fingerprint: string | null }>(
      'SELECT id, operation_fingerprint FROM sales WHERE operation_id = ?',
      [input.operationId],
    )
  )[0];
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint) {
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different sale.',
      );
    }
    return { sale: await getSaleDetail(db, preExisting.id), replayed: true };
  }

  const hasDiscount =
    input.cartDiscountKobo > 0 || input.items.some((item) => item.lineDiscountKobo > 0);
  let verifiedSupervisorId: string | null = null;
  if (hasDiscount && input.discountAuthorization) {
    const verified = await authService.verifySupervisorCredentials(
      input.discountAuthorization.email,
      input.discountAuthorization.password,
      'sales.discount',
      requestId,
    );
    verifiedSupervisorId = verified.userId;
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'sales.create');
    if (input.prescription) await assertPermission(tx, auth, 'prescriptions.dispense');

    const existing = (
      await tx.all<{ id: string; operation_fingerprint: string | null }>(
        'SELECT id, operation_fingerprint FROM sales WHERE operation_id = ?',
        [input.operationId],
      )
    )[0];
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different sale.',
        );
      }
      return { sale: await getSaleDetail(tx, existing.id), replayed: true };
    }

    if (input.payments.length > 0) {
      await assertPermission(tx, auth, 'payments.record');
    }

    let discountAuthorizedBy: string | null = null;
    if (hasDiscount) {
      if (verifiedSupervisorId) {
        await requireSupervisorGrant(tx, verifiedSupervisorId, 'sales.discount');
        discountAuthorizedBy = verifiedSupervisorId;
      } else {
        await assertPermission(tx, auth, 'sales.discount');
        discountAuthorizedBy = auth.user.id;
      }
    }

    // Validate customer if provided
    let customerNameSnapshot = 'Walk-in Customer';
    let customerPhoneSnapshot: string | null = null;
    let existingCustomerDebt = 0;
    let customerCreditLimit: number | null = null;
    if (input.customerId) {
      const customer = await loadCustomerSummary(tx, input.customerId);
      if (customer.status !== 'active') {
        throw new ApiError(
          409,
          'CUSTOMER_INACTIVE',
          'Reactivate this customer before recording a sale for them.',
        );
      }
      customerNameSnapshot = customer.fullName;
      customerPhoneSnapshot = customer.phone;
      existingCustomerDebt = customer.outstandingBalanceKobo;
      customerCreditLimit = customer.creditLimitKobo;
    }

    const today = todayIso();
    const now = new Date().toISOString();
    const saleId = crypto.randomUUID();
    const receiptNumber = await nextSequenceCode(tx, 'MM', today, 4);

    // Prepare line calculations and deduct FEFO stock atomically
    type PreparedLine = {
      id: string;
      productId: string;
      productName: string;
      productSku: string | null;
      productType: ProductType;
      unitId: string;
      unitName: string;
      unitSymbol: string;
      factor: number;
      quantity: number;
      baseQuantity: number;
      unitPriceKobo: number;
      lineSubtotalKobo: number;
      lineDiscountKobo: number;
      lineTotalKobo: number;
      cogsKobo: number;
      allocations: Array<{
        batchId: string | null;
        batchNumber: string | null;
        expiryDate: string | null;
        movementId: string;
        baseQuantity: number;
        unitCostKobo: number;
      }>;
    };

    const preparedLines: PreparedLine[] = [];
    for (const item of input.items) {
      const product = await loadProduct(tx, item.productId);
      if (product.status !== 'active') {
        throw new ApiError(
          409,
          'PRODUCT_INACTIVE',
          `${product.name} is inactive and cannot be sold.`,
        );
      }
      const resolved = await resolveSellingUnit(tx, product, item.unitId, item.quantity);
      const unitPriceKobo = Number(product.selling_price_kobo) * resolved.factor;
      const lineSubtotalKobo = unitPriceKobo * item.quantity;
      if (!Number.isSafeInteger(lineSubtotalKobo) || lineSubtotalKobo < 0) {
        throw new ApiError(400, 'AMOUNT_INVALID', 'Line subtotal exceeds safe integer bounds.');
      }
      if (item.lineDiscountKobo > lineSubtotalKobo) {
        throw new ApiError(
          400,
          'DISCOUNT_EXCEEDS_SUBTOTAL',
          `Line discount on ${product.name} cannot exceed its line subtotal.`,
        );
      }
      const lineTotalKobo = lineSubtotalKobo - item.lineDiscountKobo;

      // Load current stock balance and batch rows to enforce FEFO and exclude expired batches
      const balanceRow = (
        await tx.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id = ?',
          [product.id],
        )
      )[0];
      const currentStock = Number(balanceRow?.quantity ?? 0);

      const batchRows = await tx.all<{
        id: string;
        batch_number: string;
        expiry_date: string | null;
        quantity_remaining: number;
        purchase_cost_kobo: number;
      }>(
        `SELECT id, batch_number, expiry_date, quantity_remaining, purchase_cost_kobo
        FROM product_batches
        WHERE product_id = ? AND quantity_remaining > 0
        ORDER BY (expiry_date IS NULL) ASC, expiry_date ASC, recorded_at ASC, id ASC`,
        [product.id],
      );

      const validBatches = batchRows.filter((b) => !b.expiry_date || b.expiry_date >= today);
      const expiredBatches = batchRows.filter((b) =>
        Boolean(b.expiry_date && b.expiry_date < today),
      );
      const totalBatched = batchRows.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);
      const validBatched = validBatches.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);
      const expiredBatched = expiredBatches.reduce(
        (sum, b) => sum + Number(b.quantity_remaining),
        0,
      );
      const unbatchedAvailable =
        product.is_expiry_tracked === 1 ? 0 : Math.max(0, currentStock - totalBatched);
      const sellableAvailable = validBatched + unbatchedAvailable;

      if (sellableAvailable < resolved.baseQuantity) {
        if (sellableAvailable + expiredBatched >= resolved.baseQuantity) {
          throw new ApiError(
            409,
            'EXPIRED_STOCK_UNAVAILABLE',
            `Cannot sell expired stock for ${product.name}. Only ${sellableAvailable} non-expired ${product.base_unit_symbol} available.`,
          );
        }
        throw new ApiError(
          409,
          'INSUFFICIENT_STOCK',
          `Insufficient stock for ${product.name}. Available: ${sellableAvailable} ${product.base_unit_symbol}, requested: ${resolved.baseQuantity} ${product.base_unit_symbol}.`,
        );
      }

      let remainingToAllocate = resolved.baseQuantity;
      let lineCogsKobo = 0;
      const allocations: PreparedLine['allocations'] = [];

      for (const batch of validBatches) {
        if (remainingToAllocate <= 0) break;
        const take = Math.min(remainingToAllocate, Number(batch.quantity_remaining));
        const batchCostKobo = Number(batch.purchase_cost_kobo);
        const movementResult = await recordMovement(
          tx,
          { auth, requestId },
          {
            productId: product.id,
            batchId: batch.id,
            movementType: 'sale',
            delta: -take,
            unitCostKobo: batchCostKobo,
            reason: `POS sale ${receiptNumber}`,
            referenceId: receiptNumber,
            supplierId: null,
            operationId: null,
            operationFingerprint: '',
            baseQuantity: take,
          },
        );
        allocations.push({
          batchId: batch.id,
          batchNumber: batch.batch_number,
          expiryDate: batch.expiry_date,
          movementId: movementResult.movement.id,
          baseQuantity: take,
          unitCostKobo: batchCostKobo,
        });
        lineCogsKobo += take * batchCostKobo;
        remainingToAllocate -= take;
      }

      if (remainingToAllocate > 0) {
        const fallbackCostKobo = Number(product.purchase_cost_kobo);
        const movementResult = await recordMovement(
          tx,
          { auth, requestId },
          {
            productId: product.id,
            batchId: null,
            movementType: 'sale',
            delta: -remainingToAllocate,
            unitCostKobo: fallbackCostKobo,
            reason: `POS sale ${receiptNumber}`,
            referenceId: receiptNumber,
            supplierId: null,
            operationId: null,
            operationFingerprint: '',
            baseQuantity: remainingToAllocate,
          },
        );
        allocations.push({
          batchId: null,
          batchNumber: null,
          expiryDate: null,
          movementId: movementResult.movement.id,
          baseQuantity: remainingToAllocate,
          unitCostKobo: fallbackCostKobo,
        });
        lineCogsKobo += remainingToAllocate * fallbackCostKobo;
      }

      preparedLines.push({
        id: crypto.randomUUID(),
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        productType: product.product_type,
        unitId: resolved.unitId,
        unitName: resolved.unitName,
        unitSymbol: resolved.unitSymbol,
        factor: resolved.factor,
        quantity: item.quantity,
        baseQuantity: resolved.baseQuantity,
        unitPriceKobo,
        lineSubtotalKobo,
        lineDiscountKobo: item.lineDiscountKobo,
        lineTotalKobo,
        cogsKobo: lineCogsKobo,
        allocations,
      });
    }

    const subtotalKobo = preparedLines.reduce((sum, l) => sum + l.lineSubtotalKobo, 0);
    const lineDiscountTotalKobo = preparedLines.reduce((sum, l) => sum + l.lineDiscountKobo, 0);
    const subtotalAfterLineDiscountKobo = subtotalKobo - lineDiscountTotalKobo;
    if (input.cartDiscountKobo > subtotalAfterLineDiscountKobo) {
      throw new ApiError(
        400,
        'DISCOUNT_EXCEEDS_SUBTOTAL',
        'Cart discount cannot exceed the remaining subtotal.',
      );
    }
    const discountTotalKobo = lineDiscountTotalKobo + input.cartDiscountKobo;
    const totalKobo = subtotalKobo - discountTotalKobo;
    const totalCogsKobo = preparedLines.reduce((sum, l) => sum + l.cogsKobo, 0);
    const netLineTotals = distributeCartDiscount(
      preparedLines.map((l) => l.lineTotalKobo),
      input.cartDiscountKobo,
    );

    // Payment math (integer kobo only)
    const tenderedKobo = input.payments.reduce((sum, p) => sum + p.amountKobo, 0);
    let changeDueKobo: number;
    let amountPaidKobo: number;
    let initialOutstandingKobo: number;
    let paymentStatus: SalePaymentStatus;

    if (totalKobo === 0 && tenderedKobo > 0) {
      throw new ApiError(
        400,
        'OVERPAYMENT_ON_ZERO_SALE',
        'No payment should be tendered when the grand total is zero.',
      );
    }

    if (tenderedKobo >= totalKobo) {
      changeDueKobo = tenderedKobo - totalKobo;
      amountPaidKobo = totalKobo;
      initialOutstandingKobo = 0;
      paymentStatus = 'paid';
      if (changeDueKobo > 0) {
        const cashTendered = input.payments
          .filter((p) => p.method === 'cash')
          .reduce((sum, p) => sum + p.amountKobo, 0);
        if (cashTendered < changeDueKobo) {
          throw new ApiError(
            400,
            'OVERPAYMENT_REQUIRES_CASH',
            'Change due on an overpayment cannot exceed the cash amount tendered.',
          );
        }
      }
    } else {
      changeDueKobo = 0;
      amountPaidKobo = tenderedKobo;
      initialOutstandingKobo = totalKobo - amountPaidKobo;
      paymentStatus = amountPaidKobo === 0 ? 'credit' : 'partial';
      if (!input.customerId) {
        throw new ApiError(
          400,
          'CUSTOMER_REQUIRED_FOR_CREDIT',
          'Select or register a customer before completing a credit or part-payment sale.',
        );
      }
      if (
        customerCreditLimit !== null &&
        existingCustomerDebt + initialOutstandingKobo > customerCreditLimit
      ) {
        throw new ApiError(
          409,
          'CREDIT_LIMIT_EXCEEDED',
          "This sale would exceed the customer's configured credit limit.",
        );
      }
    }

    await tx.run(
      `INSERT INTO sales (
        id, operation_id, operation_fingerprint, receipt_number,
        customer_id, customer_name_snapshot, customer_phone_snapshot,
        subtotal_kobo, line_discount_total_kobo, cart_discount_kobo, discount_total_kobo,
        discount_reason, discount_authorized_by,
        total_kobo, cogs_kobo, tendered_kobo, change_due_kobo, amount_paid_kobo, initial_outstanding_kobo,
        status, payment_status, notes, sold_by, device_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        saleId,
        input.operationId,
        fingerprint,
        receiptNumber,
        input.customerId ?? null,
        customerNameSnapshot,
        customerPhoneSnapshot,
        subtotalKobo,
        lineDiscountTotalKobo,
        input.cartDiscountKobo,
        discountTotalKobo,
        hasDiscount ? (input.discountReason ?? null) : null,
        hasDiscount ? discountAuthorizedBy : null,
        totalKobo,
        totalCogsKobo,
        tenderedKobo,
        changeDueKobo,
        amountPaidKobo,
        initialOutstandingKobo,
        'completed',
        paymentStatus,
        input.notes ?? null,
        auth.user.id,
        auth.deviceId,
        now,
        now,
      ],
    );

    for (const [idx, line] of preparedLines.entries()) {
      await tx.run(
        `INSERT INTO sale_items (
          id, sale_id, product_id, product_name_snapshot, product_sku_snapshot, product_type_snapshot,
          unit_id, unit_name_snapshot, unit_symbol_snapshot, conversion_factor,
          quantity, base_quantity, unit_price_kobo, line_subtotal_kobo, line_discount_kobo,
          line_total_kobo, net_total_kobo, cogs_kobo, quantity_refunded_base, amount_refunded_kobo, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          line.id,
          saleId,
          line.productId,
          line.productName,
          line.productSku,
          line.productType,
          line.unitId,
          line.unitName,
          line.unitSymbol,
          line.factor,
          line.quantity,
          line.baseQuantity,
          line.unitPriceKobo,
          line.lineSubtotalKobo,
          line.lineDiscountKobo,
          line.lineTotalKobo,
          netLineTotals[idx]!,
          line.cogsKobo,
          0,
          0,
          now,
        ],
      );
      for (const alloc of line.allocations) {
        await tx.run(
          `INSERT INTO sale_item_allocations (
            id, sale_id, sale_item_id, product_id, batch_id, batch_number_snapshot, expiry_date_snapshot,
            movement_id, base_quantity, unit_cost_kobo, quantity_reversed, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            line.id,
            line.productId,
            alloc.batchId,
            alloc.batchNumber,
            alloc.expiryDate,
            alloc.movementId,
            alloc.baseQuantity,
            alloc.unitCostKobo,
            0,
            now,
          ],
        );
      }
    }

    // Allocate change due across cash payment leg(s) (last cash leg first) so net_amount_kobo sums to amountPaidKobo.
    let remainingChangeToAssign = changeDueKobo;
    const preparedPayments = input.payments.map((leg) => ({
      method: leg.method,
      tenderedKobo: leg.amountKobo,
      changeKobo: 0,
      reference: leg.reference ?? null,
    }));
    for (let i = preparedPayments.length - 1; i >= 0 && remainingChangeToAssign > 0; i--) {
      const leg = preparedPayments[i]!;
      if (leg.method !== 'cash') continue;
      const takeChange = Math.min(leg.tenderedKobo, remainingChangeToAssign);
      leg.changeKobo = takeChange;
      remainingChangeToAssign -= takeChange;
    }
    // Fold any wholly-returned cash leg onto an active cash leg so every stored sale_payment has net_amount_kobo > 0.
    const activePayments = preparedPayments.filter((p) => p.tenderedKobo - p.changeKobo > 0);
    for (const zeroNetLeg of preparedPayments.filter((p) => p.tenderedKobo - p.changeKobo === 0)) {
      const targetCash = activePayments.find((p) => p.method === 'cash');
      if (targetCash) {
        targetCash.tenderedKobo += zeroNetLeg.tenderedKobo;
        targetCash.changeKobo += zeroNetLeg.changeKobo;
      }
    }

    for (const leg of activePayments) {
      const netAmount = leg.tenderedKobo - leg.changeKobo;
      await tx.run(
        `INSERT INTO sale_payments (
          id, sale_id, operation_id, payment_kind, method,
          tendered_kobo, change_kobo, net_amount_kobo, reference,
          recorded_by, device_id, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          saleId,
          null,
          'sale_payment',
          leg.method,
          leg.tenderedKobo,
          leg.changeKobo,
          netAmount,
          leg.reference,
          auth.user.id,
          auth.deviceId,
          now,
        ],
      );
    }

    if (initialOutstandingKobo > 0 && input.customerId) {
      const debtId = crypto.randomUUID();
      const debtStatus = amountPaidKobo > 0 ? 'partial' : 'open';
      await tx.run(
        `INSERT INTO customer_debts (
          id, customer_id, sale_id, original_amount_kobo, amount_paid_kobo, amount_cancelled_kobo,
          outstanding_kobo, due_date, status, notes, created_by, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          debtId,
          input.customerId,
          saleId,
          initialOutstandingKobo,
          0,
          0,
          initialOutstandingKobo,
          input.dueDate ?? null,
          debtStatus,
          input.notes ?? null,
          auth.user.id,
          now,
          now,
        ],
      );
      await audit(tx, {
        action: 'debt.created',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId,
        entityType: 'customer_debt',
        entityId: debtId,
        metadata: {
          saleId,
          receiptNumber,
          customerId: input.customerId,
          outstandingKobo: initialOutstandingKobo,
        },
      });
    }

    if (hasDiscount && discountAuthorizedBy) {
      await audit(tx, {
        action: 'sale.discount_applied',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId,
        entityType: 'sale',
        entityId: saleId,
        metadata: {
          receiptNumber,
          discountTotalKobo,
          lineDiscountTotalKobo,
          cartDiscountKobo: input.cartDiscountKobo,
          authorizedBy: discountAuthorizedBy,
          supervisorOverride: discountAuthorizedBy !== auth.user.id,
          reason: input.discountReason ?? '',
        },
      });
    }

    await audit(tx, {
      action: 'sale.completed',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'sale',
      entityId: saleId,
      metadata: {
        receiptNumber,
        subtotalKobo,
        discountTotalKobo,
        totalKobo,
        tenderedKobo,
        amountPaidKobo,
        changeDueKobo,
        outstandingKobo: initialOutstandingKobo,
        paymentStatus,
        itemCount: preparedLines.length,
      },
    });

    if (input.prescription)
      await completePrescriptionCheckout(
        tx,
        auth,
        requestId,
        input.prescription.id,
        saleId,
        input.operationId,
        fingerprint,
        preparedLines,
      );
    return { sale: await getSaleDetail(tx, saleId), replayed: false };
  });
}

export async function voidSale(
  db: Database,
  auth: AuthContext,
  requestId: string,
  saleId: string,
  input: SaleVoidInput,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  const fingerprint = await operationHash('sale-void-v1', {
    saleId,
    reason: input.reason,
    refundMethod: input.refundMethod ?? null,
  });

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'sales.void');
    await protectClinicalSaleReversal(tx, saleId);

    const existingRev = (
      await tx.all<{ sale_id: string; operation_fingerprint: string | null }>(
        'SELECT sale_id, operation_fingerprint FROM sale_reversals WHERE operation_id = ?',
        [input.operationId],
      )
    )[0];
    if (existingRev) {
      if (existingRev.operation_fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different void or refund.',
        );
      }
      return { sale: await getSaleDetail(tx, existingRev.sale_id), replayed: true };
    }

    const sale = (await tx.all<SaleHeaderRow>(`${saleHeaderSelect} WHERE s.id = ?`, [saleId]))[0];
    if (!sale) throw new ApiError(404, 'SALE_NOT_FOUND', 'This sale record does not exist.');
    if (sale.status === 'voided') {
      throw new ApiError(409, 'SALE_ALREADY_VOIDED', 'This sale has already been voided.');
    }
    if (sale.status === 'partially_refunded' || sale.status === 'refunded') {
      throw new ApiError(
        409,
        'SALE_HAS_REFUNDS',
        'A sale with existing refunds cannot be voided; process a refund for any remaining items instead.',
      );
    }

    const now = new Date().toISOString();
    const reversalNumber = await nextSequenceCode(tx, 'REV', todayIso(), 4);
    const reversalId = crypto.randomUUID();

    // Restock every allocation to its exact batch without inflating quantity_received
    const itemRows = await tx.all<SaleItemRow>(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY created_at ASC, id ASC',
      [saleId],
    );
    const allocations = await tx.all<AllocationRow>(
      'SELECT * FROM sale_item_allocations WHERE sale_id = ? ORDER BY created_at ASC, id ASC',
      [saleId],
    );

    let totalCogsReversed = 0;
    for (const alloc of allocations) {
      const remainingQty = Number(alloc.base_quantity) - Number(alloc.quantity_reversed);
      if (remainingQty <= 0) continue;
      await recordMovement(
        tx,
        { auth, requestId },
        {
          productId: itemRows.find((i) => i.id === alloc.sale_item_id)?.product_id ?? '',
          batchId: alloc.batch_id,
          movementType: 'sale_void',
          delta: remainingQty,
          unitCostKobo: Number(alloc.unit_cost_kobo),
          reason: `Void sale ${sale.receipt_number}: ${input.reason}`,
          referenceId: reversalNumber,
          supplierId: null,
          operationId: null,
          operationFingerprint: '',
          baseQuantity: remainingQty,
        },
      );
      await tx.run('UPDATE sale_item_allocations SET quantity_reversed = ? WHERE id = ?', [
        Number(alloc.base_quantity),
        alloc.id,
      ]);
      totalCogsReversed += remainingQty * Number(alloc.unit_cost_kobo);
    }

    // Cancel unpaid customer debt if present, and reverse any money actually paid
    const debt = (await tx.all<DebtRow>(`${debtSelect} WHERE d.sale_id = ?`, [saleId]))[0];
    let debtReducedKobo = 0;
    let debtRepaidAlreadyKobo = 0;
    if (debt) {
      debtReducedKobo = Number(debt.outstanding_kobo);
      debtRepaidAlreadyKobo = Number(debt.amount_paid_kobo);
      const nextCancelled = Number(debt.amount_cancelled_kobo) + debtReducedKobo;
      await tx.run(
        `UPDATE customer_debts
        SET amount_cancelled_kobo = ?, outstanding_kobo = 0, status = 'cancelled', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`,
        [nextCancelled, now, debt.id, debt.version],
      );
      if (debtReducedKobo > 0) {
        await tx.run(
          `INSERT INTO sale_payments (
            id, sale_id, operation_id, payment_kind, method,
            tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            null,
            'void_reversal',
            'credit_reduction',
            debtReducedKobo,
            0,
            debtReducedKobo,
            reversalNumber,
            auth.user.id,
            auth.deviceId,
            now,
          ],
        );
      }
    }

    const originalSalePayments = await tx.all<SalePaymentRow>(
      `SELECT sp.*, NULL AS recorded_by_name
      FROM sale_payments sp
      WHERE sp.sale_id = ? AND sp.payment_kind = 'sale_payment'
      ORDER BY sp.created_at ASC, sp.id ASC`,
      [saleId],
    );
    let cashRefundedKobo = 0;
    if (input.refundMethod) {
      const totalMoneyPaid = Number(sale.amount_paid_kobo) + debtRepaidAlreadyKobo;
      if (totalMoneyPaid > 0) {
        await tx.run(
          `INSERT INTO sale_payments (
            id, sale_id, operation_id, payment_kind, method,
            tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            null,
            'void_reversal',
            input.refundMethod,
            totalMoneyPaid,
            0,
            totalMoneyPaid,
            reversalNumber,
            auth.user.id,
            auth.deviceId,
            now,
          ],
        );
        cashRefundedKobo = totalMoneyPaid;
      }
    } else {
      for (const orig of originalSalePayments) {
        const net = Number(orig.net_amount_kobo);
        if (net <= 0) continue;
        await tx.run(
          `INSERT INTO sale_payments (
            id, sale_id, operation_id, payment_kind, method,
            tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            null,
            'void_reversal',
            orig.method,
            net,
            0,
            net,
            reversalNumber,
            auth.user.id,
            auth.deviceId,
            now,
          ],
        );
        cashRefundedKobo += net;
      }
      if (debtRepaidAlreadyKobo > 0) {
        await tx.run(
          `INSERT INTO sale_payments (
            id, sale_id, operation_id, payment_kind, method,
            tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            null,
            'void_reversal',
            'cash',
            debtRepaidAlreadyKobo,
            0,
            debtRepaidAlreadyKobo,
            reversalNumber,
            auth.user.id,
            auth.deviceId,
            now,
          ],
        );
        cashRefundedKobo += debtRepaidAlreadyKobo;
      }
    }

    await tx.run(
      `INSERT INTO sale_reversals (
        id, operation_id, operation_fingerprint, sale_id, reversal_number, reversal_type,
        reason, restock_items, total_reversed_kobo, cogs_reversed_kobo,
        cash_refunded_kobo, debt_reduced_kobo, refund_method, created_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        reversalId,
        input.operationId,
        fingerprint,
        saleId,
        reversalNumber,
        'void',
        input.reason,
        1,
        Number(sale.total_kobo),
        totalCogsReversed,
        cashRefundedKobo,
        debtReducedKobo,
        input.refundMethod ?? null,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );

    for (const item of itemRows) {
      await tx.run(
        `INSERT INTO sale_reversal_items (
          id, reversal_id, sale_item_id, product_id, quantity, base_quantity,
          amount_kobo, cogs_reversed_kobo, restocked, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          reversalId,
          item.id,
          item.product_id,
          Number(item.quantity),
          Number(item.base_quantity),
          Number(item.net_total_kobo),
          Number(item.cogs_kobo),
          1,
          now,
        ],
      );
      await tx.run(
        'UPDATE sale_items SET quantity_refunded_base = ?, amount_refunded_kobo = ? WHERE id = ?',
        [Number(item.base_quantity), Number(item.net_total_kobo), item.id],
      );
    }

    const updatedSale = await tx.run(
      `UPDATE sales
      SET status = 'voided', payment_status = 'voided', voided_at = ?, voided_by = ?, void_reason = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`,
      [now, auth.user.id, input.reason, now, saleId, sale.version],
    );
    if (updatedSale.changes !== 1) {
      throw new ApiError(409, 'SALE_CONFLICT', 'The sale changed while voiding. Reload and retry.');
    }

    await audit(tx, {
      action: 'sale.voided',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'sale',
      entityId: saleId,
      metadata: {
        receiptNumber: sale.receipt_number,
        reversalNumber,
        totalReversedKobo: Number(sale.total_kobo),
        cashRefundedKobo,
        debtReducedKobo,
        reason: input.reason,
      },
    });

    return { sale: await getSaleDetail(tx, saleId), replayed: false };
  });
}

export async function refundSale(
  db: Database,
  auth: AuthContext,
  requestId: string,
  saleId: string,
  input: SaleRefundInput,
): Promise<{ sale: SaleDetail; replayed: boolean }> {
  const fingerprint = await operationHash('sale-refund-v1', {
    saleId,
    reason: input.reason,
    restockItems: input.restockItems,
    refundMethod: input.refundMethod,
    reference: input.reference ?? null,
    items: input.items,
  });

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'sales.refund');
    await protectClinicalSaleReversal(tx, saleId);

    const existingRev = (
      await tx.all<{ sale_id: string; operation_fingerprint: string | null }>(
        'SELECT sale_id, operation_fingerprint FROM sale_reversals WHERE operation_id = ?',
        [input.operationId],
      )
    )[0];
    if (existingRev) {
      if (existingRev.operation_fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different void or refund.',
        );
      }
      return { sale: await getSaleDetail(tx, existingRev.sale_id), replayed: true };
    }

    const sale = (await tx.all<SaleHeaderRow>(`${saleHeaderSelect} WHERE s.id = ?`, [saleId]))[0];
    if (!sale) throw new ApiError(404, 'SALE_NOT_FOUND', 'This sale record does not exist.');
    if (sale.status === 'voided') {
      throw new ApiError(409, 'SALE_VOIDED', 'A voided sale cannot be refunded.');
    }
    if (sale.status === 'refunded') {
      throw new ApiError(
        409,
        'SALE_ALREADY_REFUNDED',
        'All items on this sale have already been refunded.',
      );
    }

    const itemRows = await tx.all<SaleItemRow>(
      'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY created_at ASC, id ASC',
      [saleId],
    );
    const itemsById = new Map(itemRows.map((row) => [row.id, row]));

    const now = new Date().toISOString();
    const reversalNumber = await nextSequenceCode(tx, 'REV', todayIso(), 4);
    const reversalId = crypto.randomUUID();

    type PreparedRefundItem = {
      saleItem: SaleItemRow;
      quantity: number;
      baseQuantity: number;
      newRefundedBase: number;
      refundAmountKobo: number;
      newAmountRefundedKobo: number;
      cogsReversedKobo: number;
    };

    const prepared: PreparedRefundItem[] = [];
    let totalRefundKobo = 0;
    let totalCogsReversedKobo = 0;

    for (const reqItem of input.items) {
      const saleItem = itemsById.get(reqItem.saleItemId);
      if (!saleItem) {
        throw new ApiError(
          400,
          'SALE_ITEM_NOT_FOUND',
          'A selected refund item does not belong to this sale.',
        );
      }
      const factor = Number(saleItem.conversion_factor);
      const refundBaseQty = reqItem.quantity * factor;
      const soldBaseQty = Number(saleItem.base_quantity);
      const alreadyRefundedBase = Number(saleItem.quantity_refunded_base);
      const remainingBase = soldBaseQty - alreadyRefundedBase;
      if (refundBaseQty > remainingBase) {
        throw new ApiError(
          409,
          'REFUND_EXCEEDS_SOLD',
          `Cannot refund ${reqItem.quantity} ${saleItem.unit_symbol_snapshot} of ${saleItem.product_name_snapshot}; only ${Math.floor(remainingBase / factor)} ${saleItem.unit_symbol_snapshot} remain refundable.`,
        );
      }

      const newRefundedBase = alreadyRefundedBase + refundBaseQty;
      const netTotal = Number(saleItem.net_total_kobo);
      const alreadyRefundedKobo = Number(saleItem.amount_refunded_kobo);
      const remainingKobo = netTotal - alreadyRefundedKobo;
      const refundAmountKobo =
        newRefundedBase === soldBaseQty
          ? remainingKobo
          : Math.min(remainingKobo, Math.round((netTotal * refundBaseQty) / soldBaseQty));
      const newAmountRefundedKobo = alreadyRefundedKobo + refundAmountKobo;

      let itemCogsReversed = 0;
      if (input.restockItems) {
        const allocations = await tx.all<AllocationRow>(
          'SELECT * FROM sale_item_allocations WHERE sale_item_id = ? ORDER BY created_at DESC, id DESC',
          [saleItem.id],
        );
        let toRestock = refundBaseQty;
        for (const alloc of allocations) {
          if (toRestock <= 0) break;
          const unreversed = Number(alloc.base_quantity) - Number(alloc.quantity_reversed);
          if (unreversed <= 0) continue;
          const take = Math.min(toRestock, unreversed);
          await recordMovement(
            tx,
            { auth, requestId },
            {
              productId: saleItem.product_id,
              batchId: alloc.batch_id,
              movementType: 'sale_return',
              delta: take,
              unitCostKobo: Number(alloc.unit_cost_kobo),
              reason: `Refund on ${sale.receipt_number}: ${input.reason}`,
              referenceId: reversalNumber,
              supplierId: null,
              operationId: null,
              operationFingerprint: '',
              baseQuantity: take,
            },
          );
          await tx.run('UPDATE sale_item_allocations SET quantity_reversed = ? WHERE id = ?', [
            Number(alloc.quantity_reversed) + take,
            alloc.id,
          ]);
          itemCogsReversed += take * Number(alloc.unit_cost_kobo);
          toRestock -= take;
        }
      }

      prepared.push({
        saleItem,
        quantity: reqItem.quantity,
        baseQuantity: refundBaseQty,
        newRefundedBase,
        refundAmountKobo,
        newAmountRefundedKobo,
        cogsReversedKobo: itemCogsReversed,
      });
      totalRefundKobo += refundAmountKobo;
      totalCogsReversedKobo += itemCogsReversed;
    }

    // Reduce any unpaid debt on this sale first; only refund actual money for the paid remainder
    const debt = (await tx.all<DebtRow>(`${debtSelect} WHERE d.sale_id = ?`, [saleId]))[0];
    let debtReducedKobo = 0;
    if (debt && Number(debt.outstanding_kobo) > 0) {
      debtReducedKobo = Math.min(totalRefundKobo, Number(debt.outstanding_kobo));
      if (debtReducedKobo > 0) {
        const nextOutstanding = Number(debt.outstanding_kobo) - debtReducedKobo;
        const nextCancelled = Number(debt.amount_cancelled_kobo) + debtReducedKobo;
        const nextDebtStatus =
          nextOutstanding === 0
            ? Number(debt.amount_paid_kobo) > 0
              ? 'settled'
              : 'cancelled'
            : Number(debt.amount_paid_kobo) > 0
              ? 'partial'
              : 'open';
        await tx.run(
          `UPDATE customer_debts
          SET amount_cancelled_kobo = ?, outstanding_kobo = ?, status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
          [nextCancelled, nextOutstanding, nextDebtStatus, now, debt.id, debt.version],
        );
        await tx.run(
          `INSERT INTO sale_payments (
            id, sale_id, operation_id, payment_kind, method,
            tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            crypto.randomUUID(),
            saleId,
            null,
            'refund_payout',
            'credit_reduction',
            debtReducedKobo,
            0,
            debtReducedKobo,
            reversalNumber,
            auth.user.id,
            auth.deviceId,
            now,
          ],
        );
      }
    }

    const cashRefundedKobo = totalRefundKobo - debtReducedKobo;
    if (cashRefundedKobo > 0) {
      await tx.run(
        `INSERT INTO sale_payments (
          id, sale_id, operation_id, payment_kind, method,
          tendered_kobo, change_kobo, net_amount_kobo, reference, recorded_by, device_id, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          saleId,
          null,
          'refund_payout',
          input.refundMethod,
          cashRefundedKobo,
          0,
          cashRefundedKobo,
          input.reference ?? reversalNumber,
          auth.user.id,
          auth.deviceId,
          now,
        ],
      );
    }

    await tx.run(
      `INSERT INTO sale_reversals (
        id, operation_id, operation_fingerprint, sale_id, reversal_number, reversal_type,
        reason, restock_items, total_reversed_kobo, cogs_reversed_kobo,
        cash_refunded_kobo, debt_reduced_kobo, refund_method, created_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        reversalId,
        input.operationId,
        fingerprint,
        saleId,
        reversalNumber,
        'refund',
        input.reason,
        input.restockItems ? 1 : 0,
        totalRefundKobo,
        totalCogsReversedKobo,
        cashRefundedKobo,
        debtReducedKobo,
        cashRefundedKobo > 0 ? input.refundMethod : null,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );

    for (const entry of prepared) {
      await tx.run(
        `INSERT INTO sale_reversal_items (
          id, reversal_id, sale_item_id, product_id, quantity, base_quantity,
          amount_kobo, cogs_reversed_kobo, restocked, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          reversalId,
          entry.saleItem.id,
          entry.saleItem.product_id,
          entry.quantity,
          entry.baseQuantity,
          entry.refundAmountKobo,
          entry.cogsReversedKobo,
          input.restockItems ? 1 : 0,
          now,
        ],
      );
      await tx.run(
        'UPDATE sale_items SET quantity_refunded_base = ?, amount_refunded_kobo = ? WHERE id = ?',
        [entry.newRefundedBase, entry.newAmountRefundedKobo, entry.saleItem.id],
      );
    }

    const updatedItems = await tx.all<{ base_quantity: number; quantity_refunded_base: number }>(
      'SELECT base_quantity, quantity_refunded_base FROM sale_items WHERE sale_id = ?',
      [saleId],
    );
    const fullyRefunded = updatedItems.every(
      (row) => Number(row.quantity_refunded_base) >= Number(row.base_quantity),
    );
    const nextSaleStatus: SaleStatus = fullyRefunded ? 'refunded' : 'partially_refunded';
    const nextPaymentStatus: SalePaymentStatus = fullyRefunded
      ? 'refunded'
      : debt && Number(debt.outstanding_kobo) - debtReducedKobo === 0
        ? 'paid'
        : sale.payment_status;

    const updatedSale = await tx.run(
      `UPDATE sales
      SET status = ?, payment_status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`,
      [nextSaleStatus, nextPaymentStatus, now, saleId, sale.version],
    );
    if (updatedSale.changes !== 1) {
      throw new ApiError(
        409,
        'SALE_CONFLICT',
        'The sale changed while refunding. Reload and retry.',
      );
    }

    await audit(tx, {
      action: 'sale.refunded',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'sale',
      entityId: saleId,
      metadata: {
        receiptNumber: sale.receipt_number,
        reversalNumber,
        fullyRefunded,
        restockItems: input.restockItems,
        totalRefundKobo,
        cashRefundedKobo,
        debtReducedKobo,
        refundMethod: cashRefundedKobo > 0 ? input.refundMethod : 'credit_reduction',
        reason: input.reason,
      },
    });

    return { sale: await getSaleDetail(tx, saleId), replayed: false };
  });
}
