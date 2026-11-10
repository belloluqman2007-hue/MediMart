import type { SqlExecutor } from '@medimart/database';
import type {
  Paginated,
  PaymentMethod,
  PurchaseOrderSummary,
  SupplierAccountDetail,
  SupplierAccountSummary,
  SupplierBalanceRow,
  SupplierPaymentSummary,
  SupplierStatement,
  SupplierStatementEntry,
} from '@medimart/shared';
import { likePattern, paginate, todayIso } from '../inventory/common';
import { listPurchases } from './purchases';
import { listGoodsReceipts } from './receiving';
import { listSupplierPayments } from './supplierPayments';
import { loadSupplier } from './common';
import { listSupplierInvoices } from './invoices';

type AccountTotalsRow = {
  total_purchase_orders: number;
  total_ordered_value: number;
  open_purchase_order_count: number;
  total_goods_received: number;
  total_paid: number;
  total_reversed: number;
  last_receipt_date: string | null;
  last_payment_at: string | null;
};

async function accountTotals(db: SqlExecutor, supplierId: string) {
  return (
    await db.all<AccountTotalsRow>(
      `SELECT
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = ? AND po.status != 'cancelled') AS total_purchase_orders,
        COALESCE((SELECT SUM(po.total_kobo) FROM purchase_orders po WHERE po.supplier_id = ? AND po.status != 'cancelled'), 0) AS total_ordered_value,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = ? AND po.status IN ('draft','ordered','partially_received')) AS open_purchase_order_count,
        COALESCE((
          SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri
          JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
          WHERE gr.supplier_id = ?
        ), 0) AS total_goods_received,
        COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = ? AND sp.payment_kind = 'payment'), 0) AS total_paid,
        COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = ? AND sp.payment_kind = 'reversal'), 0) AS total_reversed,
        (SELECT MAX(gr.received_date) FROM goods_receipts gr WHERE gr.supplier_id = ?) AS last_receipt_date,
        (SELECT MAX(sp.paid_at) FROM supplier_payments sp WHERE sp.supplier_id = ? AND sp.payment_kind = 'payment') AS last_payment_at`,
      [
        supplierId,
        supplierId,
        supplierId,
        supplierId,
        supplierId,
        supplierId,
        supplierId,
        supplierId,
      ],
    )
  )[0]!;
}

function mapAccount(
  supplier: Awaited<ReturnType<typeof loadSupplier>>,
  totals: AccountTotalsRow,
  outstandingInvoiceCount: number,
): SupplierAccountSummary {
  const received = Number(totals.total_goods_received);
  const paid = Number(totals.total_paid);
  const reversed = Number(totals.total_reversed);
  const netPaid = paid - reversed;
  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    contactPerson: supplier.contact_person,
    phone: supplier.phone,
    email: supplier.email,
    status: supplier.status,
    totalPurchaseOrders: Number(totals.total_purchase_orders),
    totalOrderedValueKobo: Number(totals.total_ordered_value),
    openPurchaseOrderCount: Number(totals.open_purchase_order_count),
    totalGoodsReceivedKobo: received,
    totalPaidKobo: paid,
    totalPaymentReversalsKobo: reversed,
    netPaidKobo: netPaid,
    outstandingBalanceKobo: Math.max(0, received - netPaid),
    outstandingInvoiceCount,
    lastReceiptDate: totals.last_receipt_date,
    lastPaymentAt: totals.last_payment_at,
  };
}

export async function getSupplierAccountSummary(
  db: SqlExecutor,
  supplierId: string,
): Promise<SupplierAccountSummary> {
  const supplier = await loadSupplier(db, supplierId);
  const [totals, invoices] = await Promise.all([
    accountTotals(db, supplierId),
    listSupplierInvoices(db, supplierId, true),
  ]);
  return mapAccount(supplier, totals, invoices.length);
}

type StatementRow = {
  id: string;
  date: string;
  created_at: string;
  type: SupplierStatementEntry['type'];
  reference: string;
  description: string;
  debit_kobo: number;
  credit_kobo: number;
  method: PaymentMethod | null;
};

