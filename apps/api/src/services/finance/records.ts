import type { SqlExecutor } from '@medimart/database';
import type {
  GoodsReceiptSummary,
  PaymentMethod,
  ProductType,
  PurchaseOrderSummary,
  PurchaseStatus,
  SupplierPaymentAllocationSummary,
  SupplierPaymentKind,
  SupplierPaymentSummary,
} from '@medimart/shared';
import { ApiError } from '../../errors';

/**
 * Shared row shapes, SQL projections and mappers for the purchasing, receiving and
 * supplier-payment services. Keeping them here avoids circular imports between the
 * write services and the reporting layer.
 */

export type PurchaseOrderRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  reference_number: string;
  supplier_id: string;
  supplier_name_snapshot: string;
  supplier_phone_snapshot: string | null;
  status: PurchaseStatus;
  expected_delivery_date: string | null;
  subtotal_kobo: number;
  line_discount_total_kobo: number;
  order_discount_kobo: number;
  discount_total_kobo: number;
  discount_reason: string | null;
  additional_charges_kobo: number;
  additional_charges_reason: string | null;
  total_kobo: number;
  notes: string | null;
  ordered_at: string | null;
  ordered_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string;
  updated_by: string | null;
  device_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  item_count: number;
  received_value_kobo: number;
  paid_kobo: number;
  created_by_name: string | null;
  ordered_by_name: string | null;
  cancelled_by_name: string | null;
};

export const purchaseOrderSelect = `
  SELECT po.*,
    (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS item_count,
    COALESCE((
      SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri
      JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
      WHERE gr.purchase_order_id = po.id
    ), 0) AS received_value_kobo,
    COALESCE((
      SELECT SUM(CASE WHEN a.direction = 'apply' THEN a.amount_kobo ELSE -a.amount_kobo END)
      FROM supplier_payment_allocations a WHERE a.purchase_order_id = po.id
    ), 0) AS paid_kobo,
    cu.full_name AS created_by_name,
    ou.full_name AS ordered_by_name,
    xu.full_name AS cancelled_by_name
  FROM purchase_orders po
  LEFT JOIN users cu ON cu.id = po.created_by
  LEFT JOIN users ou ON ou.id = po.ordered_by
  LEFT JOIN users xu ON xu.id = po.cancelled_by`;

export function mapPurchaseOrderSummary(row: PurchaseOrderRow): PurchaseOrderSummary {
  const receivedValue = Number(row.received_value_kobo);
  const paid = Number(row.paid_kobo);
  return {
    id: row.id,
    referenceNumber: row.reference_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name_snapshot,
    supplierPhone: row.supplier_phone_snapshot,
    status: row.status,
    expectedDeliveryDate: row.expected_delivery_date,
    subtotalKobo: Number(row.subtotal_kobo),
    lineDiscountTotalKobo: Number(row.line_discount_total_kobo),
    orderDiscountKobo: Number(row.order_discount_kobo),
    discountTotalKobo: Number(row.discount_total_kobo),
    discountReason: row.discount_reason,
    additionalChargesKobo: Number(row.additional_charges_kobo),
    additionalChargesReason: row.additional_charges_reason,
    totalKobo: Number(row.total_kobo),
    notes: row.notes,
    itemCount: Number(row.item_count),
    receivedValueKobo: receivedValue,
    paidKobo: paid,
    outstandingKobo: Math.max(0, receivedValue - paid),
    orderedAt: row.ordered_at,
    orderedByName: row.ordered_by_name,
    cancelledAt: row.cancelled_at,
    cancelledByName: row.cancelled_by_name,
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  };
}

