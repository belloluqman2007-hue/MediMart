import type { SqlExecutor } from '@medimart/database';
import type {
  FinancialSeparation,
  ProductType,
  SalesDashboardSummary,
  SalesReport,
  SalesTrendPoint,
} from '@medimart/shared';
import { ApiError } from '../../errors';
import { addDays, todayIso } from '../inventory/common';
import { mapSaleSummary, saleHeaderSelect, type SaleHeaderRow } from './transactions';

async function computeFinancialSeparation(
  db: SqlExecutor,
  fromDate: string,
  toDate: string,
  includeProfit: boolean,
): Promise<{
  completedCount: number;
  voidedCount: number;
  refundCount: number;
  financials: FinancialSeparation;
}> {
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso = `${toDate}T23:59:59.999Z`;

  const saleAgg = (
    await db.all<{
      completed_count: number;
      voided_count: number;
      gross_sales: number;
      discounts_given: number;
      voided_sales: number;
      sales_cogs: number;
      period_credit: number;
    }>(
      `SELECT
        COALESCE(SUM(CASE WHEN status != 'voided' THEN 1 ELSE 0 END), 0) AS completed_count,
        COALESCE(SUM(CASE WHEN status = 'voided' THEN 1 ELSE 0 END), 0) AS voided_count,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN total_kobo ELSE 0 END), 0) AS gross_sales,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN discount_total_kobo ELSE 0 END), 0) AS discounts_given,
        COALESCE(SUM(CASE WHEN status = 'voided' THEN total_kobo ELSE 0 END), 0) AS voided_sales,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN cogs_kobo ELSE 0 END), 0) AS sales_cogs,
        COALESCE(SUM(CASE WHEN status != 'voided' THEN initial_outstanding_kobo ELSE 0 END), 0) AS period_credit
      FROM sales
      WHERE created_at >= ? AND created_at <= ?`,
      [fromIso, toIso],
    )
  )[0]!;

  const refundAgg = (
    await db.all<{
      refund_count: number;
      refund_total: number;
      refund_cogs: number;
    }>(
      `SELECT
        COUNT(*) AS refund_count,
        COALESCE(SUM(total_reversed_kobo), 0) AS refund_total,
        COALESCE(SUM(cogs_reversed_kobo), 0) AS refund_cogs
      FROM sale_reversals
      WHERE reversal_type = 'refund' AND created_at >= ? AND created_at <= ?`,
      [fromIso, toIso],
    )
  )[0]!;

  const salePaymentAgg = await db.all<{
    method: 'cash' | 'bank_transfer' | 'pos_terminal';
    net_received: number;
  }>(
    `SELECT
      method,
      COALESCE(SUM(CASE WHEN payment_kind = 'sale_payment' THEN net_amount_kobo ELSE -net_amount_kobo END), 0) AS net_received
    FROM sale_payments
    WHERE method IN ('cash','bank_transfer','pos_terminal')
      AND created_at >= ? AND created_at <= ?
    GROUP BY method`,
    [fromIso, toIso],
  );

  const debtPaymentAgg = await db.all<{
    method: 'cash' | 'bank_transfer' | 'pos_terminal';
    repaid: number;
  }>(
    `SELECT
      method,
      COALESCE(SUM(amount_kobo), 0) AS repaid
    FROM debt_payments
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY method`,
    [fromIso, toIso],
  );

  const liveDebtRow = (
    await db.all<{ outstanding: number }>(
      `SELECT COALESCE(SUM(outstanding_kobo), 0) AS outstanding
      FROM customer_debts
      WHERE status IN ('open','partial')`,
    )
  )[0]!;

  const saleByMethod = { cash: 0, bank_transfer: 0, pos_terminal: 0 };
  for (const row of salePaymentAgg) {
    saleByMethod[row.method] = Number(row.net_received);
  }
  const debtByMethod = { cash: 0, bank_transfer: 0, pos_terminal: 0 };
  for (const row of debtPaymentAgg) {
    debtByMethod[row.method] = Number(row.repaid);
  }

  const cashMethodReceivedKobo = saleByMethod.cash + debtByMethod.cash;
  const bankTransferReceivedKobo = saleByMethod.bank_transfer + debtByMethod.bank_transfer;
  const posReceivedKobo = saleByMethod.pos_terminal + debtByMethod.pos_terminal;
  const salesPaymentsReceivedKobo =
    saleByMethod.cash + saleByMethod.bank_transfer + saleByMethod.pos_terminal;
  const debtRepaymentsReceivedKobo =
    debtByMethod.cash + debtByMethod.bank_transfer + debtByMethod.pos_terminal;
  const cashActuallyReceivedKobo =
    cashMethodReceivedKobo + bankTransferReceivedKobo + posReceivedKobo;

  const grossSalesKobo = Number(saleAgg.gross_sales);
  const refundsKobo = Number(refundAgg.refund_total);
  const salesRevenueKobo = grossSalesKobo - refundsKobo;
  const netCogsKobo = Number(saleAgg.sales_cogs) - Number(refundAgg.refund_cogs);
  const grossProfitKobo = salesRevenueKobo - netCogsKobo;

  return {
    completedCount: Number(saleAgg.completed_count),
    voidedCount: Number(saleAgg.voided_count),
    refundCount: Number(refundAgg.refund_count),
    financials: {
      grossSalesKobo,
      discountsGivenKobo: Number(saleAgg.discounts_given),
      refundsKobo,
      voidedSalesKobo: Number(saleAgg.voided_sales),
      salesRevenueKobo,
      cashActuallyReceivedKobo,
      cashMethodReceivedKobo,
      bankTransferReceivedKobo,
      posReceivedKobo,
      salesPaymentsReceivedKobo,
      debtRepaymentsReceivedKobo,
      periodCreditSalesKobo: Number(saleAgg.period_credit),
      outstandingCreditKobo: Number(liveDebtRow.outstanding),
      costOfGoodsSoldKobo: includeProfit ? netCogsKobo : null,
      grossProfitKobo: includeProfit ? grossProfitKobo : null,
      expensesKobo: 0,
      expensesTracked: false,
    },
  };
}

