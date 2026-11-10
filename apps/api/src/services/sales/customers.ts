import type { Database, SqlExecutor } from '@medimart/database';
import type {
  CustomerDetail,
  CustomerInput,
  CustomerStatus,
  CustomerSummary,
  Paginated,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, likePattern, paginate } from '../inventory/common';
import { nextSequenceCode, readShopSettings } from './common';
import {
  customerSelect,
  debtPaymentSelect,
  debtSelect,
  loadCustomerSummary,
  mapCustomerSummary,
  mapDebt,
  mapDebtPayment,
  type CustomerAggregateRow,
  type DebtPaymentRow,
  type DebtRow,
} from './debts';
import { mapSaleSummary, saleHeaderSelect, type SaleHeaderRow } from './transactions';

async function assertUniqueCustomerContacts(
  tx: SqlExecutor,
  input: CustomerInput,
  excludeId?: string,
) {
  if (input.phone) {
    const rows = await tx.all<{ id: string }>(
      'SELECT id FROM customers WHERE phone = ? AND deleted_at IS NULL',
      [input.phone],
    );
    if (rows.some((row) => row.id !== excludeId)) {
      throw new ApiError(
        409,
        'CUSTOMER_PHONE_IN_USE',
        'Another customer already uses this phone number.',
      );
    }
  }
  if (input.email) {
    const rows = await tx.all<{ id: string }>(
      'SELECT id FROM customers WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL',
      [input.email],
    );
    if (rows.some((row) => row.id !== excludeId)) {
      throw new ApiError(
        409,
        'CUSTOMER_EMAIL_IN_USE',
        'Another customer already uses this email address.',
      );
    }
  }
}

export async function listCustomers(
  db: SqlExecutor,
  query: {
    search?: string;
    status?: CustomerStatus;
    hasDebt?: boolean;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<CustomerSummary>> {
  const where: string[] = ['c.deleted_at IS NULL'];
  const values: Array<string | number> = [];

  if (query.status) {
    where.push('c.status = ?');
    values.push(query.status);
  }
  if (query.search) {
    where.push(
      "(c.full_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.code LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    values.push(pattern, pattern, pattern, pattern);
  }
  if (query.hasDebt === true) {
    where.push(
      `EXISTS (SELECT 1 FROM customer_debts cd WHERE cd.customer_id = c.id AND cd.status IN ('open','partial') AND cd.outstanding_kobo > 0)`,
    );
  } else if (query.hasDebt === false) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM customer_debts cd WHERE cd.customer_id = c.id AND cd.status IN ('open','partial') AND cd.outstanding_kobo > 0)`,
    );
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM customers c ${clause}`, values)
  )[0]!.count;
  const rows = await db.all<CustomerAggregateRow>(
    `${customerSelect} ${clause} ORDER BY c.full_name ASC, c.id ASC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapCustomerSummary), query.page, query.pageSize, Number(total));
}

export async function createCustomer(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: CustomerInput,
): Promise<CustomerSummary> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'customers.manage');
    await assertUniqueCustomerContacts(tx, input);
    const id = crypto.randomUUID();
    const code = await nextSequenceCode(tx, 'CUST', 'GLOBAL', 4);
    const now = new Date().toISOString();
    await tx.run(
      `INSERT INTO customers (
        id, code, full_name, phone, email, address, notes, credit_limit_kobo, status,
        created_by, updated_by, device_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        code,
        input.fullName,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.notes ?? null,
        input.creditLimitKobo ?? null,
        input.status,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
        now,
        now,
      ],
    );
    await audit(tx, {
      action: 'customer.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'customer',
      entityId: id,
      metadata: { code, status: input.status },
    });
    return loadCustomerSummary(tx, id);
  });
}

export async function updateCustomer(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: CustomerInput,
): Promise<CustomerSummary> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'customers.manage');
    await loadCustomerSummary(tx, id);
    await assertUniqueCustomerContacts(tx, input, id);
    const now = new Date().toISOString();
    await tx.run(
      `UPDATE customers
      SET full_name = ?, phone = ?, email = ?, address = ?, notes = ?, credit_limit_kobo = ?,
          status = ?, updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
      [
        input.fullName,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.notes ?? null,
        input.creditLimitKobo ?? null,
        input.status,
        auth.user.id,
        auth.deviceId,
        now,
        id,
      ],
    );
    await audit(tx, {
      action: 'customer.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'customer',
      entityId: id,
      metadata: { status: input.status },
    });
    return loadCustomerSummary(tx, id);
  });
}

export async function getCustomerDetail(db: SqlExecutor, id: string): Promise<CustomerDetail> {
  const summary = await loadCustomerSummary(db, id);
  const salesRows = await db.all<SaleHeaderRow>(
    `${saleHeaderSelect} WHERE s.customer_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 30`,
    [id],
  );
  const debtRows = await db.all<DebtRow>(
    `${debtSelect} WHERE d.customer_id = ? ORDER BY (d.outstanding_kobo > 0) DESC, d.created_at DESC, d.id DESC LIMIT 50`,
    [id],
  );
  const repaymentRows = await db.all<DebtPaymentRow>(
    `${debtPaymentSelect} WHERE dp.customer_id = ? ORDER BY dp.created_at DESC, dp.id DESC LIMIT 50`,
    [id],
  );
  return {
    ...summary,
    recentSales: salesRows.map(mapSaleSummary),
    debts: debtRows.map((row) => mapDebt(row)),
    repayments: repaymentRows.map(mapDebtPayment),
    shop: await readShopSettings(db),
  };
}
