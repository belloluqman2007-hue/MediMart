import type { SqlExecutor } from '@medimart/database';
import type { InventoryDashboard } from '@medimart/shared';
import {
  mapMovement,
  mapProduct,
  movementSelect,
  productSelect,
  todayIso,
  type MovementRow,
  type ProductRow,
} from './common';

export async function inventoryDashboard(
  db: SqlExecutor,
  expiryDays: number,
): Promise<InventoryDashboard> {
  const today = todayIso();
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + expiryDays);
  const alertCutoff = cutoff.toISOString().slice(0, 10);

  const totals = (
    await db.all<{
      active_products: number;
      inactive_products: number;
      stock_quantity: number;
      cost_value: number;
      retail_value: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND status='active') AS active_products,
        (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND status='inactive') AS inactive_products,
        COALESCE((SELECT SUM(b.quantity) FROM stock_balances b JOIN products p ON p.id=b.product_id WHERE p.deleted_at IS NULL), 0) AS stock_quantity,
        COALESCE((SELECT SUM(b.quantity * p.purchase_cost_kobo) FROM stock_balances b JOIN products p ON p.id=b.product_id WHERE p.deleted_at IS NULL), 0) AS cost_value,
        COALESCE((SELECT SUM(b.quantity * p.selling_price_kobo) FROM stock_balances b JOIN products p ON p.id=b.product_id WHERE p.deleted_at IS NULL), 0) AS retail_value`,
    )
  )[0]!;

  const counts = (
    await db.all<{
      low_stock: number;
      out_of_stock: number;
      expired_batches: number;
      expired_units: number;
      near_expiry_batches: number;
      near_expiry_units: number;
      suppliers: number;
      categories: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id
          WHERE p.deleted_at IS NULL AND p.status='active' AND p.reorder_level > 0
          AND COALESCE(b.quantity,0) > 0 AND COALESCE(b.quantity,0) <= p.reorder_level) AS low_stock,
        (SELECT COUNT(*) FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id
          WHERE p.deleted_at IS NULL AND p.status='active' AND COALESCE(b.quantity,0) = 0) AS out_of_stock,
        (SELECT COUNT(*) FROM product_batches
          WHERE quantity_remaining > 0 AND expiry_date IS NOT NULL AND expiry_date < ?) AS expired_batches,
        (SELECT COALESCE(SUM(quantity_remaining),0) FROM product_batches
          WHERE quantity_remaining > 0 AND expiry_date IS NOT NULL AND expiry_date < ?) AS expired_units,
        (SELECT COUNT(*) FROM product_batches
          WHERE quantity_remaining > 0 AND expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?) AS near_expiry_batches,
        (SELECT COALESCE(SUM(quantity_remaining),0) FROM product_batches
          WHERE quantity_remaining > 0 AND expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?) AS near_expiry_units,
        (SELECT COUNT(*) FROM suppliers WHERE deleted_at IS NULL AND status='active') AS suppliers,
        (SELECT COUNT(*) FROM categories) AS categories`,
      [today, today, today, alertCutoff, today, alertCutoff],
    )
  )[0]!;

  const movements = await db.all<MovementRow>(
    `${movementSelect} ORDER BY m.created_at DESC, m.id DESC LIMIT 8`,
  );
  const products = await db.all<ProductRow>(
    `${productSelect} WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT 5`,
  );
  const lowStock = await db.all<{
    id: string;
    name: string;
    stock_quantity: number;
    reorder_level: number;
    base_unit_symbol: string;
  }>(
    `SELECT p.id, p.name, COALESCE(b.quantity,0) AS stock_quantity, p.reorder_level, u.symbol AS base_unit_symbol
    FROM products p JOIN units u ON u.id=p.base_unit_id LEFT JOIN stock_balances b ON b.product_id=p.id
    WHERE p.deleted_at IS NULL AND p.status='active' AND p.reorder_level > 0
    AND COALESCE(b.quantity,0) <= p.reorder_level
    ORDER BY COALESCE(b.quantity,0) ASC, p.name ASC LIMIT 6`,
  );

  return {
    totalActiveProducts: Number(totals.active_products),
    totalInactiveProducts: Number(totals.inactive_products),
    totalStockQuantity: Number(totals.stock_quantity),
    stockValueCostKobo: Number(totals.cost_value),
    retailValueKobo: Number(totals.retail_value),
    lowStockCount: Number(counts.low_stock),
    outOfStockCount: Number(counts.out_of_stock),
    expiredBatchCount: Number(counts.expired_batches),
    expiredUnits: Number(counts.expired_units),
    nearExpiryBatchCount: Number(counts.near_expiry_batches),
    nearExpiryUnits: Number(counts.near_expiry_units),
    expiryAlertDays: expiryDays,
    totalSuppliers: Number(counts.suppliers),
    totalCategories: Number(counts.categories),
    recentMovements: movements.map(mapMovement),
    recentlyAddedProducts: products.map(mapProduct),
    lowStockProducts: lowStock.map((row) => ({
      id: row.id,
      name: row.name,
      stockQuantity: Number(row.stock_quantity),
      reorderLevel: Number(row.reorder_level),
      baseUnitSymbol: row.base_unit_symbol,
    })),
  };
}
