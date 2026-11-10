import type { Database, SqlExecutor } from '@medimart/database';
import { readSetting, writeSetting } from '@medimart/database';
import type {
  BatchSummary,
  FefoAllocation,
  MovementSummary,
  Paginated,
  ReconciliationReport,
  StockAdjustmentInput,
  StockMovementType,
  StockReceiveInput,
} from '@medimart/shared';
import { decreaseMovementTypes, sha256 } from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import {
  assertPermission,
  likePattern,
  loadProduct,
  mapMovement,
  mapProduct,
  movementSelect,
  paginate,
  toBaseQuantity,
  todayIso,
  type MovementRow,
} from './common';

export const EXPIRY_ALERT_KEY = 'inventory.expiry_alert_days';
export const DEFAULT_EXPIRY_ALERT_DAYS = 90;

export async function expiryAlertDays(tx: SqlExecutor) {
  const value = await readSetting<number>(tx, EXPIRY_ALERT_KEY);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_EXPIRY_ALERT_DAYS;
}

export async function saveInventorySettings(
  db: Database,
  auth: AuthContext,
  requestId: string,
  days: number,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'inventory.settings.manage');
    await writeSetting(tx, EXPIRY_ALERT_KEY, days, { actorId: auth.user.id });
    await audit(tx, {
      action: 'inventory.settings_updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      metadata: { expiryAlertDays: days },
    });
    return { expiryAlertDays: days };
  });
}

type BatchRow = {
  id: string;
  product_id: string;
  product_name: string;
  batch_number: string;
  manufacturing_date: string | null;
  expiry_date: string | null;
  quantity_received: number;
  quantity_remaining: number;
  purchase_cost_kobo: number;
  supplier_id: string | null;
  supplier_name: string | null;
  recorded_at: string;
  created_by: string | null;
};

export function batchState(
  row: { expiry_date: string | null; quantity_remaining: number },
  days: number,
): BatchSummary['status'] {
  if (Number(row.quantity_remaining) <= 0) return 'depleted';
  if (!row.expiry_date) return 'active';
  const today = todayIso();
  if (row.expiry_date < today) return 'expired';
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + days);
  return row.expiry_date <= cutoff.toISOString().slice(0, 10) ? 'expiring' : 'active';
}

function mapBatch(row: BatchRow, days: number): BatchSummary {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    batchNumber: row.batch_number,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    quantityReceived: Number(row.quantity_received),
    quantityRemaining: Number(row.quantity_remaining),
    purchaseCostKobo: Number(row.purchase_cost_kobo),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    status: batchState(row, days),
    recordedAt: row.recorded_at,
    createdBy: row.created_by,
  };
}

const batchSelect = `
  SELECT b.*, p.name AS product_name, s.name AS supplier_name
  FROM product_batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN suppliers s ON s.id = b.supplier_id`;

export async function listBatchesForProduct(db: SqlExecutor, productId: string, days: number) {
  const rows = await db.all<BatchRow>(
    `${batchSelect} WHERE b.product_id = ? ORDER BY (b.expiry_date IS NULL), b.expiry_date ASC, b.recorded_at ASC`,
    [productId],
  );
  return rows.map((row) => mapBatch(row, days));
}

