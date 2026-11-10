import type { Database, SqlExecutor } from '@medimart/database';
import type {
  ExpenseCategorySummary,
  ExpenseCreateInput,
  ExpenseDetail,
  ExpenseReversalInput,
  ExpenseStatus,
  ExpenseSummary,
  ExpenseUpdateInput,
  Paginated,
  PaymentMethod,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, likePattern, paginate } from '../inventory/common';
import { nextSequenceCode, operationHash } from '../sales/common';

type ExpenseCategoryRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: number;
  sort_order: number;
  status: 'active' | 'inactive';
};

export async function listExpenseCategories(db: SqlExecutor): Promise<ExpenseCategorySummary[]> {
  const rows = await db.all<ExpenseCategoryRow>(
    `SELECT id,code,name,description,is_system,sort_order,status
    FROM expense_categories ORDER BY sort_order ASC, name ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system === 1,
    sortOrder: Number(row.sort_order),
    status: row.status,
  }));
}

export type ExpenseRow = {
  id: string;
  operation_id: string;
  operation_fingerprint: string | null;
  expense_number: string;
  category_id: string;
  category_name_snapshot: string;
  category_code: string;
  description: string;
  amount_kobo: number;
  payment_method: PaymentMethod;
  expense_date: string;
  payee: string | null;
  reference: string | null;
  notes: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  attachment_data: string | null;
  status: ExpenseStatus;
  recorded_at: string | null;
  recorded_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  reversal_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  recorded_by_name: string | null;
  reversed_by_name: string | null;
};

export const expenseSelect = `
  SELECT e.*, ec.code AS category_code,
    cu.full_name AS created_by_name,
    uu.full_name AS updated_by_name,
    ru.full_name AS recorded_by_name,
    vu.full_name AS reversed_by_name,
    (SELECT r.id FROM expense_reversals r WHERE r.expense_id = e.id LIMIT 1) AS reversal_id
  FROM expenses e
  JOIN expense_categories ec ON ec.id = e.category_id
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users uu ON uu.id = e.updated_by
  LEFT JOIN users ru ON ru.id = e.recorded_by
  LEFT JOIN users vu ON vu.id = e.reversed_by`;

export function mapExpense(row: ExpenseRow): ExpenseSummary {
  return {
    id: row.id,
    expenseNumber: row.expense_number,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name_snapshot,
    description: row.description,
    amountKobo: Number(row.amount_kobo),
    paymentMethod: row.payment_method,
    expenseDate: row.expense_date,
    payee: row.payee,
    reference: row.reference,
    notes: row.notes,
    hasAttachment: Boolean(row.attachment_name),
    attachmentName: row.attachment_name,
    attachmentMime: row.attachment_mime,
    status: row.status,
    recordedAt: row.recorded_at,
    recordedByName: row.recorded_by_name,
    reversedAt: row.reversed_at,
    reversedByName: row.reversed_by_name,
    reversalReason: row.reversal_reason,
    reversalId: row.reversal_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExpenseDetail(row: ExpenseRow): ExpenseDetail {
  return {
    ...mapExpense(row),
    attachment: row.attachment_name
      ? {
          name: row.attachment_name,
          mime: row.attachment_mime ?? '',
          ...(row.attachment_data ? { dataBase64: row.attachment_data } : {}),
        }
      : null,
  };
}

async function loadExpenseRow(tx: SqlExecutor, id: string) {
  const row = (await tx.all<ExpenseRow>(`${expenseSelect} WHERE e.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'EXPENSE_NOT_FOUND', 'This expense does not exist.');
  return row;
}

export async function getExpenseDetail(db: SqlExecutor, id: string): Promise<ExpenseDetail> {
  return mapExpenseDetail(await loadExpenseRow(db, id));
}

async function assertCategory(tx: SqlExecutor, categoryId: string) {
  const row = (
    await tx.all<ExpenseCategoryRow>(
      'SELECT id,code,name,description,is_system,sort_order,status FROM expense_categories WHERE id = ?',
      [categoryId],
    )
  )[0];
  if (!row)
    throw new ApiError(400, 'EXPENSE_CATEGORY_NOT_FOUND', 'Select a valid expense category.');
  if (row.status !== 'active')
    throw new ApiError(409, 'EXPENSE_CATEGORY_INACTIVE', 'This expense category is inactive.');
  return row;
}

