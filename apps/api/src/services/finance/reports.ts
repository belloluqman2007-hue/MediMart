import type { SqlExecutor } from '@medimart/database';
import type {
  CashMovementMethodTotal,
  CashMovementReport,
  CashMovementRow,
  CashRegisterSummary,
  CogsRow,
  CollectionsFinancials,
  ExpenseCategoryBreakdown,
  ExpenseDatePoint,
  ExpenseFinancials,
  FinancialDashboardSummary,
  FinancialExport,
  FinancialReport,
  FinancialReportKind,
  FinancialReportPeriod,
  InventoryFinancials,
  PaymentMethod,
  ProfitFinancials,
  PurchaseFinancials,
  PurchaseReportRow,
  SalesFinancials,
  SupplierPaymentReportRow,
} from '@medimart/shared';
import { financialReportLabels } from '@medimart/shared';
import { ApiError } from '../../errors';
import { todayIso } from '../inventory/common';
import { inventoryValuation } from '../inventory/valuation';
import { supplierBalanceSnapshot } from './accounts';
import { buildCsv, dateRangeIso, reportWindow } from './common';
import { expenseSelect, mapExpense, type ExpenseRow } from './expenses';
import { mapPurchaseOrderSummary, purchaseOrderSelect, type PurchaseOrderRow } from './records';

const MAX_DAILY_DAYS = 731;
const MAX_TREND_BUCKETS = 800;

function isoDaysBetween(from: string, to: string) {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000,
  );
}

function isoAddDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekStart(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const offset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

function formatDay(date: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatMonth(key: string) {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${key}-01T00:00:00.000Z`));
}

function trendKeyExpression(period: FinancialReportPeriod, column: string) {
  if (period === 'monthly') return `substr(${column},1,7)`;
  if (period === 'weekly') return `date(${column}, 'weekday 0', '-6 days')`;
  return `substr(${column},1,10)`;
}

function trendBuckets(from: string, to: string, period: FinancialReportPeriod) {
  const days = isoDaysBetween(from, to);
  if (period === 'daily' && days > MAX_DAILY_DAYS)
    throw new ApiError(
      400,
      'DATE_RANGE_TOO_LARGE',
      'Use a range of two years or fewer for a daily report.',
    );
  const buckets: Array<{ key: string; label: string }> = [];
  if (period === 'daily') {
    for (let offset = 0; offset <= days; offset += 1) {
      const key = isoAddDays(from, offset);
      buckets.push({ key, label: formatDay(key) });
    }
  } else if (period === 'weekly') {
    let cursor = weekStart(from);
    while (cursor <= to && buckets.length < MAX_TREND_BUCKETS) {
      buckets.push({ key: cursor, label: `Week of ${formatDay(cursor)}` });
      cursor = isoAddDays(cursor, 7);
    }
  } else {
    let cursor = `${from.slice(0, 7)}-01`;
    const end = `${to.slice(0, 7)}-01`;
    while (cursor <= end && buckets.length < MAX_TREND_BUCKETS) {
      buckets.push({ key: cursor.slice(0, 7), label: formatMonth(cursor.slice(0, 7)) });
      const value = new Date(`${cursor}T00:00:00.000Z`);
      value.setUTCMonth(value.getUTCMonth() + 1);
      cursor = value.toISOString().slice(0, 10);
    }
  }
  return buckets;
}

async function salesFinancials(
  db: SqlExecutor,
  fromIso: string,
  toIso: string,
): Promise<SalesFinancials> {
  const sales = (
    await db.all<{
      gross: number;
      discounts: number;
      total: number;
      cogs: number;
      count: number;
    }>(
      `SELECT COALESCE(SUM(subtotal_kobo),0) AS gross,
        COALESCE(SUM(discount_total_kobo),0) AS discounts,
        COALESCE(SUM(total_kobo),0) AS total,
        COALESCE(SUM(cogs_kobo),0) AS cogs,
        COUNT(*) AS count
      FROM sales WHERE status != 'voided' AND created_at >= ? AND created_at <= ?`,
      [fromIso, toIso],
    )
  )[0]!;
  const refunds = (
    await db.all<{ count: number; amount: number; cogs: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_reversed_kobo),0) AS amount,
        COALESCE(SUM(cogs_reversed_kobo),0) AS cogs
      FROM sale_reversals
      WHERE reversal_type = 'refund' AND created_at >= ? AND created_at <= ?`,
      [fromIso, toIso],
    )
  )[0]!;
  const netSales = Number(sales.total) - Number(refunds.amount);
  const count = Number(sales.count);
  return {
    grossSalesKobo: Number(sales.gross),
    discountsKobo: Number(sales.discounts),
    refundsKobo: Number(refunds.amount),
    netSalesRevenueKobo: netSales,
    transactionsCount: count,
    refundCount: Number(refunds.count),
    averageSaleKobo: count > 0 ? Math.round(netSales / count) : 0,
    costOfGoodsSoldKobo: Number(sales.cogs) - Number(refunds.cogs),
  };
}