export async function listBatches(
  db: SqlExecutor,
  query: {
    search?: string;
    productId?: string;
    filter: 'all' | 'expiring' | 'expired' | 'depleted';
    page: number;
    pageSize: number;
  },
): Promise<Paginated<BatchSummary>> {
  const days = await expiryAlertDays(db);
  const today = todayIso();
  const healthyLimit = new Date(`${today}T00:00:00.000Z`);
  healthyLimit.setUTCDate(healthyLimit.getUTCDate() + days);
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.productId) {
    where.push('b.product_id = ?');
    values.push(query.productId);
  }
  if (query.search) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR b.batch_number LIKE ? ESCAPE '\\')");
    const pattern = likePattern(query.search);
    values.push(pattern, pattern);
  }
  if (query.filter === 'depleted') where.push('b.quantity_remaining = 0');
  if (query.filter === 'expired')
    where.push('b.quantity_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date < ?');
  if (query.filter === 'expiring')
    where.push(
      'b.quantity_remaining > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date >= ? AND b.expiry_date <= ?',
    );
  if (query.filter === 'expired') values.push(today);
  if (query.filter === 'expiring') values.push(today, healthyLimit.toISOString().slice(0, 10));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM product_batches b JOIN products p ON p.id = b.product_id ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<BatchRow>(
    `${batchSelect} ${clause} ORDER BY (b.expiry_date IS NULL), b.expiry_date ASC, p.name ASC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(
    rows.map((row) => mapBatch(row, days)),
    query.page,
    query.pageSize,
    Number(total),
  );
}

type MovementContext = { auth: AuthContext; requestId: string };

/** Movement types that represent a delivery of new stock, as opposed to a balance correction. */
const receivingMovementTypes: readonly StockMovementType[] = ['opening_stock', 'stock_received'];

type OperationFields = {
  productId: string;
  batchNumber: string | null;
  movementType: StockMovementType;
  quantity: number;
  unitCostKobo: number | null;
  supplierId: string | null;
  referenceId: string | null;
  reason: string;
  baseQuantity?: number;
};

/**
 * Canonical fingerprint of every business field an operation may not change when its ID is
 * retried. The field order is fixed and batch numbers are compared case-insensitively (the
 * database stores them with COLLATE NOCASE), so the same request always hashes identically.
 */
async function operationFingerprint(fields: OperationFields) {
  return sha256(
    JSON.stringify([
      'stock-operation-v1',
      fields.productId,
      fields.batchNumber ? fields.batchNumber.trim().toUpperCase() : null,
      fields.movementType,
      fields.quantity,
      fields.unitCostKobo,
      fields.supplierId,
      fields.referenceId,
      fields.reason.trim(),
      fields.baseQuantity ?? null,
    ]),
  );
}

/**
 * The fingerprint of an already stored movement, derived from the ledger row itself. This is the
 * fallback for movements recorded before the fingerprint column existed. The ledger stores the
 * signed quantity, while the submitted base quantity is always positive, so its absolute value
 * reconstructs exactly what the original request supplied.
 */
async function storedFingerprint(row: MovementRow) {
  const quantity = Number(row.quantity);
  return operationFingerprint({
    productId: row.product_id,
    batchNumber: row.batch_number,
    movementType: row.movement_type,
    quantity,
    unitCostKobo: row.unit_cost_kobo === null ? null : Number(row.unit_cost_kobo),
    supplierId: row.supplier_id,
    referenceId: row.reference_id,
    reason: row.reason,
    baseQuantity: Math.abs(quantity),
  });
}

async function findOperation(tx: SqlExecutor, operationId: string) {
  return (
    await tx.all<MovementRow>(`${movementSelect} WHERE m.operation_id = ?`, [operationId])
  )[0];
}

/**
 * A retry of an identical operation returns the original result; any difference in the submitted
 * business fields is a conflict rather than a new movement.
 */
async function replayOperation(existing: MovementRow | undefined, expected: OperationFields) {
  if (!existing) return null;
  const fingerprint = await operationFingerprint(expected);
  const original = existing.operation_fingerprint ?? (await storedFingerprint(existing));
  if (original !== fingerprint)
    throw new ApiError(
      409,
      'OPERATION_CONFLICT',
      'This operation ID was already used for a different stock movement.',
    );
  return mapMovement(existing);
}

/** Batch numbers identify a batch within a product, so they are the stable part of the fingerprint. */
async function batchNumberOf(tx: SqlExecutor, batchId: string | null) {
  if (!batchId) return null;
  const row = (
    await tx.all<{ batch_number: string }>(
      'SELECT batch_number FROM product_batches WHERE id = ?',
      [batchId],
    )
  )[0];
  return row?.batch_number ?? null;
}

/**
 * Apply one signed stock movement: compare-and-set the cached balance, update the batch
 * (when given), then append to the immutable ledger — all inside the caller's transaction.
 */
export async function recordMovement(
  tx: SqlExecutor,
  context: MovementContext,
  input: {
    productId: string;
    batchId: string | null;
    movementType: StockMovementType;
    delta: number;
    unitCostKobo: number | null;
    reason: string;
    referenceId: string | null;
    supplierId: string | null;
    operationId: string | null;
    operationFingerprint: string;
    baseQuantity: number;
    adjustmentReason?: boolean;
  },
) {
  const now = new Date().toISOString();
  const balance = (
    await tx.all<{ quantity: number; version: number }>(
      'SELECT quantity,version FROM stock_balances WHERE product_id = ?',
      [input.productId],
    )
  )[0];
  const previous = balance ? Number(balance.quantity) : 0;
  const next = previous + input.delta;
  if (next < 0)
    throw new ApiError(
      409,
      'INSUFFICIENT_STOCK',
      `This would leave negative stock. Only ${previous} base units are available.`,
    );
  if (balance) {
    const updated = await tx.run(
      'UPDATE stock_balances SET quantity=?,version=version+1,updated_at=? WHERE product_id=? AND version=?',
      [next, now, input.productId, balance.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(
        409,
        'STOCK_CONFLICT',
        'The stock balance changed while saving. Reload and try again.',
      );
  } else {
    await tx.run(
      'INSERT INTO stock_balances (product_id,quantity,version,updated_at) VALUES (?,?,1,?)',
      [input.productId, next, now],
    );
  }
  if (input.batchId) {
    const batch = (
      await tx.all<{ quantity_remaining: number; quantity_received: number; version: number }>(
        'SELECT quantity_remaining,quantity_received,version FROM product_batches WHERE id = ?',
        [input.batchId],
      )
    )[0];
    if (!batch) throw new ApiError(404, 'BATCH_NOT_FOUND', 'This batch does not exist.');
    const remaining = Number(batch.quantity_remaining) + input.delta;
    if (remaining < 0)
      throw new ApiError(
        409,
        'INSUFFICIENT_BATCH_STOCK',
        'This batch does not contain enough stock for that movement.',
      );
    // Only a genuine delivery adds to the historical received quantity; a positive adjustment or
    // correction changes the remaining balance alone.
    const received =
      input.delta > 0 && receivingMovementTypes.includes(input.movementType)
        ? Number(batch.quantity_received) + input.delta
        : Number(batch.quantity_received);
    const updated = await tx.run(
      'UPDATE product_batches SET quantity_remaining=?,quantity_received=?,version=version+1,updated_at=? WHERE id=? AND version=?',
      [remaining, received, now, input.batchId, batch.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(
        409,
        'STOCK_CONFLICT',
        'The batch changed while saving. Reload and try again.',
      );
  }
  const movementId = crypto.randomUUID();
  await tx.run(
    `INSERT INTO stock_movements (id,operation_id,operation_fingerprint,product_id,batch_id,movement_type,quantity,previous_balance,new_balance,unit_cost_kobo,reason,reference_id,supplier_id,user_id,device_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      movementId,
      input.operationId,
      input.operationId ? input.operationFingerprint : null,
      input.productId,
      input.batchId,
      input.movementType,
      input.delta,
      previous,
      next,
      input.unitCostKobo,
      input.reason,
      input.referenceId,
      input.supplierId,
      context.auth.user.id,
      context.auth.deviceId,
      now,
    ],
  );
  if (input.adjustmentReason) {
    await tx.run(
      `INSERT INTO stock_adjustments (id,movement_id,product_id,batch_id,adjustment_type,quantity,reason,reference_id,user_id,device_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        crypto.randomUUID(),
        movementId,
        input.productId,
        input.batchId,
        input.movementType,
        input.baseQuantity,
        input.reason,
        input.referenceId,
        context.auth.user.id,
        context.auth.deviceId,
      ],
    );
  }
  await audit(tx, {
    action: `stock.${input.movementType}`,
    actorId: context.auth.user.id,
    deviceId: context.auth.deviceId,
    requestId: context.requestId,
    entityType: 'stock_movement',
    entityId: movementId,
    metadata: {
      productId: input.productId,
      quantity: input.delta,
      previousBalance: previous,
      newBalance: next,
    },
  });
  const stored = (await tx.all<MovementRow>(`${movementSelect} WHERE m.id = ?`, [movementId]))[0]!;
  return { movement: mapMovement(stored), newBalance: next };
}

/** Base-unit cost, derived from the submitted unit cost without floating-point storage. */
function baseUnitCostKobo(unitCostKobo: number, baseQuantity: number, quantity: number) {
  return Math.round((unitCostKobo * quantity) / baseQuantity);
}

export async function receiveStock(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: StockReceiveInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'stock.receive');
    const product = await loadProduct(tx, input.productId);
    if (product.status !== 'active')
      throw new ApiError(
        409,
        'PRODUCT_INACTIVE',
        'Reactivate this product before receiving stock for it.',
      );
    const baseQuantity = await toBaseQuantity(tx, product, input.unitId, input.quantity);
    const fingerprint = await operationFingerprint({
      productId: input.productId,
      batchNumber: input.batchNumber ?? null,
      movementType: input.movementType,
      quantity: baseQuantity,
      unitCostKobo: input.unitCostKobo,
      supplierId: input.supplierId ?? null,
      referenceId: input.referenceId ?? null,
      reason: input.reason,
      baseQuantity,
    });
    const replay = await replayOperation(
      input.operationId ? await findOperation(tx, input.operationId) : undefined,
      {
        productId: input.productId,
        batchNumber: input.batchNumber ?? null,
        movementType: input.movementType,
        quantity: baseQuantity,
        unitCostKobo: input.unitCostKobo,
        supplierId: input.supplierId ?? null,
        referenceId: input.referenceId ?? null,
        reason: input.reason,
        baseQuantity,
      },
    );
    if (replay)
      return { movement: replay, product: mapProduct(await loadProduct(tx, input.productId)) };
    if (input.movementType === 'opening_stock') {
      const history = (
        await tx.all<{ count: number }>(
          'SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ?',
          [product.id],
        )
      )[0]!.count;
      if (Number(history) > 0)
        throw new ApiError(
          409,
          'OPENING_STOCK_CLOSED',
          'Opening stock can only be recorded before any other stock movement exists.',
        );
    }
    const expiryDate = input.expiryDate || null;
    const manufacturingDate = input.manufacturingDate || null;
    if (expiryDate && expiryDate < todayIso())
      throw new ApiError(400, 'EXPIRY_IN_PAST', 'The expiry date is already in the past.');
    if (expiryDate && manufacturingDate && expiryDate < manufacturingDate)
      throw new ApiError(
        400,
        'EXPIRY_BEFORE_MANUFACTURE',
        'The expiry date cannot be before the manufacturing date.',
      );
    if (product.is_expiry_tracked === 1 && !expiryDate)
      throw new ApiError(
        400,
        'EXPIRY_REQUIRED',
        'This product tracks expiry, so an expiry date is required.',
      );
    let batchId: string | null = null;
    const cost = baseUnitCostKobo(input.unitCostKobo, baseQuantity, input.quantity);
    if (product.is_expiry_tracked === 1 || input.batchNumber) {
      if (!input.batchNumber)
        throw new ApiError(400, 'BATCH_REQUIRED', 'Enter a batch number for this delivery.');
      const duplicate = await tx.all<{ id: string }>(
        'SELECT id FROM product_batches WHERE product_id = ? AND batch_number = ? COLLATE NOCASE',
        [product.id, input.batchNumber],
      );
      if (duplicate.length)
        throw new ApiError(
          409,
          'BATCH_EXISTS',
          'A batch with this number already exists for the product. Use a stock correction instead.',
        );
      batchId = crypto.randomUUID();
      await tx.run(
        `INSERT INTO product_batches (id,product_id,batch_number,manufacturing_date,expiry_date,quantity_received,quantity_remaining,purchase_cost_kobo,supplier_id,created_by,updated_by,device_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          batchId,
          product.id,
          input.batchNumber,
          manufacturingDate,
          expiryDate,
          0,
          0,
          cost,
          input.supplierId,
          auth.user.id,
          auth.user.id,
          auth.deviceId,
        ],
      );
    }
    if (input.supplierId) {
      const supplier = await tx.all('SELECT id FROM suppliers WHERE id = ?', [input.supplierId]);
      if (supplier.length !== 1)
        throw new ApiError(400, 'SUPPLIER_NOT_FOUND', 'Select a valid supplier.');
    }
    const result = await recordMovement(
      tx,
      { auth, requestId },
      {
        productId: product.id,
        batchId,
        movementType: input.movementType,
        delta: baseQuantity,
        unitCostKobo: input.unitCostKobo,
        reason: input.reason,
        referenceId: input.referenceId ?? null,
        supplierId: input.supplierId ?? null,
        operationId: input.operationId ?? null,
        operationFingerprint: fingerprint,
        baseQuantity,
      },
    );
    return {
      movement: result.movement,
      product: mapProduct(await loadProduct(tx, product.id)),
    };
  });
}

