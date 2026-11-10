import type { Database, SqlExecutor } from '@medimart/database';
import type {
  Paginated,
  PurchaseCreateInput,
  PurchaseLineStatus,
  PurchaseOrderDetail,
  PurchaseOrderItemSummary,
  PurchaseOrderSummary,
  PurchasePaymentSummary,
  PurchaseUpdateInput,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, likePattern, loadProduct, paginate } from '../inventory/common';
import { nextSequenceCode, operationHash } from '../sales/common';
import {
  loadPurchaseOrderRow,
  listPaymentsForOrder,
  listReceiptsForOrder,
  mapPurchaseOrderSummary,
  purchaseItemSelect,
  purchaseOrderSelect,
  type PurchaseItemRow,
  type PurchaseOrderRow,
} from './records';
import { loadSupplier, requireActiveSupplier } from './common';

type ResolvedPurchaseUnit = {
  unitId: string;
  unitName: string;
  unitSymbol: string;
  factor: number;
  baseQuantity: number;
};

async function resolvePurchaseUnit(
  tx: SqlExecutor,
  product: {
    id: string;
    base_unit_id: string;
    base_unit_name: string;
    base_unit_symbol: string;
  },
  unitId: string,
  quantity: number,
): Promise<ResolvedPurchaseUnit> {
  if (unitId === product.base_unit_id)
    return {
      unitId: product.base_unit_id,
      unitName: product.base_unit_name,
      unitSymbol: product.base_unit_symbol,
      factor: 1,
      baseQuantity: quantity,
    };
  const row = (
    await tx.all<{ unit_id: string; name: string; symbol: string; factor: number }>(
      `SELECT pu.unit_id, u.name, u.symbol, pu.factor
      FROM product_units pu JOIN units u ON u.id = pu.unit_id
      WHERE pu.product_id = ? AND pu.unit_id = ?`,
      [product.id, unitId],
    )
  )[0];
  if (!row)
    throw new ApiError(
      400,
      'UNIT_NOT_CONFIGURED',
      'This purchase unit is not configured for the selected product.',
    );
  const factor = Number(row.factor);
  const baseQuantity = quantity * factor;
  if (!Number.isSafeInteger(baseQuantity) || baseQuantity <= 0)
    throw new ApiError(400, 'QUANTITY_INVALID', 'The converted quantity is not valid.');
  return {
    unitId: row.unit_id,
    unitName: row.name,
    unitSymbol: row.symbol,
    factor,
    baseQuantity,
  };
}

type PreparedLine = {
  productId: string;
  productName: string;
  productSku: string | null;
  productType: PurchaseOrderItemSummary['productType'];
  unitId: string;
  unitName: string;
  unitSymbol: string;
  factor: number;
  quantity: number;
  baseQuantity: number;
  unitCostKobo: number;
  lineSubtotalKobo: number;
  lineDiscountKobo: number;
  lineTotalKobo: number;
};

async function preparePurchaseLines(
  tx: SqlExecutor,
  input: Pick<PurchaseCreateInput, 'items'>,
): Promise<{ lines: PreparedLine[]; subtotalKobo: number; lineDiscountTotalKobo: number }> {
  const lines: PreparedLine[] = [];
  for (const item of input.items) {
    const product = await loadProduct(tx, item.productId);
    if (product.status !== 'active')
      throw new ApiError(
        409,
        'PRODUCT_INACTIVE',
        `Reactivate ${product.name} before adding it to a purchase.`,
      );
    const unit = await resolvePurchaseUnit(tx, product, item.unitId, item.quantity);
    const lineSubtotalKobo = item.unitCostKobo * item.quantity;
    if (!Number.isSafeInteger(lineSubtotalKobo))
      throw new ApiError(400, 'AMOUNT_INVALID', 'The purchase line total is too large.');
    if (item.lineDiscountKobo > lineSubtotalKobo)
      throw new ApiError(
        400,
        'DISCOUNT_TOO_LARGE',
        'A line discount cannot exceed the line subtotal.',
      );
    lines.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      productType: product.product_type,
      unitId: unit.unitId,
      unitName: unit.unitName,
      unitSymbol: unit.unitSymbol,
      factor: unit.factor,
      quantity: item.quantity,
      baseQuantity: unit.baseQuantity,
      unitCostKobo: item.unitCostKobo,
      lineSubtotalKobo,
      lineDiscountKobo: item.lineDiscountKobo,
      lineTotalKobo: lineSubtotalKobo - item.lineDiscountKobo,
    });
  }
  const subtotalKobo = lines.reduce((sum, line) => sum + line.lineSubtotalKobo, 0);
  const lineDiscountTotalKobo = lines.reduce((sum, line) => sum + line.lineDiscountKobo, 0);
  return { lines, subtotalKobo, lineDiscountTotalKobo };
}

