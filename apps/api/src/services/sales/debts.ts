import type { Database, SqlExecutor } from '@medimart/database';
import type {
  CustomerRepaymentInput,
  CustomerRepaymentResult,
  CustomerSummary,
  DebtDetail,
  DebtPaymentSummary,
  DebtRepaymentInput,
  DebtReport,
  DebtStatus,
  DebtSummary,
  Paginated,
  PaymentMethod,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, likePattern, paginate, todayIso } from '../inventory/common';
import { nextSequenceCode, operationHash, readShopSettings } from './common';

export type CustomerAggregateRow = {
  id: string;
  code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  credit_limit_kobo: number | null;
  status: CustomerSummary['status'];
  sales_count: number;
  total_purchases_kobo: number;
  total_credit_kobo: number;
  total_repaid_kobo: number;
  outstanding_balance_kobo: number;
  open_debt_count: number;
  created_at: string;
  updated_at: string;
};

export const customerSelect = `
  SELECT
    c.id, c.code, c.full_name, c.phone, c.email, c.address, c.notes, c.credit_limit_kobo, c.status,
    c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status != 'voided') AS sales_count,
    COALESCE((SELECT SUM(s.total_kobo) FROM sales s WHERE s.customer_id = c.id AND s.status != 'voided'), 0)
      - COALESCE((SELECT SUM(r.total_reversed_kobo) FROM sale_reversals r JOIN sales s ON s.id = r.sale_id WHERE s.customer_id = c.id AND r.reversal_type = 'refund'), 0) AS total_purchases_kobo,
    COALESCE((SELECT SUM(cd.original_amount_kobo - cd.amount_cancelled_kobo) FROM customer_debts cd WHERE cd.customer_id = c.id), 0) AS total_credit_kobo,
    COALESCE((SELECT SUM(cd.amount_paid_kobo) FROM customer_debts cd WHERE cd.customer_id = c.id), 0) AS total_repaid_kobo,
    COALESCE((SELECT SUM(cd.outstanding_kobo) FROM customer_debts cd WHERE cd.customer_id = c.id AND cd.status IN ('open','partial')), 0) AS outstanding_balance_kobo,
    (SELECT COUNT(*) FROM customer_debts cd WHERE cd.customer_id = c.id AND cd.status IN ('open','partial')) AS open_debt_count
  FROM customers c`;