export async function adjustStock(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: StockAdjustmentInput,
) {
  return db.transaction(async (tx) => {
    const writeOff = input.movementType === 'damaged' || input.movementType === 'expired';
    await assertPermission(tx, auth, writeOff ? 'stock.write_off' : 'stock.adjust');
    const product = await loadProduct(tx, input.productId);
    const baseQuantity = await toBaseQuantity(tx, product, input.unitId, input.quantity);
    const decrease = (decreaseMovementTypes as readonly string[]).includes(input.movementType)
      ? true
      : input.movementType === 'correction'
        ? (input.direction ?? 'decrease') === 'decrease'
        : false;
    const delta = decrease ? -baseQuantity : baseQuantity;
    const operation = {
      productId: input.productId,
      batchNumber: await batchNumberOf(tx, input.batchId ?? null),
      movementType: input.movementType,
      quantity: delta,
      unitCostKobo: null,
      supplierId: null,
      referenceId: input.referenceId ?? null,
      reason: input.reason,
      baseQuantity,
    };
    const fingerprint = await operationFingerprint(operation);
    const replay = await replayOperation(
      input.operationId ? await findOperation(tx, input.operationId) : undefined,
      operation,
    );
    if (replay) return { movement: replay, product: mapProduct(await loadProduct(tx, product.id)) };
    if (product.status !== 'active' && !decrease)
      throw new ApiError(
        409,
        'PRODUCT_INACTIVE',
        'Only stock reductions are allowed while a product is inactive.',
      );
    const batchId = input.batchId ?? null;
    const batches = await tx.all<{ id: string; quantity_remaining: number }>(
      'SELECT id,quantity_remaining FROM product_batches WHERE product_id = ?',
      [product.id],
    );
    // Batch-tracked stock must stay attributable so batch quantities reconcile with the ledger.
    if (!batchId && batches.length > 0)
      throw new ApiError(400, 'BATCH_REQUIRED', 'Choose the batch this adjustment applies to.');
    if (batchId) {
      const batch = batches.find((entry) => entry.id === batchId);
      if (!batch)
        throw new ApiError(400, 'BATCH_NOT_FOUND', 'That batch does not belong to this product.');
      if (decrease && Number(batch.quantity_remaining) < baseQuantity)
        throw new ApiError(
          409,
          'INSUFFICIENT_BATCH_STOCK',
          'This batch does not contain enough stock for that reduction.',
        );
    }
    const result = await recordMovement(
      tx,
      { auth, requestId },
      {
        productId: product.id,
        batchId,
        movementType: input.movementType,
        delta,
        unitCostKobo: null,
        reason: input.reason,
        referenceId: input.referenceId ?? null,
        supplierId: null,
        operationId: input.operationId ?? null,
        operationFingerprint: fingerprint,
        baseQuantity,
        adjustmentReason: true,
      },
    );
    return {
      movement: result.movement,
      product: mapProduct(await loadProduct(tx, product.id)),
    };
  });
}

