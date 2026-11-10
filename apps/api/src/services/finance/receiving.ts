import type { Database, SqlExecutor } from '@medimart/database';
import type {
  GoodsReceiptCreateInput,
  GoodsReceiptDetail,
  GoodsReceiptItemSummary,
  GoodsReceiptSummary,
  Paginated,
  PurchaseOrderDetail,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, loadProduct, paginate, todayIso } from '../inventory/common';
import { recordMovement } from '../inventory/stock';
import { nextSequenceCode, operationHash } from '../sales/common';
import { proportionalKobo } from './common';
import { getPurchaseDetail } from './purchases';
import {
  goodsReceiptSelect,
  loadPurchaseOrderRow,
  mapGoodsReceiptSummary,
  type GoodsReceiptRow,
  type PurchaseItemRow,
} from './records';

type ReceiptItemRow = {
  id: string;
  goods_receipt_id: string;
  purchase_order_item_id: string;
  product_id: string;
  unit_id: string;
  unit_name_snapshot: string;
  unit_symbol_snapshot: string;
  conversion_factor: number;
  quantity_received: number;
  base_quantity_received: number;
  quantity_rejected: number;
  base_quantity_rejected: number;
  rejection_reason: string | null;
  unit_cost_kobo: number;
  total_cost_kobo: number;
  base_unit_cost_kobo: number;
  batch_id: string | null;
  batch_number_snapshot: string | null;
  manufacturing_date: string | null;
  expiry_date: string | null;
  stock_movement_id: string | null;
  product_name: string;
};

function mapReceiptItem(row: ReceiptItemRow): GoodsReceiptItemSummary {
  return {
    id: row.id,
    purchaseOrderItemId: row.purchase_order_item_id,
    productId: row.product_id,
    productName: row.product_name,
    unitName: row.unit_name_snapshot,
    unitSymbol: row.unit_symbol_snapshot,
    conversionFactor: Number(row.conversion_factor),
    quantityReceived: Number(row.quantity_received),
    baseQuantityReceived: Number(row.base_quantity_received),
    quantityRejected: Number(row.quantity_rejected),
    baseQuantityRejected: Number(row.base_quantity_rejected),
    rejectionReason: row.rejection_reason,
    unitCostKobo: Number(row.unit_cost_kobo),
    totalCostKobo: Number(row.total_cost_kobo),
    batchId: row.batch_id,
    batchNumber: row.batch_number_snapshot,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    stockMovementId: row.stock_movement_id,
  };
}