function computeTotals(
  input: Pick<PurchaseCreateInput, 'orderDiscountKobo' | 'additionalChargesKobo'>,
  subtotalKobo: number,
  lineDiscountTotalKobo: number,
) {
  if (input.orderDiscountKobo > subtotalKobo - lineDiscountTotalKobo)
    throw new ApiError(
      400,
      'DISCOUNT_TOO_LARGE',
      'The order discount cannot exceed the remaining purchase value.',
    );
  const discountTotalKobo = lineDiscountTotalKobo + input.orderDiscountKobo;
  const totalKobo = subtotalKobo - discountTotalKobo + input.additionalChargesKobo;
  if (!Number.isSafeInteger(totalKobo) || totalKobo < 0)
    throw new ApiError(400, 'AMOUNT_INVALID', 'The purchase total is not valid.');
  return { discountTotalKobo, totalKobo };
}

export async function createPurchase(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: PurchaseCreateInput,
): Promise<PurchaseOrderDetail> {
  const fingerprint = await operationHash('purchase-create-v1', {
    supplierId: input.supplierId,
    items: input.items,
    orderDiscountKobo: input.orderDiscountKobo,
    discountReason: input.discountReason ?? null,
    additionalChargesKobo: input.additionalChargesKobo,
    additionalChargesReason: input.additionalChargesReason ?? null,
    expectedDeliveryDate: input.expectedDeliveryDate ?? null,
    notes: input.notes ?? null,
    status: input.status,
  });
  const preExisting = (
    await db.all<{ id: string; operation_fingerprint: string | null }>(
      'SELECT id, operation_fingerprint FROM purchase_orders WHERE operation_id = ?',
      [input.operationId],
    )
  )[0];
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different purchase order.',
      );
    return getPurchaseDetail(db, preExisting.id);
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'purchases.create');
    const existing = (
      await tx.all<{ id: string; operation_fingerprint: string | null }>(
        'SELECT id, operation_fingerprint FROM purchase_orders WHERE operation_id = ?',
        [input.operationId],
      )
    )[0];
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different purchase order.',
        );
      return getPurchaseDetail(tx, existing.id);
    }

    const supplier = await loadSupplier(tx, input.supplierId);
    requireActiveSupplier(supplier);
    const { lines, subtotalKobo, lineDiscountTotalKobo } = await preparePurchaseLines(tx, input);
    const { discountTotalKobo, totalKobo } = computeTotals(
      input,
      subtotalKobo,
      lineDiscountTotalKobo,
    );

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const referenceNumber = await nextSequenceCode(tx, 'PO');
    await tx.run(
      `INSERT INTO purchase_orders (
        id, operation_id, operation_fingerprint, reference_number, supplier_id,
        supplier_name_snapshot, supplier_phone_snapshot, status, expected_delivery_date,
        subtotal_kobo, line_discount_total_kobo, order_discount_kobo, discount_total_kobo,
        discount_reason, additional_charges_kobo, additional_charges_reason, total_kobo,
        notes, ordered_at, ordered_by, created_by, updated_by, device_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.operationId,
        fingerprint,
        referenceNumber,
        supplier.id,
        supplier.name,
        supplier.phone,
        input.status,
        input.expectedDeliveryDate ?? null,
        subtotalKobo,
        lineDiscountTotalKobo,
        input.orderDiscountKobo,
        discountTotalKobo,
        input.discountReason ?? null,
        input.additionalChargesKobo,
        input.additionalChargesReason ?? null,
        totalKobo,
        input.notes ?? null,
        input.status === 'ordered' ? now : null,
        input.status === 'ordered' ? auth.user.id : null,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
        now,
        now,
      ],
    );
    for (const line of lines) {
      await tx.run(
        `INSERT INTO purchase_order_items (
          id, purchase_order_id, product_id, product_name_snapshot, product_sku_snapshot,
          product_type_snapshot, unit_id, unit_name_snapshot, unit_symbol_snapshot,
          conversion_factor, quantity, base_quantity, unit_cost_kobo, line_subtotal_kobo,
          line_discount_kobo, line_total_kobo, received_base_quantity
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        [
          crypto.randomUUID(),
          id,
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
          line.unitCostKobo,
          line.lineSubtotalKobo,
          line.lineDiscountKobo,
          line.lineTotalKobo,
        ],
      );
    }
    await audit(tx, {
      action: 'purchase.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'purchase_order',
      entityId: id,
      metadata: {
        referenceNumber,
        supplierId: supplier.id,
        status: input.status,
        itemCount: lines.length,
        totalKobo,
      },
    });
    return getPurchaseDetail(tx, id);
  });
}