async function collectionsFinancials(
  db: SqlExecutor,
  fromIso: string,
  toIso: string,
): Promise<CollectionsFinancials> {
  const saleRows = await db.all<{ method: PaymentMethod; net: number; refunds: number }>(
    `SELECT method,
      COALESCE(SUM(CASE WHEN payment_kind = 'sale_payment' THEN net_amount_kobo ELSE -net_amount_kobo END),0) AS net,
      COALESCE(SUM(CASE WHEN payment_kind = 'sale_payment' THEN 0 ELSE net_amount_kobo END),0) AS refunds
    FROM sale_payments
    WHERE method IN ('cash','bank_transfer','pos_terminal') AND created_at >= ? AND created_at <= ?
    GROUP BY method`,
    [fromIso, toIso],
  );
  const debtRows = await db.all<{ method: PaymentMethod; repaid: number }>(
    `SELECT method, COALESCE(SUM(amount_kobo),0) AS repaid
    FROM debt_payments WHERE created_at >= ? AND created_at <= ? GROUP BY method`,
    [fromIso, toIso],
  );
  const saleByMethod = { cash: 0, bank_transfer: 0, pos_terminal: 0 };
  let salesPayments = 0;
  let refundsPaid = 0;
  for (const row of saleRows) {
    saleByMethod[row.method] = Number(row.net);
    salesPayments += Number(row.net);
    refundsPaid += Number(row.refunds);
  }
  const debtByMethod = { cash: 0, bank_transfer: 0, pos_terminal: 0 };
  let debtRepayments = 0;
  for (const row of debtRows) {
    debtByMethod[row.method] = Number(row.repaid);
    debtRepayments += Number(row.repaid);
  }
  const cash = saleByMethod.cash + debtByMethod.cash;
  const bank = saleByMethod.bank_transfer + debtByMethod.bank_transfer;
  const pos = saleByMethod.pos_terminal + debtByMethod.pos_terminal;
  return {
    cashKobo: cash,
    bankTransferKobo: bank,
    posKobo: pos,
    totalReceivedKobo: cash + bank + pos,
    salesPaymentsKobo: salesPayments,
    debtRepaymentsKobo: debtRepayments,
    refundsPaidKobo: refundsPaid,
  };
}

async function purchaseFinancials(
  db: SqlExecutor,
  fromIso: string,
  toIso: string,
  from: string,
  to: string,
): Promise<PurchaseFinancials> {
  const ordered = (
    await db.all<{ count: number; total: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_kobo),0) AS total
      FROM purchase_orders WHERE status != 'cancelled' AND created_at >= ? AND created_at <= ?`,
      [fromIso, toIso],
    )
  )[0]!;
  const received = (
    await db.all<{ count: number; total: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(received_value_kobo),0) AS total
      FROM goods_receipts WHERE received_date >= ? AND received_date <= ?`,
      [from, to],
    )
  )[0]!;
  const payments = (
    await db.all<{ count: number; paid: number; reversed: number }>(
      `SELECT
        COALESCE(SUM(CASE WHEN payment_kind = 'payment' THEN 1 ELSE 0 END),0) AS count,
        COALESCE(SUM(CASE WHEN payment_kind = 'payment' THEN amount_kobo ELSE 0 END),0) AS paid,
        COALESCE(SUM(CASE WHEN payment_kind = 'reversal' THEN amount_kobo ELSE 0 END),0) AS reversed
      FROM supplier_payments WHERE paid_at >= ? AND paid_at <= ?`,
      [from, to],
    )
  )[0]!;
  const balances = await supplierBalanceSnapshot(db);
  const outstanding = balances.reduce((sum, row) => sum + row.outstandingBalanceKobo, 0);
  const outstandingInvoices = balances.reduce((sum, row) => sum + row.outstandingInvoiceCount, 0);
  return {
    totalOrderedKobo: Number(ordered.total),
    orderCount: Number(ordered.count),
    goodsReceivedKobo: Number(received.total),
    receiptCount: Number(received.count),
    paidToSuppliersKobo: Number(payments.paid),
    paymentCount: Number(payments.count),
    supplierPaymentReversalsKobo: Number(payments.reversed),
    outstandingSupplierBalanceKobo: outstanding,
    outstandingInvoiceCount: outstandingInvoices,
  };
}