export function mapCustomerSummary(row: CustomerAggregateRow): CustomerSummary {
  return {
    id: row.id,
    code: row.code,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    creditLimitKobo: row.credit_limit_kobo === null ? null : Number(row.credit_limit_kobo),
    status: row.status,
    salesCount: Number(row.sales_count),
    totalPurchasesKobo: Math.max(0, Number(row.total_purchases_kobo)),
    totalCreditKobo: Number(row.total_credit_kobo),
    totalRepaidKobo: Number(row.total_repaid_kobo),
    outstandingBalanceKobo: Number(row.outstanding_balance_kobo),
    openDebtCount: Number(row.open_debt_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadCustomerSummary(tx: SqlExecutor, id: string): Promise<CustomerSummary> {
  const row = (
    await tx.all<CustomerAggregateRow>(
      `${customerSelect} WHERE c.id = ? AND c.deleted_at IS NULL`,
      [id],
    )
  )[0];
  if (!row) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'This customer does not exist.');
  return mapCustomerSummary(row);
}

export type DebtRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  customer_phone: string | null;
  sale_id: string;
  sale_receipt_number: string;
  sale_total_kobo: number;
  original_amount_kobo: number;
  amount_paid_kobo: number;
  amount_cancelled_kobo: number;
  outstanding_kobo: number;
  due_date: string | null;
  status: DebtStatus;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export const debtSelect = `
  SELECT
    d.*,
    c.full_name AS customer_name,
    c.code AS customer_code,
    c.phone AS customer_phone,
    s.receipt_number AS sale_receipt_number,
    s.total_kobo AS sale_total_kobo
  FROM customer_debts d
  JOIN customers c ON c.id = d.customer_id
  JOIN sales s ON s.id = d.sale_id`;

export function mapDebt(row: DebtRow, today = todayIso()): DebtSummary {
  const outstanding = Number(row.outstanding_kobo);
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    customerPhone: row.customer_phone,
    saleId: row.sale_id,
    saleReceiptNumber: row.sale_receipt_number,
    saleTotalKobo: Number(row.sale_total_kobo),
    originalAmountKobo: Number(row.original_amount_kobo),
    amountPaidKobo: Number(row.amount_paid_kobo),
    amountCancelledKobo: Number(row.amount_cancelled_kobo),
    outstandingKobo: outstanding,
    dueDate: row.due_date,
    isOverdue: Boolean(outstanding > 0 && row.due_date && row.due_date < today),
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type DebtPaymentRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  receipt_number: string;
  debt_id: string;
  customer_id: string;
  customer_name: string;
  sale_id: string;
  sale_receipt_number: string;
  amount_kobo: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  balance_before_kobo: number;
  balance_after_kobo: number;
  recorded_by: string;
  recorded_by_name: string | null;
  created_at: string;
};

export const debtPaymentSelect = `
  SELECT
    dp.*,
    c.full_name AS customer_name,
    s.receipt_number AS sale_receipt_number,
    u.full_name AS recorded_by_name
  FROM debt_payments dp
  JOIN customers c ON c.id = dp.customer_id
  JOIN sales s ON s.id = dp.sale_id
  LEFT JOIN users u ON u.id = dp.recorded_by`;

export function mapDebtPayment(row: DebtPaymentRow): DebtPaymentSummary {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    debtId: row.debt_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    saleId: row.sale_id,
    saleReceiptNumber: row.sale_receipt_number,
    amountKobo: Number(row.amount_kobo),
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    balanceBeforeKobo: Number(row.balance_before_kobo),
    balanceAfterKobo: Number(row.balance_after_kobo),
    recordedBy: row.recorded_by,
    recordedByName: row.recorded_by_name,
    createdAt: row.created_at,
  };
}

export async function listDebts(
  db: SqlExecutor,
  query: {
    search?: string;
    customerId?: string;
    status?: 'outstanding' | DebtStatus;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<DebtSummary>> {
  const today = todayIso();
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.customerId) {
    where.push('d.customer_id = ?');
    values.push(query.customerId);
  }
  if (query.status === 'outstanding') {
    where.push("d.status IN ('open','partial')");
  } else if (query.status) {
    where.push('d.status = ?');
    values.push(query.status);
  }
  if (query.search) {
    where.push(
      "(c.full_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.code LIKE ? ESCAPE '\\' OR s.receipt_number LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    values.push(pattern, pattern, pattern, pattern);
  }
  if (query.from) {
    where.push('d.created_at >= ?');
    values.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    where.push('d.created_at <= ?');
    values.push(`${query.to}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count
      FROM customer_debts d
      JOIN customers c ON c.id = d.customer_id
      JOIN sales s ON s.id = d.sale_id
      ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<DebtRow>(
    `${debtSelect} ${clause} ORDER BY (d.outstanding_kobo > 0) DESC, d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(
    rows.map((row) => mapDebt(row, today)),
    query.page,
    query.pageSize,
    Number(total),
  );
}

export async function getDebtDetail(db: SqlExecutor, id: string): Promise<DebtDetail> {
  const row = (await db.all<DebtRow>(`${debtSelect} WHERE d.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'DEBT_NOT_FOUND', 'This debt record does not exist.');
  const payments = await db.all<DebtPaymentRow>(
    `${debtPaymentSelect} WHERE dp.debt_id = ? ORDER BY dp.created_at DESC, dp.id DESC`,
    [id],
  );
  return {
    ...mapDebt(row),
    payments: payments.map(mapDebtPayment),
    shop: await readShopSettings(db),
  };
}

export async function getDebtReport(db: SqlExecutor): Promise<DebtReport> {
  const today = todayIso();
  const totals = (
    await db.all<{
      original_total: number;
      repaid_total: number;
      cancelled_total: number;
      outstanding_total: number;
      open_count: number;
      overdue_count: number;
      overdue_amount: number;
      customers_count: number;
    }>(
      `SELECT
        COALESCE(SUM(original_amount_kobo), 0) AS original_total,
        COALESCE(SUM(amount_paid_kobo), 0) AS repaid_total,
        COALESCE(SUM(amount_cancelled_kobo), 0) AS cancelled_total,
        COALESCE(SUM(CASE WHEN status IN ('open','partial') THEN outstanding_kobo ELSE 0 END), 0) AS outstanding_total,
        COALESCE(SUM(CASE WHEN status IN ('open','partial') THEN 1 ELSE 0 END), 0) AS open_count,
        COALESCE(SUM(CASE WHEN status IN ('open','partial') AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue_count,
        COALESCE(SUM(CASE WHEN status IN ('open','partial') AND due_date IS NOT NULL AND due_date < ? THEN outstanding_kobo ELSE 0 END), 0) AS overdue_amount,
        (SELECT COUNT(DISTINCT customer_id) FROM customer_debts WHERE status IN ('open','partial') AND outstanding_kobo > 0) AS customers_count
      FROM customer_debts`,
      [today, today],
    )
  )[0]!;

  const topDebtors = await db.all<{
    customer_id: string;
    customer_code: string;
    customer_name: string;
    phone: string | null;
    open_debt_count: number;
    outstanding_balance_kobo: number;
    oldest_debt_date: string;
  }>(
    `SELECT
      c.id AS customer_id,
      c.code AS customer_code,
      c.full_name AS customer_name,
      c.phone,
      COUNT(d.id) AS open_debt_count,
      SUM(d.outstanding_kobo) AS outstanding_balance_kobo,
      MIN(d.created_at) AS oldest_debt_date
    FROM customer_debts d
    JOIN customers c ON c.id = d.customer_id
    WHERE d.status IN ('open','partial') AND d.outstanding_kobo > 0
    GROUP BY c.id
    ORDER BY outstanding_balance_kobo DESC, oldest_debt_date ASC
    LIMIT 25`,
  );

  const recentRepayments = await db.all<DebtPaymentRow>(
    `${debtPaymentSelect} ORDER BY dp.created_at DESC, dp.id DESC LIMIT 20`,
  );

  return {
    totalOriginalCreditKobo: Number(totals.original_total),
    totalRepaidKobo: Number(totals.repaid_total),
    totalCancelledKobo: Number(totals.cancelled_total),
    totalOutstandingKobo: Number(totals.outstanding_total),
    openDebtCount: Number(totals.open_count),
    overdueDebtCount: Number(totals.overdue_count),
    overdueAmountKobo: Number(totals.overdue_amount),
    customersWithDebtCount: Number(totals.customers_count),
    topDebtors: topDebtors.map((row) => ({
      customerId: row.customer_id,
      customerCode: row.customer_code,
      customerName: row.customer_name,
      phone: row.phone,
      openDebtCount: Number(row.open_debt_count),
      outstandingBalanceKobo: Number(row.outstanding_balance_kobo),
      oldestDebtDate: row.oldest_debt_date,
    })),
    recentRepayments: recentRepayments.map(mapDebtPayment),
  };
}

async function applySingleDebtPayment(
  tx: SqlExecutor,
  context: { auth: AuthContext; requestId: string; now: string },
  debt: DebtRow,
  payment: {
    operationId: string;
    fingerprint: string;
    amountKobo: number;
    method: PaymentMethod;
    reference: string | null;
    notes: string | null;
  },
): Promise<DebtPaymentSummary> {
  const before = Number(debt.outstanding_kobo);
  if (debt.status === 'settled' || debt.status === 'cancelled' || before <= 0) {
    throw new ApiError(409, 'DEBT_NOT_OPEN', 'This debt has already been settled or cancelled.');
  }
  if (payment.amountKobo > before) {
    throw new ApiError(
      409,
      'REPAYMENT_EXCEEDS_DEBT',
      `Repayment exceeds the outstanding balance of ${before} kobo on this invoice.`,
    );
  }
  const after = before - payment.amountKobo;
  const nextPaid = Number(debt.amount_paid_kobo) + payment.amountKobo;
  const nextStatus: DebtStatus = after === 0 ? 'settled' : 'partial';

  const updated = await tx.run(
    `UPDATE customer_debts
    SET amount_paid_kobo = ?, outstanding_kobo = ?, status = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?`,
    [nextPaid, after, nextStatus, context.now, debt.id, debt.version],
  );
  if (updated.changes !== 1) {
    throw new ApiError(
      409,
      'DEBT_CONFLICT',
      'This debt balance changed while saving. Reload and try again.',
    );
  }
  if (after === 0) {
    await tx.run(
      `UPDATE sales SET payment_status = 'paid', version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'completed'`,
      [context.now, debt.sale_id],
    );
  }
  const id = crypto.randomUUID();
  const receiptNumber = await nextSequenceCode(tx, 'DP', todayIso(), 4);
  await tx.run(
    `INSERT INTO debt_payments (
      id, operation_id, operation_fingerprint, receipt_number, debt_id, customer_id, sale_id,
      amount_kobo, method, reference, notes, balance_before_kobo, balance_after_kobo,
      recorded_by, device_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      payment.operationId,
      payment.fingerprint,
      receiptNumber,
      debt.id,
      debt.customer_id,
      debt.sale_id,
      payment.amountKobo,
      payment.method,
      payment.reference,
      payment.notes,
      before,
      after,
      context.auth.user.id,
      context.auth.deviceId,
      context.now,
    ],
  );
  await audit(tx, {
    action: 'debt.repayment_recorded',
    actorId: context.auth.user.id,
    deviceId: context.auth.deviceId,
    requestId: context.requestId,
    entityType: 'debt_payment',
    entityId: id,
    metadata: {
      receiptNumber,
      debtId: debt.id,
      customerId: debt.customer_id,
      saleId: debt.sale_id,
      amountKobo: payment.amountKobo,
      method: payment.method,
      balanceBeforeKobo: before,
      balanceAfterKobo: after,
    },
  });
  const stored = (await tx.all<DebtPaymentRow>(`${debtPaymentSelect} WHERE dp.id = ?`, [id]))[0]!;
  return mapDebtPayment(stored);
}

export async function recordDebtRepayment(
  db: Database,
  auth: AuthContext,
  requestId: string,
  debtId: string,
  input: DebtRepaymentInput,
): Promise<{ debt: DebtDetail; payment: DebtPaymentSummary }> {
  const fingerprint = await operationHash('debt-repayment-v1', {
    debtId,
    amountKobo: input.amountKobo,
    method: input.method,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
  });

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'debts.repay');
    const existing = (
      await tx.all<DebtPaymentRow>(`${debtPaymentSelect} WHERE dp.operation_id = ?`, [
        input.operationId,
      ])
    )[0];
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different debt repayment.',
        );
      }
      return {
        debt: await getDebtDetail(tx, existing.debt_id),
        payment: mapDebtPayment(existing),
      };
    }

    const debt = (await tx.all<DebtRow>(`${debtSelect} WHERE d.id = ?`, [debtId]))[0];
    if (!debt) throw new ApiError(404, 'DEBT_NOT_FOUND', 'This debt record does not exist.');

    const now = new Date().toISOString();
    const payment = await applySingleDebtPayment(tx, { auth, requestId, now }, debt, {
      operationId: input.operationId,
      fingerprint,
      amountKobo: input.amountKobo,
      method: input.method,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
    });
    return {
      debt: await getDebtDetail(tx, debt.id),
      payment,
    };
  });
}

/**
 *Deterministic UUID derived from a parent operationId and a 1-based leg index so multi-debt FIFO
 * settlements satisfy the non-nil UUID v4/v5-style layout check on `debt_payments.operation_id`.
 */
async function derivedOperationUuid(operationId: string, legIndex: number): Promise<string> {
  if (legIndex === 0) return operationId;
  const hex = await operationHash('debt-settlement-leg', { operationId, legIndex });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function recordCustomerRepayment(
  db: Database,
  auth: AuthContext,
  requestId: string,
  customerId: string,
  input: CustomerRepaymentInput,
): Promise<CustomerRepaymentResult> {
  const fingerprint = await operationHash('customer-repayment-v1', {
    customerId,
    settleAll: input.settleAll,
    amountKobo: input.amountKobo ?? null,
    method: input.method,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
  });

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'debts.repay');
    const existing = (
      await tx.all<DebtPaymentRow>(`${debtPaymentSelect} WHERE dp.operation_id = ?`, [
        input.operationId,
      ])
    )[0];
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different repayment.',
        );
      }
      const batchRows = await tx.all<DebtPaymentRow>(
        `${debtPaymentSelect} WHERE dp.customer_id = ? AND dp.created_at = ? ORDER BY dp.receipt_number ASC`,
        [customerId, existing.created_at],
      );
      const payments = batchRows.map(mapDebtPayment);
      return {
        customer: await loadCustomerSummary(tx, customerId),
        totalAppliedKobo: payments.reduce((sum, p) => sum + p.amountKobo, 0),
        payments,
        shop: await readShopSettings(tx),
      };
    }

    await loadCustomerSummary(tx, customerId);
    const openDebts = await tx.all<DebtRow>(
      `${debtSelect}
      WHERE d.customer_id = ? AND d.status IN ('open','partial') AND d.outstanding_kobo > 0
      ORDER BY d.created_at ASC, d.id ASC`,
      [customerId],
    );
    if (openDebts.length === 0) {
      throw new ApiError(409, 'NO_OUTSTANDING_DEBT', 'This customer has no outstanding debt.');
    }
    const totalOwed = openDebts.reduce((sum, row) => sum + Number(row.outstanding_kobo), 0);
    const targetAmount = input.settleAll ? totalOwed : (input.amountKobo ?? 0);
    if (targetAmount <= 0) {
      throw new ApiError(400, 'INVALID_REPAYMENT', 'Repayment amount must be greater than zero.');
    }
    if (targetAmount > totalOwed) {
      throw new ApiError(
        409,
        'REPAYMENT_EXCEEDS_DEBT',
        `Repayment exceeds the customer's total outstanding balance of ${totalOwed} kobo.`,
      );
    }

    const now = new Date().toISOString();
    let remaining = targetAmount;
    const payments: DebtPaymentSummary[] = [];
    for (const [index, debt] of openDebts.entries()) {
      if (remaining <= 0) break;
      const apply = Math.min(remaining, Number(debt.outstanding_kobo));
      const legOpId = await derivedOperationUuid(input.operationId, index);
      const created = await applySingleDebtPayment(tx, { auth, requestId, now }, debt, {
        operationId: legOpId,
        fingerprint,
        amountKobo: apply,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      });
      payments.push(created);
      remaining -= apply;
    }

    return {
      customer: await loadCustomerSummary(tx, customerId),
      totalAppliedKobo: targetAmount,
      payments,
      shop: await readShopSettings(tx),
    };
  });
}