export async function updatePurchase(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: PurchaseUpdateInput,
): Promise<PurchaseOrderDetail> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'purchases.edit');
    const existing = await loadPurchaseOrderRow(tx, id);
    if (existing.status !== 'draft')
      throw new ApiError(
        409,
        'PURCHASE_LOCKED',
        'Only a draft purchase can be edited. Cancel it and create a new order instead.',
      );
    if (Number(existing.version) !== input.version)
      throw new ApiError(
        409,
        'PURCHASE_CONFLICT',
        'This purchase changed while you were editing it. Reload and try again.',
      );
    const supplier = await loadSupplier(tx, input.supplierId);
    requireActiveSupplier(supplier);
    const { lines, subtotalKobo, lineDiscountTotalKobo } = await preparePurchaseLines(tx, input);
    const { discountTotalKobo, totalKobo } = computeTotals(
      input,
      subtotalKobo,
      lineDiscountTotalKobo,
    );
    const now = new Date().toISOString();
    const updated = await tx.run(
      `UPDATE purchase_orders SET
        supplier_id = ?, supplier_name_snapshot = ?, supplier_phone_snapshot = ?,
        expected_delivery_date = ?, subtotal_kobo = ?, line_discount_total_kobo = ?,
        order_discount_kobo = ?, discount_total_kobo = ?, discount_reason = ?,
        additional_charges_kobo = ?, additional_charges_reason = ?, total_kobo = ?,
        notes = ?, updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`,
      [
        supplier.id,
        supplier.name,
        supplier.phone,
        input.expectedDeliveryDate ?? null,
        subtotalKobo,
        lineDiscountTotalKobo,
        input.orderDiscountKobo,
        discountTotalKobo,
        input.discountReason ?? null,
        input.additionalChargesKobo,
        input.additionalChargesReason ?? null,
        totalKobo,
        input.notes ?? null,
        auth.user.id,
        auth.deviceId,
        now,
        id,
        input.version,
      ],
    );
    if (updated.changes !== 1)
      throw new ApiError(
        409,
        'PURCHASE_CONFLICT',
        'This purchase changed while you were editing it. Reload and try again.',
      );
    await tx.run('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [id]);
    for (const line of lines) {
      await tx.run(
        `INSERT INTO purchase_order_items (
          id, purchase_order_id, product_id, product_name_snapshot, product_sku_snapshot,
          product_type_snapshot, unit_id, unit_name_snapshot, unit_symbol_snapshot,
          conversion_factor, quantity, base_quantity, unit_cost_kobo, line_subtotal_kobo,
          line_discount_kobo, line_total_kobo, received_base_quantity
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        [
          crypto.randomUUID(),
          id,
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
          line.unitCostKobo,
          line.lineSubtotalKobo,
          line.lineDiscountKobo,
          line.lineTotalKobo,
        ],
      );
    }
    await audit(tx, {
      action: 'purchase.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'purchase_order',
      entityId: id,
      metadata: {
        referenceNumber: existing.reference_number,
        totalKobo,
        itemCount: lines.length,
        previousTotalKobo: Number(existing.total_kobo),
      },
    });
    return getPurchaseDetail(tx, id);
  });
}

export async function markPurchaseOrdered(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
): Promise<PurchaseOrderDetail> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'purchases.edit');
    const existing = await loadPurchaseOrderRow(tx, id);
    if (existing.status !== 'draft')
      throw new ApiError(
        409,
        'PURCHASE_NOT_DRAFT',
        'Only a draft purchase order can be marked as ordered.',
      );
    const now = new Date().toISOString();
    const updated = await tx.run(
      `UPDATE purchase_orders SET status = 'ordered', ordered_at = ?, ordered_by = ?,
        updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'draft'`,
      [now, auth.user.id, auth.user.id, auth.deviceId, now, id, existing.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(409, 'PURCHASE_CONFLICT', 'This purchase changed. Reload and try again.');
    await audit(tx, {
      action: 'purchase.ordered',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'purchase_order',
      entityId: id,
      metadata: {
        referenceNumber: existing.reference_number,
        totalKobo: Number(existing.total_kobo),
      },
    });
    return getPurchaseDetail(tx, id);
  });
}

export async function cancelPurchase(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  reason: string,
): Promise<PurchaseOrderDetail> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'purchases.cancel');
    const existing = await loadPurchaseOrderRow(tx, id);
    if (existing.status === 'cancelled')
      throw new ApiError(409, 'PURCHASE_ALREADY_CANCELLED', 'This purchase is already cancelled.');
    if (existing.status === 'partially_received' || existing.status === 'received')
      throw new ApiError(
        409,
        'PURCHASE_HAS_RECEIPTS',
        'Goods have already been received against this order, so it cannot be cancelled.',
      );
    const receipts = (
      await tx.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM goods_receipts WHERE purchase_order_id = ?',
        [id],
      )
    )[0]!.count;
    if (Number(receipts) > 0)
      throw new ApiError(
        409,
        'PURCHASE_HAS_RECEIPTS',
        'Goods have already been received against this order, so it cannot be cancelled.',
      );
    const now = new Date().toISOString();
    const updated = await tx.run(
      `UPDATE purchase_orders SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
        cancel_reason = ?, updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('draft','ordered')`,
      [now, auth.user.id, reason, auth.user.id, auth.deviceId, now, id, existing.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(409, 'PURCHASE_CONFLICT', 'This purchase changed. Reload and try again.');
    await audit(tx, {
      action: 'purchase.cancelled',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'purchase_order',
      entityId: id,
      metadata: { referenceNumber: existing.reference_number, reason },
    });
    return getPurchaseDetail(tx, id);
  });
}

function itemStatus(receivedBase: number, baseQuantity: number): PurchaseLineStatus {
  if (receivedBase >= baseQuantity) return 'received';
  return receivedBase > 0 ? 'partial' : 'pending';
}

async function loadPurchaseItems(
  db: SqlExecutor,
  purchaseOrderId: string,
): Promise<PurchaseOrderItemSummary[]> {
  const rows = await db.all<PurchaseItemRow>(purchaseItemSelect, [purchaseOrderId]);
  const receivedValues =
    rows.length === 0
      ? []
      : await db.all<{ purchase_order_item_id: string; received_value: number }>(
          `SELECT purchase_order_item_id, COALESCE(SUM(total_cost_kobo), 0) AS received_value
          FROM goods_receipt_items WHERE goods_receipt_id IN
            (SELECT id FROM goods_receipts WHERE purchase_order_id = ?)
          GROUP BY purchase_order_item_id`,
          [purchaseOrderId],
        );
  const valueByItem = new Map(
    receivedValues.map((row) => [row.purchase_order_item_id, Number(row.received_value)]),
  );
  return rows.map((row) => {
    const factor = Number(row.conversion_factor);
    const quantity = Number(row.quantity);
    const baseQuantity = Number(row.base_quantity);
    const receivedBase = Number(row.received_base_quantity);
    const receivedQuantity = Math.floor(receivedBase / factor);
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
      quantity,
      baseQuantity,
      unitCostKobo: Number(row.unit_cost_kobo),
      lineSubtotalKobo: Number(row.line_subtotal_kobo),
      lineDiscountKobo: Number(row.line_discount_kobo),
      lineTotalKobo: Number(row.line_total_kobo),
      receivedBaseQuantity: receivedBase,
      receivedQuantity,
      pendingQuantity: quantity - receivedQuantity,
      receivedValueKobo: valueByItem.get(row.id) ?? 0,
      status: itemStatus(receivedBase, baseQuantity),
    };
  });
}

function mapPurchasePayments(
  payments: Awaited<ReturnType<typeof listPaymentsForOrder>>,
  purchaseOrderId: string,
): PurchasePaymentSummary[] {
  return payments.map((payment) => {
    const allocated = payment.allocations
      .filter((allocation) => allocation.purchaseOrderId === purchaseOrderId)
      .reduce(
        (sum, allocation) =>
          sum + (allocation.direction === 'apply' ? allocation.amountKobo : -allocation.amountKobo),
        0,
      );
    return {
      id: payment.id,
      paymentNumber: payment.paymentNumber,
      paymentKind: payment.paymentKind,
      method: payment.method,
      amountKobo: payment.amountKobo,
      allocatedToOrderKobo: allocated,
      paidAt: payment.paidAt,
      reference: payment.reference,
      recordedBy: payment.recordedBy,
      recordedByName: payment.recordedByName,
      createdAt: payment.createdAt,
    };
  });
}

export async function getPurchaseDetail(db: SqlExecutor, id: string): Promise<PurchaseOrderDetail> {
  const row = await loadPurchaseOrderRow(db, id);
  const [items, receipts, payments] = await Promise.all([
    loadPurchaseItems(db, id),
    listReceiptsForOrder(db, id),
    listPaymentsForOrder(db, id),
  ]);
  return {
    ...mapPurchaseOrderSummary(row),
    items,
    receipts,
    payments: mapPurchasePayments(payments, id),
  };
}

export async function listPurchases(
  db: SqlExecutor,
  query: {
    search?: string;
    supplierId?: string;
    status?: PurchaseOrderSummary['status'];
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<PurchaseOrderSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.search) {
    const pattern = likePattern(query.search);
    where.push(
      "(po.reference_number LIKE ? ESCAPE '\\' OR po.supplier_name_snapshot LIKE ? ESCAPE '\\' OR po.notes LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern, pattern);
  }
  if (query.supplierId) {
    where.push('po.supplier_id = ?');
    values.push(query.supplierId);
  }
  if (query.status) {
    where.push('po.status = ?');
    values.push(query.status);
  }
  if (query.from) {
    where.push('po.created_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    where.push('po.created_at <= ?');
    values.push(`${query.to}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM purchase_orders po ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<PurchaseOrderRow>(
    `${purchaseOrderSelect} ${clause} ORDER BY po.created_at DESC, po.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapPurchaseOrderSummary), query.page, query.pageSize, Number(total));
}