export async function listMovements(
  db: SqlExecutor,
  query: {
    productId?: string;
    batchId?: string;
    type?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<MovementSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.productId) {
    where.push('m.product_id = ?');
    values.push(query.productId);
  }
  if (query.batchId) {
    where.push('m.batch_id = ?');
    values.push(query.batchId);
  }
  if (query.type) {
    where.push('m.movement_type = ?');
    values.push(query.type);
  }
  if (query.from) {
    where.push('m.created_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    where.push('m.created_at <= ?');
    values.push(`${query.to}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM stock_movements m ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<MovementRow>(
    `${movementSelect} ${clause} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(
    rows.map((row) => mapMovement(row)),
    query.page,
    query.pageSize,
    Number(total),
  );
}

export async function getMovement(db: SqlExecutor, id: string): Promise<MovementSummary> {
  const row = (await db.all<MovementRow>(`${movementSelect} WHERE m.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'MOVEMENT_NOT_FOUND', 'This stock movement does not exist.');
  return mapMovement(row);
}

/**
 * FEFO foundation: first-expired-first-out ordering that excludes already expired batches so
 * a future point-of-sale layer cannot allocate them. No stock is reserved or mutated here.
 */
export async function fefoAllocation(
  db: SqlExecutor,
  productId: string,
  quantity: number,
  asOf?: string,
): Promise<FefoAllocation> {
  await loadProduct(db, productId);
  const reference = asOf ?? todayIso();
  const batches = await db.all<{
    id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity_remaining: number;
  }>(
    `SELECT id,batch_number,expiry_date,quantity_remaining FROM product_batches
    WHERE product_id = ? AND quantity_remaining > 0 AND (expiry_date IS NULL OR expiry_date >= ?)
    ORDER BY (expiry_date IS NULL), expiry_date ASC, recorded_at ASC`,
    [productId, reference],
  );
  const allocations: FefoAllocation['allocations'] = [];
  let remaining = quantity;
  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(batch.quantity_remaining));
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batch_number,
      expiryDate: batch.expiry_date,
      quantity: take,
    });
    remaining -= take;
  }
  return {
    productId,
    requestedQuantity: quantity,
    allocatableQuantity: quantity - remaining,
    allocations,
  };
}

export async function reconciliation(db: SqlExecutor): Promise<ReconciliationReport> {
  const rows = await db.all<{
    product_id: string;
    product_name: string;
    is_expiry_tracked: number;
    balance_quantity: number;
    ledger_quantity: number;
    batch_quantity: number;
  }>(
    `SELECT p.id AS product_id, p.name AS product_name, p.is_expiry_tracked,
      COALESCE(b.quantity, 0) AS balance_quantity,
      COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0) AS ledger_quantity,
      COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id), 0) AS batch_quantity
    FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
    WHERE p.deleted_at IS NULL ORDER BY p.name ASC`,
  );
  const mapped = rows.map((row) => {
    const balance = Number(row.balance_quantity);
    const ledger = Number(row.ledger_quantity);
    const batch = Number(row.batch_quantity);
    const tracked = row.is_expiry_tracked === 1;
    return {
      productId: row.product_id,
      productName: row.product_name,
      balanceQuantity: balance,
      ledgerQuantity: ledger,
      batchQuantity: batch,
      batchTracked: tracked,
      consistent: balance === ledger && (!tracked || balance === batch),
    };
  });
  return {
    checkedAt: new Date().toISOString(),
    productsChecked: mapped.length,
    inconsistentCount: mapped.filter((row) => !row.consistent).length,
    rows: mapped,
  };
}
