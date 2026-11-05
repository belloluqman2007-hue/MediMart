import type { Database, SqlExecutor } from '@medimart/database';
import type {
  Paginated,
  ProductDetail,
  ProductInput,
  ProductUnitSummary,
  UnitSummary,
} from '@medimart/shared';
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
  productSelect,
  type MovementRow,
  type ProductRow,
} from './common';
import { listBatchesForProduct, expiryAlertDays } from './stock';

type ListQuery = {
  search?: string;
  type?: string;
  status?: string;
  categoryId?: string;
  stock?: 'low' | 'out' | 'in';
  sort: string;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
};

const sortColumns: Record<string, string> = {
  name: 'p.name',
  createdAt: 'p.created_at',
  sellingPriceKobo: 'p.selling_price_kobo',
  purchaseCostKobo: 'p.purchase_cost_kobo',
  stockQuantity: 'COALESCE(b.quantity, 0)',
  reorderLevel: 'p.reorder_level',
};

export async function categorySubtreeIds(tx: SqlExecutor, categoryId: string) {
  const rows = await tx.all<{ id: string; parent_id: string | null }>(
    'SELECT id,parent_id FROM categories',
  );
  if (!rows.some((row) => row.id === categoryId))
    throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'This category does not exist.');
  const ids = new Set([categoryId]);
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (row.parent_id && ids.has(row.parent_id) && !ids.has(row.id)) {
        ids.add(row.id);
        added = true;
      }
    }
  }
  return [...ids];
}

export async function listProducts(
  db: SqlExecutor,
  query: ListQuery,
): Promise<Paginated<ReturnType<typeof mapProduct>>> {
  const where: string[] = ['p.deleted_at IS NULL'];
  const values: Array<string | number> = [];
  if (query.search) {
    where.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.generic_name LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\' OR p.manufacturer LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    values.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (query.type) {
    where.push('p.product_type = ?');
    values.push(query.type);
  }
  if (query.status) {
    where.push('p.status = ?');
    values.push(query.status);
  }
  if (query.categoryId) {
    const ids = await categorySubtreeIds(db, query.categoryId);
    where.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
    values.push(...ids);
  }
  if (query.stock === 'out') where.push('COALESCE(b.quantity, 0) = 0');
  if (query.stock === 'in') where.push('COALESCE(b.quantity, 0) > 0');
  if (query.stock === 'low')
    where.push(
      'p.reorder_level > 0 AND COALESCE(b.quantity, 0) > 0 AND COALESCE(b.quantity, 0) <= p.reorder_level',
    );
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id ${clause}`,
      values,
    )
  )[0]!.count;
  const column = sortColumns[query.sort] ?? sortColumns.createdAt;
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const rows = await db.all<ProductRow>(
    `${productSelect} ${clause} ORDER BY ${column} ${direction}, p.id ${direction} LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(
    rows.map((row) => mapProduct(row)),
    query.page,
    query.pageSize,
    Number(total),
  );
}

async function productUnits(tx: SqlExecutor, productId: string): Promise<ProductUnitSummary[]> {
  const rows = await tx.all<{
    unit_id: string;
    code: string;
    name: string;
    symbol: string;
    factor: number;
  }>(
    `SELECT pu.unit_id, u.code, u.name, u.symbol, pu.factor
    FROM product_units pu JOIN units u ON u.id = pu.unit_id
    WHERE pu.product_id = ? ORDER BY pu.factor ASC`,
    [productId],
  );
  return rows.map((row) => ({
    unitId: row.unit_id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    factor: Number(row.factor),
  }));
}

export async function getProductDetail(
  db: SqlExecutor,
  id: string,
  alertDays?: number,
): Promise<ProductDetail> {
  const row = await loadProduct(db, id);
  const days = alertDays ?? (await expiryAlertDays(db));
  const batches = await listBatchesForProduct(db, id, days);
  const movements = await db.all<MovementRow>(
    `${movementSelect} WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 10`,
    [id],
  );
  return {
    ...mapProduct(row),
    description: row.description,
    manufacturer: row.manufacturer,
    units: await productUnits(db, id),
    batches,
    recentMovements: movements.map((movement) => mapMovement(movement)),
    stockByBatchQuantity: batches
      .filter((batch) => batch.status !== 'depleted')
      .reduce((total, batch) => total + batch.quantityRemaining, 0),
  };
}

async function validateProductReferences(tx: SqlExecutor, input: ProductInput) {
  if ((await tx.all('SELECT id FROM units WHERE id = ?', [input.baseUnitId])).length !== 1)
    throw new ApiError(400, 'UNIT_NOT_FOUND', 'Select a valid base unit.');
  if (
    input.categoryId &&
    (await tx.all('SELECT id FROM categories WHERE id = ?', [input.categoryId])).length !== 1
  )
    throw new ApiError(400, 'CATEGORY_NOT_FOUND', 'Select a valid category.');
  for (const unit of input.units) {
    if (unit.unitId === input.baseUnitId)
      throw new ApiError(
        400,
        'UNIT_DUPLICATE',
        'The base unit already represents one base unit; remove it from the conversions.',
      );
    if ((await tx.all('SELECT id FROM units WHERE id = ?', [unit.unitId])).length !== 1)
      throw new ApiError(400, 'UNIT_NOT_FOUND', 'A selected conversion unit does not exist.');
  }
  if (new Set(input.units.map((unit) => unit.unitId)).size !== input.units.length)
    throw new ApiError(400, 'UNIT_DUPLICATE', 'Each conversion unit can only be used once.');
}

