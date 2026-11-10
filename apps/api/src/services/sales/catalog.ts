import type { SqlExecutor } from '@medimart/database';
import type {
  Paginated,
  PosBootstrap,
  PosProduct,
  PosSellingUnit,
  ProductType,
} from '@medimart/shared';
import { likePattern, paginate, todayIso } from '../inventory/common';
import { categorySubtreeIds } from '../inventory/products';
import { readShopSettings } from './common';

type PosProductRow = {
  id: string;
  name: string;
  generic_name: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  product_type: ProductType;
  category_id: string | null;
  category_name: string | null;
  selling_price_kobo: number;
  reorder_level: number;
  base_unit_id: string;
  base_unit_code: string;
  base_unit_name: string;
  base_unit_symbol: string;
  is_expiry_tracked: number;
  stock_quantity: number;
  total_batch_remaining: number;
  valid_batch_remaining: number;
  expired_batch_remaining: number;
  nearest_valid_expiry: string | null;
};

const posProductSelect = `
  SELECT
    p.id, p.name, p.generic_name, p.brand, p.sku, p.barcode,
    p.product_type, p.category_id, c.name AS category_name,
    p.selling_price_kobo, p.reorder_level,
    p.base_unit_id, u.code AS base_unit_code, u.name AS base_unit_name, u.symbol AS base_unit_symbol,
    p.is_expiry_tracked,
    COALESCE(b.quantity, 0) AS stock_quantity,
    COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id), 0) AS total_batch_remaining,
    COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND (pb.expiry_date IS NULL OR pb.expiry_date >= ?)), 0) AS valid_batch_remaining,
    COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND pb.expiry_date IS NOT NULL AND pb.expiry_date < ?), 0) AS expired_batch_remaining,
    (SELECT MIN(pb.expiry_date) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND pb.expiry_date IS NOT NULL AND pb.expiry_date >= ?) AS nearest_valid_expiry
  FROM products p
  JOIN units u ON u.id = p.base_unit_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN stock_balances b ON b.product_id = p.id`;

function computeSellableQuantity(row: PosProductRow): number {
  const stockQty = Number(row.stock_quantity);
  const totalBatched = Number(row.total_batch_remaining);
  const validBatched = Number(row.valid_batch_remaining);
  if (row.is_expiry_tracked === 1) {
    return Math.min(stockQty, validBatched);
  }
  const unbatched = Math.max(0, stockQty - totalBatched);
  return validBatched + unbatched;
}

async function hydrateSellingUnits(
  db: SqlExecutor,
  rows: PosProductRow[],
): Promise<Map<string, PosSellingUnit[]>> {
  const byProduct = new Map<string, PosSellingUnit[]>();
  if (rows.length === 0) return byProduct;
  for (const row of rows) {
    byProduct.set(row.id, [
      {
        unitId: row.base_unit_id,
        code: row.base_unit_code,
        name: row.base_unit_name,
        symbol: row.base_unit_symbol,
        factor: 1,
        sellingPriceKobo: Number(row.selling_price_kobo),
      },
    ]);
  }
  const placeholders = rows.map(() => '?').join(',');
  const conversions = await db.all<{
    product_id: string;
    unit_id: string;
    code: string;
    name: string;
    symbol: string;
    factor: number;
  }>(
    `SELECT pu.product_id, pu.unit_id, u.code, u.name, u.symbol, pu.factor
    FROM product_units pu JOIN units u ON u.id = pu.unit_id
    WHERE pu.product_id IN (${placeholders})
    ORDER BY pu.factor ASC`,
    rows.map((r) => r.id),
  );
  const basePriceById = new Map(rows.map((r) => [r.id, Number(r.selling_price_kobo)]));
  for (const conv of conversions) {
    const list = byProduct.get(conv.product_id);
    if (!list) continue;
    const factor = Number(conv.factor);
    const basePrice = basePriceById.get(conv.product_id) ?? 0;
    list.push({
      unitId: conv.unit_id,
      code: conv.code,
      name: conv.name,
      symbol: conv.symbol,
      factor,
      sellingPriceKobo: basePrice * factor,
    });
  }
  return byProduct;
}

