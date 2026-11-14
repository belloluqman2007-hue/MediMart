import type { SqlExecutor } from '@medimart/database';
import type {
  MovementSummary,
  Paginated,
  Permission,
  ProductSummary,
  StockMovementType,
} from '@medimart/shared';
import { requireActiveContext, type AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { stockCostValueSql } from './valuation';

export type ProductRow = {
  id: string;
  name: string;
  generic_name: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  product_type: ProductSummary['productType'];
  dosage_form: ProductSummary['dosageForm'];
  strength: string | null;
  pack_size: number | null;
  category_id: string | null;
  category_name: string | null;
  description: string | null;
  manufacturer: string | null;
  purchase_cost_kobo: number;
  selling_price_kobo: number;
  reorder_level: number;
  base_unit_id: string;
  base_unit_name: string;
  base_unit_symbol: string;
  is_expiry_tracked: number;
  status: ProductSummary['status'];
  stock_quantity: number;
  stock_value_cost_kobo: number;
  batch_count: number;
  nearest_expiry_date: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_name: string | null;
  version: number;
};

export type MovementRow = {
  id: string;
  operation_id: string | null;
  operation_fingerprint: string | null;
  product_id: string;
  product_name: string;
  batch_id: string | null;
  batch_number: string | null;
  movement_type: StockMovementType;
  quantity: number;
  previous_balance: number;
  new_balance: number;
  unit_cost_kobo: number | null;
  reason: string;
  reference_id: string | null;
  supplier_id: string | null;
  user_id: string | null;
  user_name: string | null;
  device_id: string | null;
  created_at: string;
};

export const todayIso = () => new Date().toISOString().slice(0, 10);
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** Escape LIKE wildcards in user search text; the ESCAPE clause must be '\'. */
export function likePattern(search: string) {
  return `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
  total: number,
): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
export function mapProduct(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    name: row.name,
    genericName: row.generic_name,
    brand: row.brand,
    sku: row.sku,
    barcode: row.barcode,
    productType: row.product_type,
    dosageForm: row.dosage_form,
    strength: row.strength,
    packSize: row.pack_size === null ? null : Number(row.pack_size),
    categoryId: row.category_id,
    categoryName: row.category_name,
    purchaseCostKobo: Number(row.purchase_cost_kobo),
    sellingPriceKobo: Number(row.selling_price_kobo),
    reorderLevel: Number(row.reorder_level),
    baseUnitId: row.base_unit_id,
    baseUnitName: row.base_unit_name,
    baseUnitSymbol: row.base_unit_symbol,
    isExpiryTracked: row.is_expiry_tracked === 1,
    status: row.status,
    stockQuantity: Number(row.stock_quantity),
    stockValueCostKobo: Number(row.stock_value_cost_kobo),
    batchCount: Number(row.batch_count),
    nearestExpiryDate: row.nearest_expiry_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
  };
}
export function mapMovement(row: MovementRow): MovementSummary {
  return {
    id: row.id,
    operationId: row.operation_id,
    productId: row.product_id,
    productName: row.product_name,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    movementType: row.movement_type,
    quantity: Number(row.quantity),
    previousBalance: Number(row.previous_balance),
    newBalance: Number(row.new_balance),
    unitCostKobo: row.unit_cost_kobo === null ? null : Number(row.unit_cost_kobo),
    reason: row.reason,
    referenceId: row.reference_id,
    userId: row.user_id,
    userName: row.user_name,
    deviceId: row.device_id,
    createdAt: row.created_at,
  };
}

export const productSelect = `
  SELECT p.*, c.name AS category_name, u.name AS base_unit_name, u.symbol AS base_unit_symbol,
    COALESCE(b.quantity, 0) AS stock_quantity,
    CASE WHEN COALESCE(b.quantity, 0) > 0 THEN ${stockCostValueSql('p')} ELSE 0 END AS stock_value_cost_kobo,
    (SELECT COUNT(*) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0) AS batch_count,
    (SELECT MIN(pb.expiry_date) FROM product_batches pb WHERE pb.product_id = p.id AND pb.quantity_remaining > 0 AND pb.expiry_date IS NOT NULL) AS nearest_expiry_date,
    cu.full_name AS created_by_name
  FROM products p
  JOIN units u ON u.id = p.base_unit_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN stock_balances b ON b.product_id = p.id
  LEFT JOIN users cu ON cu.id = p.created_by`;

export const movementSelect = `
  SELECT m.*, p.name AS product_name, b.batch_number, u.full_name AS user_name
  FROM stock_movements m
  JOIN products p ON p.id = m.product_id
  LEFT JOIN product_batches b ON b.id = m.batch_id
  LEFT JOIN users u ON u.id = m.user_id`;

export async function loadProduct(tx: SqlExecutor, id: string): Promise<ProductRow> {
  const row = (
    await tx.all<ProductRow>(`${productSelect} WHERE p.id = ? AND p.deleted_at IS NULL`, [id])
  )[0];
  if (!row) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'This product does not exist.');
  return row;
}
/** Recheck the live session and grants inside a write transaction. */
export async function assertPermission(tx: SqlExecutor, auth: AuthContext, permission: Permission) {
  await requireActiveContext(tx, auth, permission);
}
/**
 * Convert a submitted quantity in the caller's chosen unit into base units using an
 * integer conversion factor. Returns an integer; never a float.
 */
export async function toBaseQuantity(
  tx: SqlExecutor,
  product: { id: string; base_unit_id: string },
  unitId: string,
  quantity: number,
) {
  if (unitId === product.base_unit_id) return quantity;
  const row = (
    await tx.all<{ factor: number }>(
      'SELECT factor FROM product_units WHERE product_id = ? AND unit_id = ?',
      [product.id, unitId],
    )
  )[0];
  if (!row)
    throw new ApiError(
      400,
      'UNIT_NOT_CONFIGURED',
      'This unit is not configured for the selected product.',
    );
  const base = quantity * Number(row.factor);
  if (!Number.isSafeInteger(base) || base <= 0)
    throw new ApiError(400, 'QUANTITY_INVALID', 'The converted quantity is not valid.');
  return base;
}