async function expenseFinancials(
  db: SqlExecutor,
  from: string,
  to: string,
): Promise<ExpenseFinancials> {
  const gross = (
    await db.all<{ amount: number; count: number }>(
      `SELECT COALESCE(SUM(amount_kobo),0) AS amount, COUNT(*) AS count
      FROM expenses WHERE status IN ('recorded','reversed') AND expense_date >= ? AND expense_date <= ?`,
      [from, to],
    )
  )[0]!;
  const reversed = (
    await db.all<{ amount: number }>(
      `SELECT COALESCE(SUM(r.amount_kobo),0) AS amount
      FROM expense_reversals r JOIN expenses e ON e.id = r.expense_id
      WHERE e.expense_date >= ? AND e.expense_date <= ?`,
      [from, to],
    )
  )[0]!;
  const categoryRows = await db.all<{
    category_id: string;
    category_code: string;
    category_name: string;
    amount: number;
    count: number;
  }>(
    `SELECT e.category_id, ec.code AS category_code, e.category_name_snapshot AS category_name,
      COALESCE(SUM(e.amount_kobo),0) AS amount, COUNT(*) AS count
    FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
    WHERE e.status IN ('recorded','reversed') AND e.expense_date >= ? AND e.expense_date <= ?
    GROUP BY e.category_id, e.category_name_snapshot, ec.code
    ORDER BY amount DESC, category_name ASC`,
    [from, to],
  );
  const categoryReversals = await db.all<{ category_id: string; amount: number }>(
    `SELECT e.category_id, COALESCE(SUM(r.amount_kobo),0) AS amount
    FROM expense_reversals r JOIN expenses e ON e.id = r.expense_id
    WHERE e.expense_date >= ? AND e.expense_date <= ? GROUP BY e.category_id`,
    [from, to],
  );
  const reversalByCategory = new Map(
    categoryReversals.map((row) => [row.category_id, Number(row.amount)]),
  );
  const byCategory: ExpenseCategoryBreakdown[] = categoryRows.map((row) => ({
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    amountKobo: Number(row.amount) - (reversalByCategory.get(row.category_id) ?? 0),
    count: Number(row.count),
  }));

  const dateRows = await db.all<{ date: string; amount: number; count: number }>(
    `SELECT expense_date AS date, COALESCE(SUM(amount_kobo),0) AS amount, COUNT(*) AS count
    FROM expenses WHERE status IN ('recorded','reversed') AND expense_date >= ? AND expense_date <= ?
    GROUP BY expense_date ORDER BY expense_date ASC`,
    [from, to],
  );
  const dateReversals = await db.all<{ date: string; amount: number }>(
    `SELECT e.expense_date AS date, COALESCE(SUM(r.amount_kobo),0) AS amount
    FROM expense_reversals r JOIN expenses e ON e.id = r.expense_id
    WHERE e.expense_date >= ? AND e.expense_date <= ? GROUP BY e.expense_date`,
    [from, to],
  );
  const reversalByDate = new Map(dateReversals.map((row) => [row.date, Number(row.amount)]));
  const byDate: ExpenseDatePoint[] = dateRows.map((row) => ({
    date: row.date,
    amountKobo: Number(row.amount) - (reversalByDate.get(row.date) ?? 0),
    count: Number(row.count),
  }));

  return {
    recordedGrossKobo: Number(gross.amount),
    reversedKobo: Number(reversed.amount),
    netKobo: Number(gross.amount) - Number(reversed.amount),
    expenseCount: Number(gross.count),
    byCategory,
    byDate,
  };
}

async function cogsRows(db: SqlExecutor, fromIso: string, toIso: string): Promise<CogsRow[]> {
  const sold = await db.all<{
    product_id: string;
    product_name: string;
    base_unit_symbol: string;
    base_quantity: number;
    revenue: number;
    cogs: number;
  }>(
    `SELECT si.product_id, si.product_name_snapshot AS product_name,
      u.symbol AS base_unit_symbol,
      COALESCE(SUM(si.base_quantity),0) AS base_quantity,
      COALESCE(SUM(si.net_total_kobo),0) AS revenue,
      COALESCE(SUM(si.cogs_kobo),0) AS cogs
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    JOIN units u ON u.id = p.base_unit_id
    WHERE s.status != 'voided' AND s.created_at >= ? AND s.created_at <= ?
    GROUP BY si.product_id, si.product_name_snapshot, u.symbol`,
    [fromIso, toIso],
  );
  const refunded = await db.all<{
    product_id: string;
    base_quantity: number;
    amount: number;
    cogs: number;
  }>(
    `SELECT sri.product_id,
      COALESCE(SUM(sri.base_quantity),0) AS base_quantity,
      COALESCE(SUM(sri.amount_kobo),0) AS amount,
      COALESCE(SUM(sri.cogs_reversed_kobo),0) AS cogs
    FROM sale_reversal_items sri
    JOIN sale_reversals sr ON sr.id = sri.reversal_id
    WHERE sr.reversal_type = 'refund' AND sr.created_at >= ? AND sr.created_at <= ?
    GROUP BY sri.product_id`,
    [fromIso, toIso],
  );
  const refundByProduct = new Map(refunded.map((row) => [row.product_id, row]));
  const rows = sold.map((row) => {
    const refund = refundByProduct.get(row.product_id);
    refundByProduct.delete(row.product_id);
    const quantity = Number(row.base_quantity) - Number(refund?.base_quantity ?? 0);
    const revenue = Number(row.revenue) - Number(refund?.amount ?? 0);
    const cogs = Number(row.cogs) - Number(refund?.cogs ?? 0);
    return {
      productId: row.product_id,
      productName: row.product_name,
      baseUnitSymbol: row.base_unit_symbol,
      baseQuantitySold: quantity,
      revenueKobo: revenue,
      cogsKobo: cogs,
      grossProfitKobo: revenue - cogs,
    } satisfies CogsRow;
  });
  // A refund can relate to a sale from an earlier period; keep the product visible.
  for (const refund of refundByProduct.values()) {
    rows.push({
      productId: refund.product_id,
      productName: 'Prior-period sale refund',
      baseUnitSymbol: 'unit',
      baseQuantitySold: -Number(refund.base_quantity),
      revenueKobo: -Number(refund.amount),
      cogsKobo: -Number(refund.cogs),
      grossProfitKobo: -Number(refund.amount) + Number(refund.cogs),
    });
  }
  return rows.sort((a, b) => b.revenueKobo - a.revenueKobo);
}