function mapPosProduct(row: PosProductRow, units: PosSellingUnit[]): PosProduct {
  const sellableQuantity = computeSellableQuantity(row);
  return {
    id: row.id,
    name: row.name,
    genericName: row.generic_name,
    brand: row.brand,
    sku: row.sku,
    barcode: row.barcode,
    productType: row.product_type,
    categoryId: row.category_id,
    categoryName: row.category_name,
    sellingPriceKobo: Number(row.selling_price_kobo),
    reorderLevel: Number(row.reorder_level),
    baseUnitId: row.base_unit_id,
    baseUnitName: row.base_unit_name,
    baseUnitSymbol: row.base_unit_symbol,
    isExpiryTracked: row.is_expiry_tracked === 1,
    totalStockQuantity: Number(row.stock_quantity),
    sellableQuantity,
    expiredQuantity: Number(row.expired_batch_remaining),
    nearestValidExpiryDate: row.nearest_valid_expiry,
    units,
  };
}

export async function listPosProducts(
  db: SqlExecutor,
  query: {
    search?: string;
    type?: ProductType;
    categoryId?: string;
    inStockOnly?: boolean;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<PosProduct>> {
  const today = todayIso();
  const where: string[] = ["p.deleted_at IS NULL AND p.status = 'active'"];
  const filterValues: Array<string | number> = [];

  if (query.search) {
    where.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.generic_name LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    filterValues.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (query.type) {
    where.push('p.product_type = ?');
    filterValues.push(query.type);
  }
  if (query.categoryId) {
    const ids = await categorySubtreeIds(db, query.categoryId);
    where.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
    filterValues.push(...ids);
  }
  if (query.inStockOnly) {
    where.push(
      `(CASE
        WHEN p.is_expiry_tracked = 1 THEN COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND (pb.expiry_date IS NULL OR pb.expiry_date >= ?)), 0)
        ELSE COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND (pb.expiry_date IS NULL OR pb.expiry_date >= ?)), 0)
          + MAX(0, COALESCE(b.quantity, 0) - COALESCE((SELECT SUM(pb.quantity_remaining) FROM product_batches pb WHERE pb.product_id = p.id), 0))
      END) > 0`,
    );
    filterValues.push(today, today);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id ${clause}`,
      filterValues,
    )
  )[0]!.count;

  const rows = await db.all<PosProductRow>(
    `${posProductSelect} ${clause} ORDER BY p.name ASC, p.id ASC LIMIT ? OFFSET ?`,
    [today, today, today, ...filterValues, query.pageSize, (query.page - 1) * query.pageSize],
  );
  const unitsByProduct = await hydrateSellingUnits(db, rows);
  return paginate(
    rows.map((row) => mapPosProduct(row, unitsByProduct.get(row.id) ?? [])),
    query.page,
    query.pageSize,
    Number(total),
  );
}

export async function lookupPosProductByCode(
  db: SqlExecutor,
  code: string,
): Promise<PosProduct | null> {
  const today = todayIso();
  const trimmed = code.trim();
  const rows = await db.all<PosProductRow>(
    `${posProductSelect}
    WHERE p.deleted_at IS NULL AND p.status = 'active'
      AND (p.barcode = ? COLLATE NOCASE OR p.sku = ? COLLATE NOCASE)
    ORDER BY (CASE WHEN p.barcode = ? COLLATE NOCASE THEN 0 ELSE 1 END) ASC
    LIMIT 1`,
    [today, today, today, trimmed, trimmed, trimmed],
  );
  const row = rows[0];
  if (!row) return null;
  const unitsByProduct = await hydrateSellingUnits(db, [row]);
  return mapPosProduct(row, unitsByProduct.get(row.id) ?? []);
}

export async function posBootstrap(db: SqlExecutor): Promise<PosBootstrap> {
  const categories = await db.all<{
    id: string;
    name: string;
    kind: 'pharmacy' | 'mini_mart' | 'general';
  }>('SELECT id, name, kind FROM categories ORDER BY kind ASC, name ASC');
  return {
    categories,
    shop: await readShopSettings(db),
  };
}