function attachmentColumns(input: {
  attachment?: ExpenseCreateInput['attachment'] | null;
}): [string | null, string | null, string | null] {
  return input.attachment
    ? [input.attachment.name, input.attachment.mime, input.attachment.dataBase64]
    : [null, null, null];
}

async function findByOperation(tx: SqlExecutor, operationId: string) {
  return (
    await tx.all<{ id: string; operation_fingerprint: string | null }>(
      'SELECT id, operation_fingerprint FROM expenses WHERE operation_id = ?',
      [operationId],
    )
  )[0];
}

export async function createExpense(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: ExpenseCreateInput,
): Promise<ExpenseDetail> {
  const fingerprint = await operationHash('expense-create-v1', input);
  const preExisting = await findByOperation(db, input.operationId);
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different expense.',
      );
    return getExpenseDetail(db, preExisting.id);
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'expenses.create');
    const existing = await findByOperation(tx, input.operationId);
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different expense.',
        );
      return getExpenseDetail(tx, existing.id);
    }
    const category = await assertCategory(tx, input.categoryId);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const expenseNumber = await nextSequenceCode(tx, 'EXP');
    const [attachmentName, attachmentMime, attachmentData] = attachmentColumns(input);
    await tx.run(
      `INSERT INTO expenses (
        id, operation_id, operation_fingerprint, expense_number, category_id,
        category_name_snapshot, description, amount_kobo, payment_method, expense_date,
        payee, reference, notes, attachment_name, attachment_mime, attachment_data,
        status, recorded_at, recorded_by, created_by, updated_by, device_id,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.operationId,
        fingerprint,
        expenseNumber,
        category.id,
        category.name,
        input.description,
        input.amountKobo,
        input.paymentMethod,
        input.expenseDate,
        input.payee ?? null,
        input.reference ?? null,
        input.notes ?? null,
        attachmentName,
        attachmentMime,
        attachmentData,
        input.status,
        input.status === 'recorded' ? now : null,
        input.status === 'recorded' ? auth.user.id : null,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
        now,
        now,
      ],
    );
    await audit(tx, {
      action: input.status === 'recorded' ? 'expense.recorded' : 'expense.draft_created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'expense',
      entityId: id,
      metadata: {
        expenseNumber,
        categoryCode: category.code,
        amountKobo: input.amountKobo,
        paymentMethod: input.paymentMethod,
        expenseDate: input.expenseDate,
        payee: input.payee ?? '',
      },
    });
    return getExpenseDetail(tx, id);
  });
}

export async function updateExpense(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: ExpenseUpdateInput,
): Promise<ExpenseDetail> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'expenses.edit');
    const existing = await loadExpenseRow(tx, id);
    if (existing.status !== 'draft')
      throw new ApiError(
        409,
        'EXPENSE_NOT_DRAFT',
        'Only a draft expense can be edited. Reverse a recorded expense instead.',
      );
    if (Number(existing.version) !== input.version)
      throw new ApiError(
        409,
        'EXPENSE_CONFLICT',
        'This expense changed while you were editing it. Reload and try again.',
      );
    const category = await assertCategory(tx, input.categoryId);
    const now = new Date().toISOString();
    const [attachmentName, attachmentMime, attachmentData] = attachmentColumns(input);
    const updated = await tx.run(
      `UPDATE expenses SET
        category_id = ?, category_name_snapshot = ?, description = ?, amount_kobo = ?,
        payment_method = ?, expense_date = ?, payee = ?, reference = ?, notes = ?,
        attachment_name = ?, attachment_mime = ?, attachment_data = ?,
        updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'draft'`,
      [
        category.id,
        category.name,
        input.description,
        input.amountKobo,
        input.paymentMethod,
        input.expenseDate,
        input.payee ?? null,
        input.reference ?? null,
        input.notes ?? null,
        attachmentName,
        attachmentMime,
        attachmentData,
        auth.user.id,
        auth.deviceId,
        now,
        id,
        input.version,
      ],
    );
    if (updated.changes !== 1)
      throw new ApiError(
        409,
        'EXPENSE_CONFLICT',
        'This expense changed while you were editing it. Reload and try again.',
      );
    await audit(tx, {
      action: 'expense.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'expense',
      entityId: id,
      metadata: {
        expenseNumber: existing.expense_number,
        previousAmountKobo: Number(existing.amount_kobo),
        amountKobo: input.amountKobo,
        previousCategory: existing.category_name_snapshot,
        category: category.name,
        version: input.version + 1,
      },
    });
    return getExpenseDetail(tx, id);
  });
}

export async function recordExpense(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
): Promise<ExpenseDetail> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'expenses.edit');
    const existing = await loadExpenseRow(tx, id);
    if (existing.status !== 'draft')
      throw new ApiError(
        409,
        'EXPENSE_NOT_DRAFT',
        existing.status === 'recorded'
          ? 'This expense is already recorded.'
          : 'A reversed expense cannot be recorded again.',
      );
    const now = new Date().toISOString();
    const updated = await tx.run(
      `UPDATE expenses SET status = 'recorded', recorded_at = ?, recorded_by = ?,
        updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'draft' AND version = ?`,
      [now, auth.user.id, auth.user.id, auth.deviceId, now, id, existing.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(409, 'EXPENSE_CONFLICT', 'This expense changed. Reload and try again.');
    await audit(tx, {
      action: 'expense.posted',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'expense',
      entityId: id,
      metadata: {
        expenseNumber: existing.expense_number,
        amountKobo: Number(existing.amount_kobo),
      },
    });
    return getExpenseDetail(tx, id);
  });
}

export async function reverseExpense(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: ExpenseReversalInput,
): Promise<ExpenseDetail> {
  const fingerprint = await operationHash('expense-reversal-v1', { id, reason: input.reason });
  const preExisting = (
    await db.all<{ id: string; expense_id: string; operation_fingerprint: string | null }>(
      'SELECT id, expense_id, operation_fingerprint FROM expense_reversals WHERE operation_id = ?',
      [input.operationId],
    )
  )[0];
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different expense reversal.',
      );
    return getExpenseDetail(db, preExisting.expense_id);
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'expenses.reverse');
    const existing = await loadExpenseRow(tx, id);
    if (existing.status === 'reversed')
      throw new ApiError(
        409,
        'EXPENSE_ALREADY_REVERSED',
        'This expense has already been reversed.',
      );
    if (existing.status !== 'recorded')
      throw new ApiError(409, 'EXPENSE_NOT_RECORDED', 'Only a recorded expense can be reversed.');
    const now = new Date().toISOString();
    const reversalId = crypto.randomUUID();
    await tx.run(
      `INSERT INTO expense_reversals (
        id, operation_id, expense_id, reason, amount_kobo, reversed_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
      [
        reversalId,
        input.operationId,
        id,
        input.reason,
        existing.amount_kobo,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );
    const updated = await tx.run(
      `UPDATE expenses SET status = 'reversed', reversed_at = ?, reversed_by = ?,
        reversal_reason = ?, updated_by = ?, device_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'recorded' AND version = ?`,
      [now, auth.user.id, input.reason, auth.user.id, auth.deviceId, now, id, existing.version],
    );
    if (updated.changes !== 1)
      throw new ApiError(409, 'EXPENSE_CONFLICT', 'This expense changed. Reload and try again.');
    await audit(tx, {
      action: 'expense.reversed',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'expense',
      entityId: id,
      metadata: {
        expenseNumber: existing.expense_number,
        reversalId,
        amountKobo: Number(existing.amount_kobo),
        reason: input.reason,
      },
    });
    return getExpenseDetail(tx, id);
  });
}

export async function listExpenses(
  db: SqlExecutor,
  query: {
    search?: string;
    categoryId?: string;
    status?: ExpenseStatus;
    method?: PaymentMethod;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<ExpenseSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.search) {
    const pattern = likePattern(query.search);
    where.push(
      "(e.expense_number LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.payee LIKE ? ESCAPE '\\' OR e.reference LIKE ? ESCAPE '\\')",
    );
    values.push(pattern, pattern, pattern, pattern);
  }
  if (query.categoryId) {
    where.push('e.category_id = ?');
    values.push(query.categoryId);
  }
  if (query.status) {
    where.push('e.status = ?');
    values.push(query.status);
  }
  if (query.method) {
    where.push('e.payment_method = ?');
    values.push(query.method);
  }
  if (query.from) {
    where.push('e.expense_date >= ?');
    values.push(query.from);
  }
  if (query.to) {
    where.push('e.expense_date <= ?');
    values.push(query.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM expenses e ${clause}`, values)
  )[0]!.count;
  const rows = await db.all<ExpenseRow>(
    `${expenseSelect} ${clause} ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapExpense), query.page, query.pageSize, Number(total));
}