async function salesTrend(
  db: SqlExecutor,
  from: string,
  to: string,
  period: FinancialReportPeriod,
  fromIso: string,
  toIso: string,
) {
  const buckets = trendBuckets(from, to, period);
  const keyExpr = trendKeyExpression(period, 'created_at');
  const sales = await db.all<{
    key: string;
    count: number;
    gross: number;
    discounts: number;
    total: number;
    cogs: number;
  }>(
    `SELECT ${keyExpr} AS key, COUNT(*) AS count,
      COALESCE(SUM(subtotal_kobo),0) AS gross,
      COALESCE(SUM(discount_total_kobo),0) AS discounts,
      COALESCE(SUM(total_kobo),0) AS total,
      COALESCE(SUM(cogs_kobo),0) AS cogs
    FROM sales WHERE status != 'voided' AND created_at >= ? AND created_at <= ?
    GROUP BY key ORDER BY key`,
    [fromIso, toIso],
  );
  const refundKeyExpr = trendKeyExpression(period, 'created_at');
  const refunds = await db.all<{ key: string; amount: number; cogs: number }>(
    `SELECT ${refundKeyExpr} AS key,
      COALESCE(SUM(total_reversed_kobo),0) AS amount,
      COALESCE(SUM(cogs_reversed_kobo),0) AS cogs
    FROM sale_reversals WHERE reversal_type = 'refund' AND created_at >= ? AND created_at <= ?
    GROUP BY key ORDER BY key`,
    [fromIso, toIso],
  );
  const saleMoney = await db.all<{ key: string; amount: number }>(
    `SELECT ${trendKeyExpression(period, 'created_at')} AS key,
      COALESCE(SUM(CASE WHEN payment_kind = 'sale_payment' THEN net_amount_kobo ELSE -net_amount_kobo END),0) AS amount
    FROM sale_payments WHERE method IN ('cash','bank_transfer','pos_terminal')
      AND created_at >= ? AND created_at <= ? GROUP BY key`,
    [fromIso, toIso],
  );
  const debtMoney = await db.all<{ key: string; amount: number }>(
    `SELECT ${trendKeyExpression(period, 'created_at')} AS key,
      COALESCE(SUM(amount_kobo),0) AS amount
    FROM debt_payments WHERE created_at >= ? AND created_at <= ? GROUP BY key`,
    [fromIso, toIso],
  );
  const salesByKey = new Map(sales.map((row) => [row.key, row]));
  const refundsByKey = new Map(refunds.map((row) => [row.key, row]));
  const moneyByKey = new Map<string, number>();
  for (const row of [...saleMoney, ...debtMoney])
    moneyByKey.set(row.key, (moneyByKey.get(row.key) ?? 0) + Number(row.amount));

  return buckets.map((bucket) => {
    const sale = salesByKey.get(bucket.key);
    const refund = refundsByKey.get(bucket.key);
    const gross = Number(sale?.gross ?? 0);
    const discounts = Number(sale?.discounts ?? 0);
    const refundsKobo = Number(refund?.amount ?? 0);
    const net = gross - discounts - refundsKobo;
    const cogs = Number(sale?.cogs ?? 0) - Number(refund?.cogs ?? 0);
    return {
      period: bucket.key,
      label: bucket.label,
      transactionsCount: Number(sale?.count ?? 0),
      grossSalesKobo: gross,
      discountsKobo: discounts,
      refundsKobo: refundsKobo,
      netSalesRevenueKobo: net,
      moneyReceivedKobo: moneyByKey.get(bucket.key) ?? 0,
      costOfGoodsSoldKobo: cogs,
      grossProfitKobo: net - cogs,
    };
  });
}

async function purchaseReportRows(
  db: SqlExecutor,
  fromIso: string,
  toIso: string,
): Promise<PurchaseReportRow[]> {
  const rows = await db.all<PurchaseOrderRow>(
    `${purchaseOrderSelect}
    WHERE po.created_at >= ? AND po.created_at <= ?
    ORDER BY po.created_at DESC, po.id DESC LIMIT 500`,
    [fromIso, toIso],
  );
  return rows.map((row) => {
    const mapped = mapPurchaseOrderSummary(row);
    return {
      id: mapped.id,
      referenceNumber: mapped.referenceNumber,
      supplierId: mapped.supplierId,
      supplierName: mapped.supplierName,
      status: mapped.status,
      orderDate: mapped.createdAt.slice(0, 10),
      totalKobo: mapped.totalKobo,
      receivedValueKobo: mapped.receivedValueKobo,
      paidKobo: mapped.paidKobo,
      outstandingKobo: mapped.outstandingKobo,
    };
  });
}

