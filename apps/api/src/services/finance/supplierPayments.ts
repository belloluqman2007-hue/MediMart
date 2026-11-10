import type { Database, SqlExecutor } from '@medimart/database';
import type {
  Paginated,
  SupplierPaymentCreateInput,
  SupplierPaymentReversalInput,
  SupplierPaymentSummary,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, paginate, todayIso } from '../inventory/common';
import { nextSequenceCode, operationHash } from '../sales/common';
import { loadSupplier } from './common';
import { assertInvoiceOutstanding } from './invoices';
import {
  hydratePaymentAllocations,
  mapSupplierPayment,
  supplierPaymentSelect,
  type SupplierPaymentRow,
} from './records';

async function mapPayments(db: SqlExecutor, rows: SupplierPaymentRow[]) {
  const allocations = await hydratePaymentAllocations(db, rows);
  return rows.map((row) => mapSupplierPayment(row, allocations.get(row.id) ?? []));
}

export async function getSupplierPayment(
  db: SqlExecutor,
  id: string,
): Promise<SupplierPaymentSummary> {
  const row = (
    await db.all<SupplierPaymentRow>(`${supplierPaymentSelect} WHERE sp.id = ?`, [id])
  )[0];
  if (!row) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'This supplier payment does not exist.');
  return (await mapPayments(db, [row]))[0]!;
}

async function findByOperation(tx: SqlExecutor, operationId: string) {
  return (
    await tx.all<{ id: string; operation_fingerprint: string | null }>(
      'SELECT id, operation_fingerprint FROM supplier_payments WHERE operation_id = ?',
      [operationId],
    )
  )[0];
}