function enumerateDates(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  let cursor = fromDate;
  while (cursor <= toDate && dates.length < 366) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

async function computeDailyTrends(
  db: SqlExecutor,
  fromDate: string,
  toDate: string,
  includeProfit: boolean,
): Promise<SalesTrendPoint[]> {
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso = `${toDate}T23:59:59.999Z`;

  const salesByDay = await db.all<{
    day: string;
    tx_count: number;
    gross_sales: number;
    credit_sales: number;
    cogs: number;
  }>(
    `SELECT
      substr(created_at, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN status != 'voided' THEN 1 ELSE 0 END), 0) AS tx_count,
      COALESCE(SUM(CASE WHEN status != 'voided' THEN total_kobo ELSE 0 END), 0) AS gross_sales,
      COALESCE(SUM(CASE WHEN status != 'voided' THEN initial_outstanding_kobo ELSE 0 END), 0) AS credit_sales,
      COALESCE(SUM(CASE WHEN status != 'voided' THEN cogs_kobo ELSE 0 END), 0) AS cogs
    FROM sales
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10)`,
    [fromIso, toIso],
  );

  const refundsByDay = await db.all<{
    day: string;
    refund_total: number;
    refund_cogs: number;
  }>(
    `SELECT
      substr(created_at, 1, 10) AS day,
      COALESCE(SUM(total_reversed_kobo), 0) AS refund_total,
      COALESCE(SUM(cogs_reversed_kobo), 0) AS refund_cogs
    FROM sale_reversals
    WHERE reversal_type = 'refund' AND created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10)`,
    [fromIso, toIso],
  );

  const saleMoneyByDay = await db.all<{
    day: string;
    net_money: number;
  }>(
    `SELECT
      substr(created_at, 1, 10) AS day,
      COALESCE(SUM(CASE WHEN payment_kind = 'sale_payment' THEN net_amount_kobo ELSE -net_amount_kobo END), 0) AS net_money
    FROM sale_payments
    WHERE method IN ('cash','bank_transfer','pos_terminal')
      AND created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10)`,
    [fromIso, toIso],
  );

  const debtMoneyByDay = await db.all<{
    day: string;
    repaid_money: number;
  }>(
    `SELECT
      substr(created_at, 1, 10) AS day,
      COALESCE(SUM(amount_kobo), 0) AS repaid_money
    FROM debt_payments
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY substr(created_at, 1, 10)`,
    [fromIso, toIso],
  );

  const salesMap = new Map(salesByDay.map((r) => [r.day, r]));
  const refundMap = new Map(refundsByDay.map((r) => [r.day, r]));
  const saleMoneyMap = new Map(saleMoneyByDay.map((r) => [r.day, Number(r.net_money)]));
  const debtMoneyMap = new Map(debtMoneyByDay.map((r) => [r.day, Number(r.repaid_money)]));

  return enumerateDates(fromDate, toDate).map((date) => {
    const s = salesMap.get(date);
    const r = refundMap.get(date);
    const revenue = Number(s?.gross_sales ?? 0) - Number(r?.refund_total ?? 0);
    const cogs = Number(s?.cogs ?? 0) - Number(r?.refund_cogs ?? 0);
    const money = (saleMoneyMap.get(date) ?? 0) + (debtMoneyMap.get(date) ?? 0);
    return {
      date,
      transactionsCount: Number(s?.tx_count ?? 0),
      netSalesRevenueKobo: revenue,
      moneyReceivedKobo: money,
      creditSalesKobo: Number(s?.credit_sales ?? 0),
      cogsKobo: includeProfit ? cogs : null,
      grossProfitKobo: includeProfit ? revenue - cogs : null,
    };
  });
}

export async function salesDashboardSummary(
  db: SqlExecutor,
  includeProfit: boolean,
): Promise<SalesDashboardSummary> {
  const today = todayIso();
  const weekStart = addDays(today, -6);

  const todayStats = await computeFinancialSeparation(db, today, today, includeProfit);
  const trends = await computeDailyTrends(db, weekStart, today, includeProfit);

  const debtCounts = (
    await db.all<{ open_count: number; customers_count: number }>(
      `SELECT
        COUNT(*) AS open_count,
        COUNT(DISTINCT customer_id) AS customers_count
      FROM customer_debts
      WHERE status IN ('open','partial') AND outstanding_kobo > 0`,
    )
  )[0]!;

  const recentSales = await db.all<SaleHeaderRow>(
    `${saleHeaderSelect} ORDER BY s.created_at DESC, s.id DESC LIMIT 8`,
  );

  return {
    today,
    todayTransactionsCount: todayStats.completedCount,
    todayVoidedCount: todayStats.voidedCount,
    todayFinancials: todayStats.financials,
    openDebtCount: Number(debtCounts.open_count),
    customersWithDebtCount: Number(debtCounts.customers_count),
    trends,
    recentSales: recentSales.map(mapSaleSummary),
  };
}

export async function salesFinancialReport(
  db: SqlExecutor,
  query: { from?: string; to?: string },
): Promise<SalesReport> {
  const today = todayIso();
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -29);
  if (from > to) {
    throw new ApiError(400, 'INVALID_DATE_RANGE', 'Start date cannot be after end date.');
  }

  const stats = await computeFinancialSeparation(db, from, to, true);
  const trends = await computeDailyTrends(db, from, to, true);

  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;

  const topProductsRows = await db.all<{
    product_id: string;
    product_name: string;
    product_type: ProductType;
    base_unit_symbol: string;
    net_base_qty: number;
    net_revenue: number;
    net_cogs: number;
  }>(
    `SELECT
      si.product_id,
      MAX(si.product_name_snapshot) AS product_name,
      MAX(si.product_type_snapshot) AS product_type,
      u.symbol AS base_unit_symbol,
      SUM(si.base_quantity - si.quantity_refunded_base) AS net_base_qty,
      SUM(si.net_total_kobo - si.amount_refunded_kobo) AS net_revenue,
      SUM(
        si.cogs_kobo - COALESCE(
          (SELECT SUM(sri.cogs_reversed_kobo) FROM sale_reversal_items sri JOIN sale_reversals sr ON sr.id = sri.reversal_id WHERE sri.sale_item_id = si.id AND sr.reversal_type = 'refund'),
          0
        )
      ) AS net_cogs
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    JOIN units u ON u.id = p.base_unit_id
    WHERE s.status != 'voided' AND s.created_at >= ? AND s.created_at <= ?
    GROUP BY si.product_id
    HAVING net_base_qty > 0 OR net_revenue > 0
    ORDER BY net_revenue DESC, net_base_qty DESC
    LIMIT 15`,
    [fromIso, toIso],
  );

  const debtStats = (
    await db.all<{
      open_count: number;
      customers_count: number;
      total_outstanding: number;
      overdue_amount: number;
    }>(
      `SELECT
        COUNT(*) AS open_count,
        COUNT(DISTINCT customer_id) AS customers_count,
        COALESCE(SUM(outstanding_kobo), 0) AS total_outstanding,
        COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < ? THEN outstanding_kobo ELSE 0 END), 0) AS overdue_amount
      FROM customer_debts
      WHERE status IN ('open','partial') AND outstanding_kobo > 0`,
      [today],
    )
  )[0]!;

  return {
    from,
    to,
    completedTransactionsCount: stats.completedCount,
    voidedTransactionsCount: stats.voidedCount,
    refundCount: stats.refundCount,
    financials: stats.financials,
    trends,
    topProducts: topProductsRows.map((row) => {
      const revenue = Number(row.net_revenue);
      const cogs = Number(row.net_cogs);
      return {
        productId: row.product_id,
        productName: row.product_name,
        productType: row.product_type,
        baseUnitSymbol: row.base_unit_symbol,
        baseQuantitySold: Number(row.net_base_qty),
        revenueKobo: revenue,
        cogsKobo: cogs,
        grossProfitKobo: revenue - cogs,
      };
    }),
    debtSummary: {
      openDebtCount: Number(debtStats.open_count),
      customersWithDebtCount: Number(debtStats.customers_count),
      totalOutstandingKobo: Number(debtStats.total_outstanding),
      overdueAmountKobo: Number(debtStats.overdue_amount),
    },
  };
}