export async function getGoodsReceiptDetail(
  db: SqlExecutor,
  id: string,
): Promise<GoodsReceiptDetail> {
  const row = (await db.all<GoodsReceiptRow>(`${goodsReceiptSelect} WHERE gr.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'This goods receipt does not exist.');
  const items = await db.all<ReceiptItemRow>(
    `SELECT gri.*, p.name AS product_name
    FROM goods_receipt_items gri JOIN products p ON p.id = gri.product_id
    WHERE gri.goods_receipt_id = ? ORDER BY gri.created_at ASC, gri.rowid ASC`,
    [id],
  );
  return { ...mapGoodsReceiptSummary(row), items: items.map(mapReceiptItem) };
}

async function findReceiptByOperation(tx: SqlExecutor, operationId: string) {
  return (
    await tx.all<{ id: string; operation_fingerprint: string | null }>(
      'SELECT id, operation_fingerprint FROM goods_receipts WHERE operation_id = ?',
      [operationId],
    )
  )[0];
}

async function receiptResult(db: SqlExecutor, receiptId: string) {
  const receipt = await getGoodsReceiptDetail(db, receiptId);
  const purchase = await getPurchaseDetail(db, receipt.purchaseOrderId);
  return { receipt, purchase };
}

async function loadPurchaseItems(tx: SqlExecutor, purchaseOrderId: string) {
  const rows = await tx.all<PurchaseItemRow>(
    'SELECT * FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY created_at ASC, rowid ASC',
    [purchaseOrderId],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function updatePurchaseStatus(
  tx: SqlExecutor,
  purchaseOrderId: string,
  userId: string,
  deviceId: string | null,
) {
  const items = await tx.all<{ base_quantity: number; received_base_quantity: number }>(
    'SELECT base_quantity, received_base_quantity FROM purchase_order_items WHERE purchase_order_id = ?',
    [purchaseOrderId],
  );
  if (items.length === 0) return;
  const allReceived = items.every(
    (item) => Number(item.received_base_quantity) >= Number(item.base_quantity),
  );
  const anyReceived = items.some((item) => Number(item.received_base_quantity) > 0);
  const status = allReceived ? 'received' : anyReceived ? 'partially_received' : 'ordered';
  const now = new Date().toISOString();
  await tx.run(
    `UPDATE purchase_orders SET status = ?, updated_by = ?, device_id = ?,
      version = version + 1, updated_at = ? WHERE id = ? AND status IN ('ordered','partially_received')`,
    [status, userId, deviceId, now, purchaseOrderId],
  );
}

export async function createGoodsReceipt(
  db: Database,
  auth: AuthContext,
  requestId: string,
  purchaseOrderId: string,
  input: GoodsReceiptCreateInput,
): Promise<{ receipt: GoodsReceiptDetail; purchase: PurchaseOrderDetail }> {
  const fingerprint = await operationHash('goods-receipt-create-v1', {
    purchaseOrderId,
    receivedDate: input.receivedDate,
    notes: input.notes ?? null,
    items: input.items,
  });
  const preExisting = await findReceiptByOperation(db, input.operationId);
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different goods receipt.',
      );
    return receiptResult(db, preExisting.id);
  }

  return db.transaction(async (tx) => {
    // Receiving changes stock and creates a payable, so both grants are required.
    await assertPermission(tx, auth, 'purchases.receive');
    await assertPermission(tx, auth, 'stock.receive');
    const existing = await findReceiptByOperation(tx, input.operationId);
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different goods receipt.',
        );
      return receiptResult(tx, existing.id);
    }

    const purchase = await loadPurchaseOrderRow(tx, purchaseOrderId);
    if (purchase.status !== 'ordered' && purchase.status !== 'partially_received')
      throw new ApiError(
        409,
        'PURCHASE_NOT_RECEIVABLE',
        purchase.status === 'draft'
          ? 'Mark this purchase as ordered before receiving goods.'
          : 'This purchase is closed and cannot receive more goods.',
      );
    const purchaseItems = await loadPurchaseItems(tx, purchaseOrderId);
    const today = todayIso();
    const now = new Date().toISOString();
    const receiptId = crypto.randomUUID();
    const receiptNumber = await nextSequenceCode(tx, 'GRN');

    type PreparedReceiptLine = {
      purchaseItem: PurchaseItemRow;
      productName: string;
      quantityReceived: number;
      baseQuantityReceived: number;
      quantityRejected: number;
      baseQuantityRejected: number;
      rejectionReason: string | null;
      unitCostKobo: number;
      totalCostKobo: number;
      baseUnitCostKobo: number;
      batchId: string | null;
      batchNumber: string | null;
      manufacturingDate: string | null;
      expiryDate: string | null;
      stockMovementId: string | null;
    };

    const prepared: PreparedReceiptLine[] = [];
    let receivedValueKobo = 0;
    let totalRejectedBaseQuantity = 0;

    for (const line of input.items) {
      const purchaseItem = purchaseItems.get(line.purchaseOrderItemId);
      if (!purchaseItem)
        throw new ApiError(
          400,
          'PURCHASE_ITEM_NOT_FOUND',
          'A received line does not belong to this purchase order.',
        );
      const factor = Number(purchaseItem.conversion_factor);
      const acceptedBase = line.quantityReceived * factor;
      const rejectedBase = line.quantityRejected * factor;
      if (!Number.isSafeInteger(acceptedBase) || !Number.isSafeInteger(rejectedBase))
        throw new ApiError(400, 'QUANTITY_INVALID', 'The converted quantity is not valid.');
      const remainingBase =
        Number(purchaseItem.base_quantity) - Number(purchaseItem.received_base_quantity);
      if (acceptedBase > remainingBase)
        throw new ApiError(
          409,
          'RECEIVE_EXCEEDS_ORDER',
          `Only ${Math.floor(remainingBase / factor)} ${purchaseItem.unit_symbol_snapshot} of ${purchaseItem.product_name_snapshot} remain outstanding on this order.`,
        );

      const product = await loadProduct(tx, purchaseItem.product_id);
      const unitCostKobo = line.unitCostKobo ?? Number(purchaseItem.unit_cost_kobo);
      const totalCostKobo = unitCostKobo * line.quantityReceived;
      if (!Number.isSafeInteger(totalCostKobo))
        throw new ApiError(400, 'AMOUNT_INVALID', 'The received line value is too large.');
      const baseUnitCostKobo =
        acceptedBase > 0 ? proportionalKobo(totalCostKobo, 1, acceptedBase) : 0;

      let batchId: string | null = null;
      const batchNumber = line.batchNumber ?? null;
      const expiryDate = line.expiryDate ?? null;

      if (acceptedBase > 0) {
        if (product.is_expiry_tracked === 1 && !expiryDate)
          throw new ApiError(
            400,
            'EXPIRY_REQUIRED',
            `Enter the expiry date for ${product.name} before receiving it.`,
          );
        if (expiryDate && expiryDate < today)
          throw new ApiError(
            409,
            'EXPIRED_GOODS_BLOCKED',
            `${product.name} would already be expired on ${expiryDate}. Record the quantity as rejected instead so expired stock never enters sellable inventory.`,
          );
        if (
          (product.is_expiry_tracked === 1 || product.product_type === 'medicine') &&
          !batchNumber
        )
          throw new ApiError(
            400,
            'BATCH_REQUIRED',
            `Enter the batch number for ${product.name} before receiving it.`,
          );
      }

      if (batchNumber) {
        const existingBatch = (
          await tx.all<{
            id: string;
            purchase_cost_kobo: number;
            expiry_date: string | null;
            manufacturing_date: string | null;
          }>(
            'SELECT id,purchase_cost_kobo,expiry_date,manufacturing_date FROM product_batches WHERE product_id = ? AND batch_number = ? COLLATE NOCASE',
            [product.id, batchNumber],
          )
        )[0];
        if (existingBatch) {
          if (Number(existingBatch.purchase_cost_kobo) !== baseUnitCostKobo)
            throw new ApiError(
              409,
              'BATCH_COST_MISMATCH',
              `Batch ${batchNumber} already exists at a different unit cost. Use the original batch for this delivery or record a distinct batch number.`,
            );
          if (
            (existingBatch.expiry_date ?? null) !== (expiryDate ?? null) ||
            (existingBatch.manufacturing_date ?? null) !== (line.manufacturingDate ?? null)
          )
            throw new ApiError(
              409,
              'BATCH_DETAILS_MISMATCH',
              `Batch ${batchNumber} already exists with different dates. Check the batch label.`,
            );
          batchId = existingBatch.id;
        } else {
          batchId = crypto.randomUUID();
          await tx.run(
            `INSERT INTO product_batches (
              id, product_id, batch_number, manufacturing_date, expiry_date,
              quantity_received, quantity_remaining, purchase_cost_kobo, supplier_id,
              created_by, updated_by, device_id
            ) VALUES (?,?,?,?,?,0,0,?,?,?,?,?)`,
            [
              batchId,
              product.id,
              batchNumber,
              line.manufacturingDate ?? null,
              expiryDate,
              baseUnitCostKobo,
              purchase.supplier_id,
              auth.user.id,
              auth.user.id,
              auth.deviceId,
            ],
          );
        }
      }

      let stockMovementId: string | null = null;
      if (acceptedBase > 0) {
        const movement = await recordMovement(
          tx,
          { auth, requestId },
          {
            productId: product.id,
            batchId,
            movementType: 'stock_received',
            delta: acceptedBase,
            unitCostKobo: baseUnitCostKobo,
            reason: `Goods received against ${purchase.reference_number}`,
            referenceId: receiptNumber,
            supplierId: purchase.supplier_id,
            operationId: null,
            operationFingerprint: '',
            baseQuantity: acceptedBase,
          },
        );
        stockMovementId = movement.movement.id;
      }

      if (acceptedBase > 0) {
        const updated = await tx.run(
          `UPDATE purchase_order_items
          SET received_base_quantity = received_base_quantity + ?
          WHERE id = ? AND received_base_quantity + ? <= base_quantity`,
          [acceptedBase, purchaseItem.id, acceptedBase],
        );
        if (updated.changes !== 1)
          throw new ApiError(
            409,
            'RECEIVE_EXCEEDS_ORDER',
            'This purchase line was received by another request. Reload and try again.',
          );
      }

      prepared.push({
        purchaseItem,
        productName: product.name,
        quantityReceived: line.quantityReceived,
        baseQuantityReceived: acceptedBase,
        quantityRejected: line.quantityRejected,
        baseQuantityRejected: rejectedBase,
        rejectionReason: line.rejectionReason ?? null,
        unitCostKobo,
        totalCostKobo,
        baseUnitCostKobo,
        batchId,
        batchNumber,
        manufacturingDate: line.manufacturingDate ?? null,
        expiryDate,
        stockMovementId,
      });
      receivedValueKobo += totalCostKobo;
      totalRejectedBaseQuantity += rejectedBase;
    }

    await tx.run(
      `INSERT INTO goods_receipts (
        id, operation_id, operation_fingerprint, receipt_number, purchase_order_id,
        supplier_id, received_date, notes, received_value_kobo,
        total_rejected_base_quantity, received_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        receiptId,
        input.operationId,
        fingerprint,
        receiptNumber,
        purchaseOrderId,
        purchase.supplier_id,
        input.receivedDate,
        input.notes ?? null,
        receivedValueKobo,
        totalRejectedBaseQuantity,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );
    for (const line of prepared) {
      await tx.run(
        `INSERT INTO goods_receipt_items (
          id, goods_receipt_id, purchase_order_item_id, product_id, unit_id,
          unit_name_snapshot, unit_symbol_snapshot, conversion_factor,
          quantity_received, base_quantity_received, quantity_rejected,
          base_quantity_rejected, rejection_reason, unit_cost_kobo, total_cost_kobo,
          base_unit_cost_kobo, batch_id, batch_number_snapshot, manufacturing_date,
          expiry_date, stock_movement_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          receiptId,
          line.purchaseItem.id,
          line.purchaseItem.product_id,
          line.purchaseItem.unit_id,
          line.purchaseItem.unit_name_snapshot,
          line.purchaseItem.unit_symbol_snapshot,
          line.purchaseItem.conversion_factor,
          line.quantityReceived,
          line.baseQuantityReceived,
          line.quantityRejected,
          line.baseQuantityRejected,
          line.rejectionReason,
          line.unitCostKobo,
          line.totalCostKobo,
          line.baseUnitCostKobo,
          line.batchId,
          line.batchNumber,
          line.manufacturingDate,
          line.expiryDate,
          line.stockMovementId,
        ],
      );
    }
    await updatePurchaseStatus(tx, purchaseOrderId, auth.user.id, auth.deviceId);
    await audit(tx, {
      action: 'goods_receipt.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'goods_receipt',
      entityId: receiptId,
      metadata: {
        receiptNumber,
        purchaseReference: purchase.reference_number,
        supplierId: purchase.supplier_id,
        receivedValueKobo,
        acceptedBaseQuantity: prepared.reduce((sum, line) => sum + line.baseQuantityReceived, 0),
        rejectedBaseQuantity: totalRejectedBaseQuantity,
        itemCount: prepared.length,
      },
    });
    return receiptResult(tx, receiptId);
  });
}

export async function listGoodsReceipts(
  db: SqlExecutor,
  query: {
    purchaseOrderId?: string;
    supplierId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<GoodsReceiptSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.purchaseOrderId) {
    where.push('gr.purchase_order_id = ?');
    values.push(query.purchaseOrderId);
  }
  if (query.supplierId) {
    where.push('gr.supplier_id = ?');
    values.push(query.supplierId);
  }
  if (query.from) {
    where.push('gr.received_date >= ?');
    values.push(query.from);
  }
  if (query.to) {
    where.push('gr.received_date <= ?');
    values.push(query.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM goods_receipts gr ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<GoodsReceiptRow>(
    `${goodsReceiptSelect} ${clause} ORDER BY gr.received_date DESC, gr.created_at DESC, gr.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapGoodsReceiptSummary), query.page, query.pageSize, Number(total));
}