async function supplierPaymentReportRows(
  db: SqlExecutor,
  from: string,
  to: string,
): Promise<SupplierPaymentReportRow[]> {
  const rows = await db.all<{
    id: string;
    payment_number: string;
    supplier_name: string;
    payment_kind: SupplierPaymentReportRow['paymentKind'];
    method: PaymentMethod;
    amount_kobo: number;
    paid_at: string;
    reference: string | null;
    invoice_count: number;
  }>(
    `SELECT sp.id, sp.payment_number, s.name AS supplier_name, sp.payment_kind, sp.method,
      sp.amount_kobo, sp.paid_at, sp.reference,
      (SELECT COUNT(*) FROM supplier_payment_allocations a WHERE a.payment_id = sp.id) AS invoice_count
    FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id
    WHERE sp.paid_at >= ? AND sp.paid_at <= ?
    ORDER BY sp.paid_at DESC, sp.created_at DESC, sp.id DESC LIMIT 500`,
    [from, to],
  );
  return rows.map((row) => ({
    id: row.id,
    paymentNumber: row.payment_number,
    supplierName: row.supplier_name,
    paymentKind: row.payment_kind,
    method: row.method,
    amountKobo: Number(row.amount_kobo),
    paidAt: row.paid_at,
    reference: row.reference,
    invoiceCount: Number(row.invoice_count),
  }));
}