async function statementEntries(db: SqlExecutor, supplierId: string, from: string, to: string) {
  return db.all<StatementRow>(
    `SELECT gr.id, gr.received_date AS date, gr.created_at, 'goods_received' AS type,
      gr.receipt_number AS reference,
      'Goods received · ' || po.reference_number AS description,
      gr.received_value_kobo AS debit_kobo, 0 AS credit_kobo, NULL AS method
    FROM goods_receipts gr JOIN purchase_orders po ON po.id = gr.purchase_order_id
    WHERE gr.supplier_id = ? AND gr.received_date >= ? AND gr.received_date <= ?
    UNION ALL
    SELECT sp.id, sp.paid_at AS date, sp.created_at,
      CASE WHEN sp.payment_kind = 'reversal' THEN 'payment_reversal' ELSE 'payment' END AS type,
      sp.payment_number AS reference,
      CASE WHEN sp.payment_kind = 'reversal' THEN 'Payment reversed' ELSE 'Supplier payment' END AS description,
      CASE WHEN sp.payment_kind = 'reversal' THEN sp.amount_kobo ELSE 0 END AS debit_kobo,
      CASE WHEN sp.payment_kind = 'payment' THEN sp.amount_kobo ELSE 0 END AS credit_kobo,
      sp.method
    FROM supplier_payments sp
    WHERE sp.supplier_id = ? AND sp.paid_at >= ? AND sp.paid_at <= ?
    ORDER BY date ASC, created_at ASC, id ASC`,
    [supplierId, from, to, supplierId, from, to],
  );
}

async function openingBalance(db: SqlExecutor, supplierId: string, from: string) {
  const row = (
    await db.all<{ received: number; paid: number; reversed: number }>(
      `SELECT
        COALESCE((SELECT SUM(gr.received_value_kobo) FROM goods_receipts gr
          WHERE gr.supplier_id = ? AND gr.received_date < ?), 0) AS received,
        COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp
          WHERE sp.supplier_id = ? AND sp.payment_kind = 'payment' AND sp.paid_at < ?), 0) AS paid,
        COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp
          WHERE sp.supplier_id = ? AND sp.payment_kind = 'reversal' AND sp.paid_at < ?), 0) AS reversed`,
      [supplierId, from, supplierId, from, supplierId, from],
    )
  )[0]!;
  return Number(row.received) - (Number(row.paid) - Number(row.reversed));
}

export async function getSupplierStatement(
  db: SqlExecutor,
  supplierId: string,
  query: { from?: string; to?: string },
): Promise<SupplierStatement> {
  const supplier = await loadSupplier(db, supplierId);
  const to = query.to ?? todayIso();
  const from = query.from ?? `${to.slice(0, 7)}-01`;
  const [opening, rows] = await Promise.all([
    openingBalance(db, supplierId, from),
    statementEntries(db, supplierId, from, to),
  ]);
  let running = opening;
  let totalDebits = 0;
  let totalCredits = 0;
  const entries: SupplierStatementEntry[] = rows.map((row) => {
    const debit = Number(row.debit_kobo);
    const credit = Number(row.credit_kobo);
    running += debit - credit;
    totalDebits += debit;
    totalCredits += credit;
    return {
      id: row.id,
      date: row.date,
      type: row.type,
      reference: row.reference,
      description: row.description,
      debitKobo: debit,
      creditKobo: credit,
      runningBalanceKobo: running,
      method: row.method,
    };
  });
  return {
    supplierId,
    supplierName: supplier.name,
    from,
    to,
    openingBalanceKobo: opening,
    closingBalanceKobo: running,
    totalDebitsKobo: totalDebits,
    totalCreditsKobo: totalCredits,
    entries,
  };
}

export async function getSupplierAccountDetail(
  db: SqlExecutor,
  supplierId: string,
  query: { from?: string; to?: string },
): Promise<SupplierAccountDetail> {
  const [summary, invoices, purchases, receipts, payments, statement] = await Promise.all([
    getSupplierAccountSummary(db, supplierId),
    listSupplierInvoices(db, supplierId, true),
    listPurchases(db, { supplierId, page: 1, pageSize: 10 }),
    listGoodsReceipts(db, { supplierId, page: 1, pageSize: 10 }),
    listSupplierPayments(db, { supplierId, page: 1, pageSize: 10 }),
    getSupplierStatement(db, supplierId, query),
  ]);
  return {
    ...summary,
    outstandingInvoices: invoices,
    recentPurchases: purchases.items as PurchaseOrderSummary[],
    recentReceipts: receipts.items,
    recentPayments: payments.items as SupplierPaymentSummary[],
    statement,
  };
}