export async function recordSupplierPayment(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: SupplierPaymentCreateInput,
): Promise<SupplierPaymentSummary> {
  const fingerprint = await operationHash('supplier-payment-create-v1', input);
  const preExisting = await findByOperation(db, input.operationId);
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different supplier payment.',
      );
    return getSupplierPayment(db, preExisting.id);
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'supplier_payments.record');
    const existing = await findByOperation(tx, input.operationId);
    if (existing) {
      if (existing.operation_fingerprint !== fingerprint)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different supplier payment.',
        );
      return getSupplierPayment(tx, existing.id);
    }

    const supplier = await loadSupplier(tx, input.supplierId);
    if (input.method !== 'cash' && input.reference) {
      const duplicate = (
        await tx.all<{ id: string }>(
          `SELECT id FROM supplier_payments
          WHERE supplier_id = ? AND method = ? AND reference = ? AND payment_kind = 'payment'`,
          [supplier.id, input.method, input.reference],
        )
      )[0];
      if (duplicate)
        throw new ApiError(
          409,
          'DUPLICATE_PAYMENT_REFERENCE',
          'A payment with this reference already exists for this supplier and method.',
        );
    }

    for (const allocation of input.allocations) {
      await assertInvoiceOutstanding(
        tx,
        supplier.id,
        allocation.purchaseOrderId,
        allocation.amountKobo,
      );
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const paymentNumber = await nextSequenceCode(tx, 'SP');
    await tx.run(
      `INSERT INTO supplier_payments (
        id, operation_id, operation_fingerprint, payment_number, supplier_id,
        payment_kind, method, amount_kobo, paid_at, reference, notes,
        reversal_of_payment_id, reversal_reason, recorded_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.operationId,
        fingerprint,
        paymentNumber,
        supplier.id,
        'payment',
        input.method,
        input.amountKobo,
        input.paidAt,
        input.reference ?? null,
        input.notes ?? null,
        null,
        null,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );
    for (const allocation of input.allocations) {
      await tx.run(
        `INSERT INTO supplier_payment_allocations (
          id, payment_id, purchase_order_id, direction, amount_kobo
        ) VALUES (?,?,?,?,?)`,
        [crypto.randomUUID(), id, allocation.purchaseOrderId, 'apply', allocation.amountKobo],
      );
    }
    await audit(tx, {
      action: 'supplier_payment.recorded',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'supplier_payment',
      entityId: id,
      metadata: {
        paymentNumber,
        supplierId: supplier.id,
        amountKobo: input.amountKobo,
        method: input.method,
        paidAt: input.paidAt,
        invoiceCount: input.allocations.length,
      },
    });
    return getSupplierPayment(tx, id);
  });
}

export async function reverseSupplierPayment(
  db: Database,
  auth: AuthContext,
  requestId: string,
  paymentId: string,
  input: SupplierPaymentReversalInput,
): Promise<SupplierPaymentSummary> {
  const fingerprint = await operationHash('supplier-payment-reversal-v1', {
    paymentId,
    reason: input.reason,
  });
  const preExisting = await findByOperation(db, input.operationId);
  if (preExisting) {
    if (preExisting.operation_fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'OPERATION_CONFLICT',
        'This operation ID was already used for a different supplier payment.',
      );
    return getSupplierPayment(db, preExisting.id);
  }

  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'supplier_payments.reverse');
    const original = (
      await tx.all<SupplierPaymentRow>(`${supplierPaymentSelect} WHERE sp.id = ?`, [paymentId])
    )[0];
    if (!original)
      throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'This supplier payment does not exist.');
    if (original.payment_kind !== 'payment')
      throw new ApiError(409, 'PAYMENT_NOT_REVERSIBLE', 'A reversal record cannot be reversed.');
    if (original.reversed_by_payment_id)
      throw new ApiError(
        409,
        'PAYMENT_ALREADY_REVERSED',
        'This payment has already been reversed.',
      );

    const allocations = await hydratePaymentAllocations(tx, [original]);
    const originalAllocations = allocations.get(original.id) ?? [];
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const paymentNumber = await nextSequenceCode(tx, 'SP');
    await tx.run(
      `INSERT INTO supplier_payments (
        id, operation_id, operation_fingerprint, payment_number, supplier_id,
        payment_kind, method, amount_kobo, paid_at, reference, notes,
        reversal_of_payment_id, reversal_reason, recorded_by, device_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.operationId,
        fingerprint,
        paymentNumber,
        original.supplier_id,
        'reversal',
        original.method,
        original.amount_kobo,
        todayIso(),
        original.reference,
        `Reversal of ${original.payment_number}`,
        original.id,
        input.reason,
        auth.user.id,
        auth.deviceId,
        now,
      ],
    );
    for (const allocation of originalAllocations) {
      if (allocation.direction !== 'apply') continue;
      await tx.run(
        `INSERT INTO supplier_payment_allocations (
          id, payment_id, purchase_order_id, direction, amount_kobo
        ) VALUES (?,?,?,?,?)`,
        [crypto.randomUUID(), id, allocation.purchaseOrderId, 'reverse', allocation.amountKobo],
      );
    }
    await audit(tx, {
      action: 'supplier_payment.reversed',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'supplier_payment',
      entityId: id,
      metadata: {
        paymentNumber,
        originalPaymentId: original.id,
        originalPaymentNumber: original.payment_number,
        supplierId: original.supplier_id,
        amountKobo: Number(original.amount_kobo),
        reason: input.reason,
      },
    });
    return getSupplierPayment(tx, id);
  });
}

export async function listSupplierPayments(
  db: SqlExecutor,
  query: {
    supplierId?: string;
    kind?: SupplierPaymentSummary['paymentKind'];
    method?: SupplierPaymentSummary['method'];
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<SupplierPaymentSummary>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (query.supplierId) {
    where.push('sp.supplier_id = ?');
    values.push(query.supplierId);
  }
  if (query.kind) {
    where.push('sp.payment_kind = ?');
    values.push(query.kind);
  }
  if (query.method) {
    where.push('sp.method = ?');
    values.push(query.method);
  }
  if (query.from) {
    where.push('sp.paid_at >= ?');
    values.push(query.from);
  }
  if (query.to) {
    where.push('sp.paid_at <= ?');
    values.push(query.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM supplier_payments sp ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<SupplierPaymentRow>(
    `${supplierPaymentSelect} ${clause} ORDER BY sp.paid_at DESC, sp.created_at DESC, sp.id DESC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(await mapPayments(db, rows), query.page, query.pageSize, Number(total));
}