async function cashMovement(
  db: SqlExecutor,
  from: string,
  to: string,
  options: { salesOnly?: boolean } = {},
): Promise<CashMovementReport> {
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const rows: CashMovementRow[] = [];
  const salePayments = await db.all<{
    id: string;
    created_at: string;
    payment_kind: 'sale_payment' | 'void_reversal' | 'refund_payout';
    method: PaymentMethod;
    net_amount_kobo: number;
    reference: string | null;
    receipt_number: string;
    sale_id: string;
  }>(
    `SELECT sp.id, sp.created_at, sp.payment_kind, sp.method, sp.net_amount_kobo, sp.reference,
      s.receipt_number, s.id AS sale_id
    FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
    WHERE sp.method IN ('cash','bank_transfer','pos_terminal')
      AND sp.created_at >= ? AND sp.created_at <= ?`,
    [fromIso, toIso],
  );
  for (const row of salePayments) {
    const isInflow = row.payment_kind === 'sale_payment';
    const amount = Number(row.net_amount_kobo);
    rows.push({
      id: row.id,
      occurredAt: row.created_at,
      date: row.created_at.slice(0, 10),
      type: isInflow ? 'sale_payment' : 'sale_refund',
      direction: isInflow ? 'in' : 'out',
      method: row.method,
      amountKobo: amount,
      signedAmountKobo: isInflow ? amount : -amount,
      reference: row.reference,
      description:
        row.payment_kind === 'sale_payment'
          ? 'Sale payment received'
          : row.payment_kind === 'void_reversal'
            ? 'Voided sale money returned'
            : 'Refund paid to customer',
      entityId: row.sale_id,
      entityReference: row.receipt_number,
      isCashDrawer: row.method === 'cash',
    });
  }
  const debtPayments = await db.all<{
    id: string;
    created_at: string;
    amount_kobo: number;
    method: PaymentMethod;
    reference: string | null;
    receipt_number: string;
    debt_id: string;
    customer_name: string;
  }>(
    `SELECT dp.id, dp.created_at, dp.amount_kobo, dp.method, dp.reference, dp.receipt_number,
      dp.debt_id, c.full_name AS customer_name
    FROM debt_payments dp JOIN customers c ON c.id = dp.customer_id
    WHERE dp.created_at >= ? AND dp.created_at <= ?`,
    [fromIso, toIso],
  );
  for (const row of debtPayments) {
    const amount = Number(row.amount_kobo);
    rows.push({
      id: row.id,
      occurredAt: row.created_at,
      date: row.created_at.slice(0, 10),
      type: 'debt_repayment',
      direction: 'in',
      method: row.method,
      amountKobo: amount,
      signedAmountKobo: amount,
      reference: row.reference,
      description: `Debt repayment · ${row.customer_name}`,
      entityId: row.debt_id,
      entityReference: row.receipt_number,
      isCashDrawer: row.method === 'cash',
    });
  }
  if (!options.salesOnly) {
    const supplierPayments = await db.all<{
      id: string;
      created_at: string;
      paid_at: string;
      payment_number: string;
      payment_kind: 'payment' | 'reversal';
      method: PaymentMethod;
      amount_kobo: number;
      reference: string | null;
      supplier_name: string;
    }>(
      `SELECT sp.id, sp.created_at, sp.paid_at, sp.payment_number, sp.payment_kind, sp.method,
        sp.amount_kobo, sp.reference, s.name AS supplier_name
      FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.paid_at >= ? AND sp.paid_at <= ?`,
      [from, to],
    );
    for (const row of supplierPayments) {
      const inflow = row.payment_kind === 'reversal';
      const amount = Number(row.amount_kobo);
      rows.push({
        id: row.id,
        occurredAt: `${row.paid_at}T12:00:00.000Z`,
        date: row.paid_at,
        type: inflow ? 'supplier_payment_reversal' : 'supplier_payment',
        direction: inflow ? 'in' : 'out',
        method: row.method,
        amountKobo: amount,
        signedAmountKobo: inflow ? amount : -amount,
        reference: row.reference,
        description: `${inflow ? 'Supplier payment reversed' : 'Supplier payment'} · ${row.supplier_name}`,
        entityId: row.id,
        entityReference: row.payment_number,
        isCashDrawer: row.method === 'cash',
      });
    }
    const expenses = await db.all<{
      id: string;
      expense_date: string;
      recorded_at: string | null;
      created_at: string;
      expense_number: string;
      description: string;
      payee: string | null;
      payment_method: PaymentMethod;
      amount_kobo: number;
      reference: string | null;
      status: 'recorded' | 'reversed';
    }>(
      `SELECT e.id, e.expense_date, e.recorded_at, e.created_at, e.expense_number, e.description,
        e.payee, e.payment_method, e.amount_kobo, e.reference, e.status
      FROM expenses e
      WHERE e.status IN ('recorded','reversed') AND e.expense_date >= ? AND e.expense_date <= ?`,
      [from, to],
    );
    for (const row of expenses) {
      const amount = Number(row.amount_kobo);
      rows.push({
        id: row.id,
        occurredAt: row.recorded_at ?? row.created_at,
        date: row.expense_date,
        type: 'expense',
        direction: 'out',
        method: row.payment_method,
        amountKobo: amount,
        signedAmountKobo: -amount,
        reference: row.reference,
        description: `Expense · ${row.description}${row.payee ? ` · ${row.payee}` : ''}`,
        entityId: row.id,
        entityReference: row.expense_number,
        isCashDrawer: row.payment_method === 'cash',
      });
    }
    const expenseReversals = await db.all<{
      id: string;
      created_at: string;
      expense_number: string;
      description: string;
      payment_method: PaymentMethod;
      amount_kobo: number;
    }>(
      `SELECT r.id, r.created_at, e.expense_number, e.description,
        e.payment_method, r.amount_kobo
      FROM expense_reversals r JOIN expenses e ON e.id = r.expense_id
      WHERE r.created_at >= ? AND r.created_at <= ?`,
      [fromIso, toIso],
    );
    for (const row of expenseReversals) {
      const amount = Number(row.amount_kobo);
      rows.push({
        id: row.id,
        occurredAt: row.created_at,
        date: row.created_at.slice(0, 10),
        type: 'expense_reversal',
        direction: 'in',
        method: row.payment_method,
        amountKobo: amount,
        signedAmountKobo: amount,
        reference: null,
        description: `Expense reversed · ${row.description}`,
        entityId: row.id,
        entityReference: row.expense_number,
        isCashDrawer: row.payment_method === 'cash',
      });
    }
  }
  rows.sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1,
  );
  const methods: PaymentMethod[] = ['cash', 'bank_transfer', 'pos_terminal'];
  const byMethod: CashMovementMethodTotal[] = methods.map((method) => {
    const methodRows = rows.filter((row) => row.method === method);
    const inflow = methodRows
      .filter((row) => row.direction === 'in')
      .reduce((sum, row) => sum + row.amountKobo, 0);
    const outflow = methodRows
      .filter((row) => row.direction === 'out')
      .reduce((sum, row) => sum + row.amountKobo, 0);
    return {
      method,
      inflowKobo: inflow,
      outflowKobo: outflow,
      netKobo: inflow - outflow,
      cashDrawer: method === 'cash',
    };
  });
  const inflow = byMethod.reduce((sum, row) => sum + row.inflowKobo, 0);
  const outflow = byMethod.reduce((sum, row) => sum + row.outflowKobo, 0);
  return {
    from,
    to,
    rows,
    byMethod,
    inflowKobo: inflow,
    outflowKobo: outflow,
    netKobo: inflow - outflow,
    cashNetKobo: byMethod.find((row) => row.method === 'cash')?.netKobo ?? 0,
    note: options.salesOnly
      ? 'Sales-side money movement only. Unpaid credit sales are not cash. No opening cash balance is assumed.'
      : 'Actual money movement only. Credit sales, unpaid supplier invoices and ordered goods are never counted as cash. No opening cash balance is assumed, so this is movement rather than a cash balance.',
  };
}