async function assertUniqueIdentifiers(tx: SqlExecutor, input: ProductInput, excludeId?: string) {
  if (input.sku) {
    const rows = await tx.all<{ id: string }>(
      'SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND deleted_at IS NULL',
      [input.sku],
    );
    if (rows.some((row) => row.id !== excludeId))
      throw new ApiError(409, 'SKU_IN_USE', 'Another product already uses this SKU.');
  }
  if (input.barcode) {
    const rows = await tx.all<{ id: string }>(
      'SELECT id FROM products WHERE barcode = ? COLLATE NOCASE AND deleted_at IS NULL',
      [input.barcode],
    );
    if (rows.some((row) => row.id !== excludeId))
      throw new ApiError(409, 'BARCODE_IN_USE', 'Another product already uses this barcode.');
  }
}

async function replaceUnits(tx: SqlExecutor, productId: string, input: ProductInput) {
  await tx.run('DELETE FROM product_units WHERE product_id = ?', [productId]);
  for (const unit of input.units)
    await tx.run('INSERT INTO product_units (id,product_id,unit_id,factor) VALUES (?,?,?,?)', [
      crypto.randomUUID(),
      productId,
      unit.unitId,
      unit.factor,
    ]);
}

const productColumns = `name,generic_name,brand,sku,barcode,product_type,category_id,description,manufacturer,
  purchase_cost_kobo,selling_price_kobo,reorder_level,base_unit_id,is_expiry_tracked,status`;

export async function createProduct(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: ProductInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'products.create');
    await validateProductReferences(tx, input);
    await assertUniqueIdentifiers(tx, input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await tx.run(
      `INSERT INTO products (id,${productColumns},created_by,updated_by,device_id,created_at,updated_at)
      VALUES (${Array.from({ length: 21 }, () => '?').join(',')})`,
      [
        id,
        input.name,
        input.genericName ?? null,
        input.brand ?? null,
        input.sku,
        input.barcode,
        input.productType,
        input.categoryId,
        input.description ?? null,
        input.manufacturer ?? null,
        input.purchaseCostKobo,
        input.sellingPriceKobo,
        input.reorderLevel,
        input.baseUnitId,
        input.isExpiryTracked ? 1 : 0,
        input.status,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
        now,
        now,
      ],
    );
    await replaceUnits(tx, id, input);
    await audit(tx, {
      action: 'product.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'product',
      entityId: id,
      metadata: { productType: input.productType, expiryTracked: input.isExpiryTracked },
    });
    return getProductDetail(tx, id);
  });
}

export async function updateProduct(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: ProductInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'products.edit');
    const existing = await loadProduct(tx, id);
    await validateProductReferences(tx, input);
    await assertUniqueIdentifiers(tx, input, id);
    const balance = (
      await tx.all<{ quantity: number }>(
        'SELECT quantity FROM stock_balances WHERE product_id = ?',
        [id],
      )
    )[0];
    if (balance && balance.quantity > 0 && input.baseUnitId !== existing.base_unit_id)
      throw new ApiError(
        409,
        'BASE_UNIT_LOCKED',
        'The base unit cannot change while this product still has stock. Adjust the stock to zero first.',
      );
    const now = new Date().toISOString();
    await tx.run(
      `UPDATE products SET name=?,generic_name=?,brand=?,sku=?,barcode=?,product_type=?,category_id=?,
        description=?,manufacturer=?,purchase_cost_kobo=?,selling_price_kobo=?,reorder_level=?,
        base_unit_id=?,is_expiry_tracked=?,status=?,updated_by=?,device_id=?,version=version+1,updated_at=?
      WHERE id=? AND deleted_at IS NULL`,
      [
        input.name,
        input.genericName ?? null,
        input.brand ?? null,
        input.sku,
        input.barcode,
        input.productType,
        input.categoryId,
        input.description ?? null,
        input.manufacturer ?? null,
        input.purchaseCostKobo,
        input.sellingPriceKobo,
        input.reorderLevel,
        input.baseUnitId,
        input.isExpiryTracked ? 1 : 0,
        input.status,
        auth.user.id,
        auth.deviceId,
        now,
        id,
      ],
    );
    await replaceUnits(tx, id, input);
    await audit(tx, {
      action: 'product.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'product',
      entityId: id,
      metadata: { status: input.status },
    });
    return getProductDetail(tx, id);
  });
}

export async function setProductStatus(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  status: 'active' | 'inactive',
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'products.deactivate');
    const existing = await loadProduct(tx, id);
    if (existing.status === status) return getProductDetail(tx, id);
    await tx.run(
      'UPDATE products SET status=?, updated_by=?, device_id=?, version=version+1, updated_at=? WHERE id=?',
      [status, auth.user.id, auth.deviceId, new Date().toISOString(), id],
    );
    await audit(tx, {
      action: status === 'active' ? 'product.activated' : 'product.deactivated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'product',
      entityId: id,
    });
    return getProductDetail(tx, id);
  });
}

export async function listUnits(db: SqlExecutor): Promise<UnitSummary[]> {
  const rows = await db.all<{
    id: string;
    code: string;
    name: string;
    symbol: string;
    is_system: number;
  }>('SELECT id,code,name,symbol,is_system FROM units ORDER BY is_system DESC, name ASC');
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    isSystem: row.is_system === 1,
  }));
}