export async function loadPurchaseOrderRow(db: SqlExecutor, id: string) {
  const row = (await db.all<PurchaseOrderRow>(`${purchaseOrderSelect} WHERE po.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'PURCHASE_NOT_FOUND', 'This purchase order does not exist.');
  return row;
}

export type GoodsReceiptRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  receipt_number: string;
  purchase_order_id: string;
  supplier_id: string;
  received_date: string;
  notes: string | null;
  received_value_kobo: number;
  total_rejected_base_quantity: number;
  received_by: string;
  device_id: string | null;
  created_at: string;
  purchase_reference: string;
  supplier_name: string;
  item_count: number;
  received_by_name: string | null;
};

export const goodsReceiptSelect = `
  SELECT gr.*, po.reference_number AS purchase_reference,
    po.supplier_name_snapshot AS supplier_name,
    (SELECT COUNT(*) FROM goods_receipt_items i WHERE i.goods_receipt_id = gr.id) AS item_count,
    u.full_name AS received_by_name
  FROM goods_receipts gr
  JOIN purchase_orders po ON po.id = gr.purchase_order_id
  LEFT JOIN users u ON u.id = gr.received_by`;

export function mapGoodsReceiptSummary(row: GoodsReceiptRow): GoodsReceiptSummary {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    purchaseOrderId: row.purchase_order_id,
    purchaseReference: row.purchase_reference,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    receivedDate: row.received_date,
    notes: row.notes,
    receivedValueKobo: Number(row.received_value_kobo),
    totalRejectedBaseQuantity: Number(row.total_rejected_base_quantity),
    itemCount: Number(row.item_count),
    receivedBy: row.received_by,
    receivedByName: row.received_by_name,
    createdAt: row.created_at,
  };
}

export type PurchaseItemRow = {
  id: string;
  purchase_order_id: string;
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
  unit_cost_kobo: number;
  line_subtotal_kobo: number;
  line_discount_kobo: number;
  line_total_kobo: number;
  received_base_quantity: number;
};

export const purchaseItemSelect =
  'SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY created_at ASC, rowid ASC';

export type SupplierPaymentRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  payment_number: string;
  supplier_id: string;
  payment_kind: SupplierPaymentKind;
  method: PaymentMethod;
  amount_kobo: number;
  paid_at: string;
  reference: string | null;
  notes: string | null;
  reversal_of_payment_id: string | null;
  reversal_reason: string | null;
  recorded_by: string;
  device_id: string | null;
  created_at: string;
  supplier_name: string;
  recorded_by_name: string | null;
  reversed_by_payment_id: string | null;
};

export const supplierPaymentSelect = `
  SELECT sp.*, s.name AS supplier_name, u.full_name AS recorded_by_name,
    (SELECT sp2.id FROM supplier_payments sp2 WHERE sp2.reversal_of_payment_id = sp.id LIMIT 1) AS reversed_by_payment_id
  FROM supplier_payments sp
  JOIN suppliers s ON s.id = sp.supplier_id
  LEFT JOIN users u ON u.id = sp.recorded_by`;

export async function hydratePaymentAllocations(
  db: SqlExecutor,
  rows: SupplierPaymentRow[],
): Promise<Map<string, SupplierPaymentAllocationSummary[]>> {
  const byPayment = new Map<string, SupplierPaymentAllocationSummary[]>();
  if (rows.length === 0) return byPayment;
  for (const row of rows) byPayment.set(row.id, []);
  const placeholders = rows.map(() => '?').join(',');
  const allocations = await db.all<{
    id: string;
    payment_id: string;
    purchase_order_id: string;
    reference_number: string;
    direction: 'apply' | 'reverse';
    amount_kobo: number;
    created_at: string;
  }>(
    `SELECT a.*, po.reference_number
    FROM supplier_payment_allocations a
    JOIN purchase_orders po ON po.id = a.purchase_order_id
    WHERE a.payment_id IN (${placeholders})
    ORDER BY a.created_at ASC, a.id ASC`,
    rows.map((row) => row.id),
  );
  for (const allocation of allocations) {
    const list = byPayment.get(allocation.payment_id);
    if (!list) continue;
    list.push({
      id: allocation.id,
      purchaseOrderId: allocation.purchase_order_id,
      purchaseReference: allocation.reference_number,
      direction: allocation.direction,
      amountKobo: Number(allocation.amount_kobo),
      createdAt: allocation.created_at,
    });
  }
  return byPayment;
}

export function mapSupplierPayment(
  row: SupplierPaymentRow,
  allocations: SupplierPaymentAllocationSummary[],
): SupplierPaymentSummary {
  return {
    id: row.id,
    paymentNumber: row.payment_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    paymentKind: row.payment_kind,
    method: row.method,
    amountKobo: Number(row.amount_kobo),
    paidAt: row.paid_at,
    reference: row.reference,
    notes: row.notes,
    reversalOfPaymentId: row.reversal_of_payment_id,
    reversedByPaymentId: row.reversed_by_payment_id,
    reversalReason: row.reversal_reason,
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    createdAt: row.created_at,
    allocations,
  };
}

export async function loadSupplierPaymentRows(
  db: SqlExecutor,
  where: string,
  values: Array<string | number>,
) {
  return db.all<SupplierPaymentRow>(`${supplierPaymentSelect} ${where}`, values);
}

export async function listReceiptsForOrder(db: SqlExecutor, purchaseOrderId: string) {
  const rows = await db.all<GoodsReceiptRow>(
    `${goodsReceiptSelect} WHERE gr.purchase_order_id = ? ORDER BY gr.received_date ASC, gr.created_at ASC, gr.id ASC`,
    [purchaseOrderId],
  );
  return rows.map(mapGoodsReceiptSummary);
}

export async function listPaymentsForOrder(db: SqlExecutor, purchaseOrderId: string) {
  const rows = await db.all<SupplierPaymentRow>(
    `${supplierPaymentSelect}
    WHERE sp.id IN (SELECT a.payment_id FROM supplier_payment_allocations a WHERE a.purchase_order_id = ?)
    ORDER BY sp.paid_at ASC, sp.created_at ASC, sp.id ASC`,
    [purchaseOrderId],
  );
  const allocations = await hydratePaymentAllocations(db, rows);
  return rows.map((row) => mapSupplierPayment(row, allocations.get(row.id) ?? []));
}