export async function buildFinancialReport(
  db: SqlExecutor,
  query: { from?: string; to?: string; period?: FinancialReportPeriod },
): Promise<FinancialReport> {
  const { from, to } = reportWindow(query);
  const period = query.period ?? 'daily';
  const { fromIso, toIso } = dateRangeIso(from, to);
  const [
    sales,
    collections,
    purchases,
    expenses,
    valuation,
    cogs,
    trend,
    purchaseRows,
    paymentRows,
    supplierBalances,
    cash,
    expenseRows,
  ] = await Promise.all([
    salesFinancials(db, fromIso, toIso),
    collectionsFinancials(db, fromIso, toIso),
    purchaseFinancials(db, fromIso, toIso, from, to),
    expenseFinancials(db, from, to),
    inventoryValuation(db),
    cogsRows(db, fromIso, toIso),
    salesTrend(db, from, to, period, fromIso, toIso),
    purchaseReportRows(db, fromIso, toIso),
    supplierPaymentReportRows(db, from, to),
    supplierBalanceSnapshot(db),
    cashMovement(db, from, to),
    db.all<ExpenseRow>(
      `${expenseSelect}
      WHERE e.expense_date >= ? AND e.expense_date <= ?
      ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 500`,
      [from, to],
    ),
  ]);
  const inventory: InventoryFinancials = {
    stockValueCostKobo: valuation.totalCostKobo,
    stockValueRetailKobo: valuation.totalRetailKobo,
    stockUnits: valuation.totalUnits,
    costOfGoodsSoldKobo: sales.costOfGoodsSoldKobo,
  };
  const profitability: ProfitFinancials = {
    netSalesRevenueKobo: sales.netSalesRevenueKobo,
    costOfGoodsSoldKobo: sales.costOfGoodsSoldKobo,
    grossProfitKobo: sales.netSalesRevenueKobo - sales.costOfGoodsSoldKobo,
    operatingExpensesKobo: expenses.netKobo,
    operatingProfitKobo: sales.netSalesRevenueKobo - sales.costOfGoodsSoldKobo - expenses.netKobo,
  };
  return {
    from,
    to,
    period,
    generatedAt: new Date().toISOString(),
    sales,
    collections,
    purchases,
    expenses,
    inventory,
    profitability,
    salesTrend: trend,
    topProducts: cogs.slice(0, 10),
    purchaseRows,
    supplierPaymentRows: paymentRows,
    supplierBalances,
    expenseRows: expenseRows.map(mapExpense),
    inventoryValuation: valuation,
    cogsRows: cogs,
    cashMovement: cash,
  };
}

export async function financialDashboard(
  db: SqlExecutor,
  query: { from?: string; to?: string },
): Promise<FinancialDashboardSummary> {
  const report = await buildFinancialReport(db, query);
  return {
    from: report.from,
    to: report.to,
    sales: report.sales,
    collections: report.collections,
    purchases: report.purchases,
    expenses: report.expenses,
    inventory: report.inventory,
    profitability: report.profitability,
  };
}

export async function cashRegisterSummary(
  db: SqlExecutor,
  query: { from?: string; to?: string },
): Promise<CashRegisterSummary> {
  const { from, to } = reportWindow(query);
  const cash = await cashMovement(db, from, to, { salesOnly: true });
  return {
    from,
    to,
    rows: cash.rows,
    byMethod: cash.byMethod,
    inflowKobo: cash.inflowKobo,
    outflowKobo: cash.outflowKobo,
    netKobo: cash.netKobo,
    cashNetKobo: cash.cashNetKobo,
    note: cash.note,
  };
}

