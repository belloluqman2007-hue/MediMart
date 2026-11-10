import type { SqlExecutor } from '@medimart/database';
import type { InventoryValuation, InventoryValuationRow } from '@medimart/shared';

/**
 * Authoritative stock valuation — accounting treatment.
 *
 * On-hand stock is valued at **actual batch acquisition cost** wherever batch cost data exists:
 * each `product_batches` row carries the per-base-unit cost that was really paid when the goods
 * were received (or corrected). Quantities with no batch cost data — for example legacy opening
 * stock recorded without a batch — fall back to the product's current cost price
 * (`products.purchase_cost_kobo`). Expired batches stay valued at cost until an expiry write-off
 * movement removes them, so expiring stock is never silently written out of the valuation.
 * Retail value (`selling_price_kobo`) is shown separately and is informational only.
 *
 * Historical transactions are never restated: every sale is costed at the batch acquisition cost
 * in effect when it happened (see `services/sales/transactions.ts`), so COGS and gross profit in
 * past reports do not change when prices change later.
 *
 * Every surface — the inventory dashboard, the product list's cost-value column, and the financial
 * reports — must value stock through the SQL below so the numbers can never drift apart. Phase 6
 * found `/api/inventory/dashboard` using product cost prices while `/api/reports/finance` used
 * batch acquisition costs; Phase 7 unified both on batch acquisition costs (this module).
 */

const batchRemainingSql = (p: string) =>
  `(SELECT COALESCE(SUM(pb.quantity_remaining), 0) FROM product_batches pb WHERE pb.product_id = ${p}.id)`;

const batchCostSql = (p: string) =>
  `(SELECT COALESCE(SUM(pb.quantity_remaining * pb.purchase_cost_kobo), 0) FROM product_batches pb WHERE pb.product_id = ${p}.id)`;

/**
 * Cost value of the on-hand stock of one product row, in integer kobo:
 * `batch acquisition cost of batched units + product cost price × unbatched units`.
 * `quantitySql` must resolve to the product's on-hand quantity in base units.
 */
export function stockCostValueSql(p = 'p', quantitySql = 'COALESCE(b.quantity, 0)') {
  return `(${batchCostSql(p)} + MAX(0, ${quantitySql} - ${batchRemainingSql(p)}) * ${p}.purchase_cost_kobo)`;
}

/**
 * The valuation row set: live, non-deleted products that actually hold stock. Rows outside this
 * set contribute zero and are excluded so every consumer sums the same products.
 */
const valuationFromSql = `
  FROM products p
  JOIN units u ON u.id = p.base_unit_id
  LEFT JOIN stock_balances b ON b.product_id = p.id
  WHERE p.deleted_at IS NULL AND COALESCE(b.quantity, 0) > 0`;

export type StockValuationTotals = {
  totalCostKobo: number;
  totalRetailKobo: number;
  totalUnits: number;
};

/** Totals over the canonical valuation row set. Used by the inventory dashboard. */
export async function stockValuationTotals(db: SqlExecutor): Promise<StockValuationTotals> {
  const row = (
    await db.all<{
      cost_value: number;
      retail_value: number;
      units: number;
    }>(
      `SELECT
        COALESCE(SUM(cost_value_kobo), 0) AS cost_value,
        COALESCE(SUM(retail_value_kobo), 0) AS retail_value,
        COALESCE(SUM(stock_quantity), 0) AS units
      FROM (
        SELECT
          ${stockCostValueSql('p')} AS cost_value_kobo,
          COALESCE(b.quantity, 0) * p.selling_price_kobo AS retail_value_kobo,
          COALESCE(b.quantity, 0) AS stock_quantity
        ${valuationFromSql}
      )`,
    )
  )[0]!;
  return {
    totalCostKobo: Number(row.cost_value),
    totalRetailKobo: Number(row.retail_value),
    totalUnits: Number(row.units),
  };
}

/**
 * Per-product valuation rows plus totals. Used by the financial reports (and their
 * `inventory_valuation` CSV export), and available to any surface that needs the breakdown.
 */
export async function inventoryValuation(db: SqlExecutor): Promise<InventoryValuation> {
  const rows = await db.all<{
    product_id: string;
    product_name: string;
    sku: string | null;
    base_unit_symbol: string;
    stock_quantity: number;
    is_expiry_tracked: number;
    batch_remaining: number;
    cost_value_kobo: number;
    retail_value_kobo: number;
  }>(
    `SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      u.symbol AS base_unit_symbol,
      COALESCE(b.quantity, 0) AS stock_quantity,
      p.is_expiry_tracked,
      ${batchRemainingSql('p')} AS batch_remaining,
      ${stockCostValueSql('p')} AS cost_value_kobo,
      COALESCE(b.quantity, 0) * p.selling_price_kobo AS retail_value_kobo
    ${valuationFromSql}
    ORDER BY p.name ASC`,
  );
  let totalCost = 0;
  let totalRetail = 0;
  let totalUnits = 0;
  const mapped: InventoryValuationRow[] = rows.map((row) => {
    const costValue = Number(row.cost_value_kobo);
    const retailValue = Number(row.retail_value_kobo);
    const stock = Number(row.stock_quantity);
    totalCost += costValue;
    totalRetail += retailValue;
    totalUnits += stock;
    return {
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      baseUnitSymbol: row.base_unit_symbol,
      stockQuantity: stock,
      batchTracked: Number(row.is_expiry_tracked) === 1 || Number(row.batch_remaining) > 0,
      costValueKobo: costValue,
      retailValueKobo: retailValue,
    };
  });
  return {
    rows: mapped,
    totalCostKobo: totalCost,
    totalRetailKobo: totalRetail,
    totalUnits,
  };
}