type BalanceRow = {
  supplier_id: string;
  supplier_name: string;
  contact_person: string | null;
  phone: string | null;
  status: SupplierBalanceRow['status'];
  total_goods_received: number;
  net_paid: number;
  outstanding_kobo: number;
  outstanding_invoice_count: number;
  last_receipt_date: string | null;
};

function mapBalanceRow(row: BalanceRow): SupplierBalanceRow {
  return {
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    contactPerson: row.contact_person,
    phone: row.phone,
    status: row.status,
    totalGoodsReceivedKobo: Number(row.total_goods_received),
    netPaidKobo: Number(row.net_paid),
    outstandingBalanceKobo: Math.max(0, Number(row.outstanding_kobo)),
    outstandingInvoiceCount: Number(row.outstanding_invoice_count),
    lastReceiptDate: row.last_receipt_date,
  };
}

/** A complete, unpaginated supplier balance snapshot for financial reports. */
export async function supplierBalanceSnapshot(
  db: SqlExecutor,
  options: { search?: string } = {},
): Promise<SupplierBalanceRow[]> {
  const where: string[] = ['s.deleted_at IS NULL'];
  const values: Array<string | number> = [];
  if (options.search) {
    const pattern = likePattern(options.search);
    where.push(
      "(s.name LIKE ? ESCAPE '\\' OR s.contact_person LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern, pattern);
  }
  const rows = await db.all<BalanceRow>(
    `SELECT * FROM (${supplierBalanceBaseSql(where)}) x
    ORDER BY outstanding_kobo DESC, supplier_name ASC`,
    values,
  );
  return rows.map(mapBalanceRow);
}

function supplierBalanceBaseSql(where: string[]) {
  const clause = `WHERE ${where.join(' AND ')}`;
  return `SELECT s.id AS supplier_id, s.name AS supplier_name, s.contact_person, s.phone, s.status,
    COALESCE((
      SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri
      JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id WHERE gr.supplier_id = s.id
    ), 0) AS total_goods_received,
    COALESCE((
      SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = s.id AND sp.payment_kind = 'payment'
    ), 0) - COALESCE((
      SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = s.id AND sp.payment_kind = 'reversal'
    ), 0) AS net_paid,
    COALESCE((
      SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri
      JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id WHERE gr.supplier_id = s.id
    ), 0) - (
      COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = s.id AND sp.payment_kind = 'payment'), 0)
      - COALESCE((SELECT SUM(sp.amount_kobo) FROM supplier_payments sp WHERE sp.supplier_id = s.id AND sp.payment_kind = 'reversal'), 0)
    ) AS outstanding_kobo,
    (
      SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND (
        COALESCE((SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id WHERE gr.purchase_order_id = po.id), 0)
        - COALESCE((SELECT SUM(CASE WHEN a.direction = 'apply' THEN a.amount_kobo ELSE -a.amount_kobo END) FROM supplier_payment_allocations a WHERE a.purchase_order_id = po.id), 0)
      ) > 0
    ) AS outstanding_invoice_count,
    (SELECT MAX(gr.received_date) FROM goods_receipts gr WHERE gr.supplier_id = s.id) AS last_receipt_date
    FROM suppliers s ${clause}`;
}

export async function listSupplierBalances(
  db: SqlExecutor,
  query: { search?: string; outstandingOnly?: boolean; page: number; pageSize: number },
): Promise<Paginated<SupplierBalanceRow>> {
  const where: string[] = ['s.deleted_at IS NULL'];
  const values: Array<string | number> = [];
  if (query.search) {
    const pattern = likePattern(query.search);
    where.push(
      "(s.name LIKE ? ESCAPE '\\' OR s.contact_person LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern, pattern);
  }
  const base = supplierBalanceBaseSql(where);
  const outstandingFilter = query.outstandingOnly ? 'WHERE outstanding_kobo > 0' : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (${base}) x ${outstandingFilter}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<BalanceRow>(
    `SELECT * FROM (${base}) x ${outstandingFilter}
    ORDER BY outstanding_kobo DESC, supplier_name ASC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapBalanceRow), query.page, query.pageSize, Number(total));
}