function exportRows(
  report: FinancialReport,
  kind: FinancialReportKind,
): { headers: string[]; rows: Array<Array<string | number | null>> } {
  const kobo = (value: number) => value;
  switch (kind) {
    case 'sales':
      return {
        headers: [
          'period',
          'label',
          'transactions',
          'gross_sales_kobo',
          'discounts_kobo',
          'refunds_kobo',
          'net_sales_revenue_kobo',
          'money_received_kobo',
          'cost_of_goods_sold_kobo',
          'gross_profit_kobo',
        ],
        rows: report.salesTrend.map((row) => [
          row.period,
          row.label,
          row.transactionsCount,
          kobo(row.grossSalesKobo),
          kobo(row.discountsKobo),
          kobo(row.refundsKobo),
          kobo(row.netSalesRevenueKobo),
          kobo(row.moneyReceivedKobo),
          kobo(row.costOfGoodsSoldKobo),
          kobo(row.grossProfitKobo),
        ]),
      };
    case 'purchases':
      return {
        headers: [
          'reference',
          'order_date',
          'supplier',
          'status',
          'order_total_kobo',
          'goods_received_kobo',
          'paid_kobo',
          'outstanding_kobo',
        ],
        rows: report.purchaseRows.map((row) => [
          row.referenceNumber,
          row.orderDate,
          row.supplierName,
          row.status,
          kobo(row.totalKobo),
          kobo(row.receivedValueKobo),
          kobo(row.paidKobo),
          kobo(row.outstandingKobo),
        ]),
      };
    case 'supplier_payments':
      return {
        headers: [
          'payment_number',
          'paid_at',
          'supplier',
          'kind',
          'method',
          'amount_kobo',
          'reference',
          'invoices',
        ],
        rows: report.supplierPaymentRows.map((row) => [
          row.paymentNumber,
          row.paidAt,
          row.supplierName,
          row.paymentKind,
          row.method,
          kobo(row.amountKobo),
          row.reference,
          row.invoiceCount,
        ]),
      };
    case 'outstanding_suppliers':
      return {
        headers: [
          'supplier',
          'contact',
          'phone',
          'goods_received_kobo',
          'net_paid_kobo',
          'outstanding_kobo',
          'open_invoices',
          'last_receipt',
        ],
        rows: report.supplierBalances.map((row) => [
          row.supplierName,
          row.contactPerson,
          row.phone,
          kobo(row.totalGoodsReceivedKobo),
          kobo(row.netPaidKobo),
          kobo(row.outstandingBalanceKobo),
          row.outstandingInvoiceCount,
          row.lastReceiptDate,
        ]),
      };
    case 'expenses':
      return {
        headers: [
          'expense_number',
          'expense_date',
          'category',
          'description',
          'payee',
          'method',
          'status',
          'amount_kobo',
        ],
        rows: report.expenseRows.map((row) => [
          row.expenseNumber,
          row.expenseDate,
          row.categoryName,
          row.description,
          row.payee,
          row.paymentMethod,
          row.status,
          kobo(row.amountKobo),
        ]),
      };
    case 'expense_categories':
      return {
        headers: ['category', 'code', 'expenses', 'net_amount_kobo'],
        rows: report.expenses.byCategory.map((row) => [
          row.categoryName,
          row.categoryCode,
          row.count,
          kobo(row.amountKobo),
        ]),
      };
    case 'inventory_valuation':
      return {
        headers: [
          'product',
          'sku',
          'unit',
          'quantity',
          'batch_tracked',
          'cost_value_kobo',
          'retail_value_kobo',
        ],
        rows: report.inventoryValuation.rows.map((row) => [
          row.productName,
          row.sku,
          row.baseUnitSymbol,
          row.stockQuantity,
          row.batchTracked ? 'yes' : 'no',
          kobo(row.costValueKobo),
          kobo(row.retailValueKobo),
        ]),
      };
    case 'cost_of_goods_sold':
      return {
        headers: [
          'product',
          'unit',
          'quantity_sold',
          'revenue_kobo',
          'cogs_kobo',
          'gross_profit_kobo',
        ],
        rows: report.cogsRows.map((row) => [
          row.productName,
          row.baseUnitSymbol,
          row.baseQuantitySold,
          kobo(row.revenueKobo),
          kobo(row.cogsKobo),
          kobo(row.grossProfitKobo),
        ]),
      };
    case 'gross_profit':
      return {
        headers: ['metric', 'amount_kobo'],
        rows: [
          ['net_sales_revenue', kobo(report.profitability.netSalesRevenueKobo)],
          ['cost_of_goods_sold', kobo(report.profitability.costOfGoodsSoldKobo)],
          ['gross_profit', kobo(report.profitability.grossProfitKobo)],
        ],
      };
    case 'operating_profit':
      return {
        headers: ['metric', 'amount_kobo'],
        rows: [
          ['net_sales_revenue', kobo(report.profitability.netSalesRevenueKobo)],
          ['cost_of_goods_sold', kobo(report.profitability.costOfGoodsSoldKobo)],
          ['gross_profit', kobo(report.profitability.grossProfitKobo)],
          ['operating_expenses', kobo(report.profitability.operatingExpensesKobo)],
          ['operating_profit', kobo(report.profitability.operatingProfitKobo)],
        ],
      };
    case 'cash_movement':
      return {
        headers: [
          'date',
          'type',
          'direction',
          'method',
          'amount_kobo',
          'signed_amount_kobo',
          'reference',
          'description',
        ],
        rows: report.cashMovement.rows.map((row) => [
          row.date,
          row.type,
          row.direction,
          row.method,
          kobo(row.amountKobo),
          kobo(row.signedAmountKobo),
          row.reference,
          row.description,
        ]),
      };
  }
}

export async function exportFinancialReport(
  db: SqlExecutor,
  kind: FinancialReportKind,
  query: { from?: string; to?: string; period?: FinancialReportPeriod },
): Promise<FinancialExport> {
  const report = await buildFinancialReport(db, query);
  const { headers, rows } = exportRows(report, kind);
  return {
    report: kind,
    filename: `${financialReportLabels[kind]
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '_')}_${report.from}_${report.to}.csv`,
    contentType: 'text/csv; charset=utf-8',
    from: report.from,
    to: report.to,
    rowCount: rows.length,
    csv: buildCsv(headers, rows),
  };
}

/** Used by the dashboard when only today's summary is needed. */
export const todayRange = () => ({ from: todayIso(), to: todayIso() });
