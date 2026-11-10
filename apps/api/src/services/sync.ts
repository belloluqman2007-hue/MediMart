import type { Database, SqlExecutor } from '@medimart/database';
import {
  allowedOfflineSkewMs,
  canonicalJson,
  hasPermission,
  sha256,
  SYNC_PROTOCOL_VERSION,
  type OfflineEnvelope,
  type OfflineSummary,
  type SyncAcceptedRecord,
  type SyncBatchResponse,
  type SyncConflictRecord,
  type SyncRejectedRecord,
  type SyncStatusResponse,
} from '@medimart/shared';
import { ApiError } from '../errors';
import { audit } from './audit';
import type { AuthContext } from './auth';
import { createSale } from './sales/transactions';
import { createCustomer } from './sales/customers';
import { recordCustomerRepayment } from './sales/debts';
import { receiveStock } from './inventory/stock';
import { createPurchase } from './finance/purchases';
import { createExpense } from './finance/expenses';

/**
 * Phase 6 synchronization.
 *
 * The central server — never the phone — decides whether an offline record is accepted. Each
 * record is validated with the same service function an online request uses, inside one
 * transaction. The authoritative outcome is written to `offline_records` in the same transaction,
 * so re-sending a record after a dropped response is answered from that row instead of being
 * applied twice. A record that cannot be applied is marked `rejected` with a readable reason and
 * remains visible; it is never silently dropped.
 */

/** Batches stay small enough for a weak phone on a shop Wi-Fi network. */
export const SYNC_BATCH_LIMIT = 25;

/** A device clock that runs far ahead is a data-integrity risk for daily reports. */
export const MAX_CLOCK_SKEW_MS = allowedOfflineSkewMs;

const MAX_ATTEMPTS = 5;

export type OfflineRecordRow = {
  id: string;
  operation_id: string;
  device_id: string;
  record_type:
    'sale' | 'customer' | 'customer_repayment' | 'stock_receipt' | 'purchase_order' | 'expense';
  schema_version: number;
  captured_by: string;
  client_created_at: string;
  client_date: string;
  envelope_json: string;
  payload_hash: string;
  status: 'pending' | 'applied' | 'rejected' | 'conflict';
  attempts: number;
  result_reference: string | null;
  receipt_number: string | null;
  error_code: string | null;
  error_message: string | null;
  received_at: string | null;
  applied_at: string | null;
  created_at: string;
};

/** The fingerprint covers every field except itself, using the same canonical JSON as the device. */
export function envelopeFingerprint(envelope: Omit<OfflineEnvelope, 'fingerprint'>) {
  return sha256(canonicalJson(envelope));
}

/**
 * Domain services take a `Database` and open their own transaction. Inside the sync transaction we
 * must not open a second (SQLite cannot nest BEGIN IMMEDIATE), so the *existing* transaction is
 * adapted to the same interface. Any error still propagates and rolls the whole record back.
 */
function withinTransaction(tx: SqlExecutor): Database {
  return {
    run: (sql, values) => tx.run(sql, values),
    all: <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: readonly (string | number | null)[],
    ) => tx.all<T>(sql, values),
    transaction: async <T>(work: (inner: SqlExecutor) => Promise<T>): Promise<T> => work(tx),
    close: async () => undefined,
  };
}

type ApplyResult =
  | { status: 'applied'; reference: string; receiptNumber: string | null; warnings: string[] }
  | { status: 'rejected'; code: string; message: string; terminal: boolean }
  | { status: 'conflict'; code: string; message: string; currentVersion: number };

function classifyError(error: unknown): ApplyResult {
  if (error instanceof ApiError) {
    const code = error.code;
    // These are permanent unless a supervisor changes the data or grant.
    if (code === 'OPERATION_CONFLICT')
      return {
        status: 'conflict',
        code,
        message: error.message,
        currentVersion: 1,
      };
    return {
      status: 'rejected',
      code,
      message: error.message,
      terminal: [
        'VALIDATION_ERROR',
        'PERMISSION_DENIED',
        'SESSION_INVALID',
        'PRODUCT_INACTIVE',
        'INSUFFICIENT_STOCK',
        'EXPIRED_STOCK_UNAVAILABLE',
        'CUSTOMER_INACTIVE',
        'SALE_NOT_FOUND',
      ].includes(code),
    };
  }
  return {
    status: 'rejected',
    code: 'APPLY_FAILED',
    message:
      error instanceof Error
        ? `The shop computer could not apply this record: ${error.message}`
        : 'The shop computer could not apply this record.',
    terminal: false,
  };
}

/**
 * Apply one captured record through the existing domain services.
 *
 * Deliberate limits:
 * - Discounts are only accepted when the *staff account* itself holds `sales.discount`. A cashier
 *   cannot authorize their own discount while offline, because no second person can be verified
 *   without the server. The record is returned for review instead of being forced through.
 * - Clinical records are never accepted through this channel; they stay online-only.
 */
async function applyEnvelope(
  tx: SqlExecutor,
  auth: AuthContext,
  requestId: string,
  envelope: OfflineEnvelope,
): Promise<ApplyResult> {
  const record = envelope.record;
  const db = withinTransaction(tx);

  if (record.requiresOnlineReview)
    return {
      status: 'rejected',
      code: 'NEEDS_ONLINE_REVIEW',
      message:
        'This record was flagged on the device for supervisor review. Re-record it on the shop computer.',
      terminal: false,
    };

  if (record.recordType === 'sale') {
    const hasDiscount =
      record.payload.cartDiscountKobo > 0 ||
      record.payload.items.some((item) => item.lineDiscountKobo > 0);
    if (hasDiscount && !hasPermission(auth.user.permissions, 'sales.discount'))
      return {
        status: 'rejected',
        code: 'DISCOUNT_NOT_AUTHORIZED_OFFLINE',
        message:
          'This offline sale includes a discount that your account is not authorized to give. Ask a supervisor to record it on the shop computer.',
        terminal: false,
      };

    const sale = await createSale(
      db,
      // No supervisor password can be verified without the server, so no supervisor override is
      // passed here; `sales.discount` on the live account is the only accepted authority.
      { verifySupervisorCredentials: async () => undefined } as never,
      auth,
      requestId,
      {
        operationId: envelope.operationId,
        customerId: record.payload.customerId ?? null,
        items: record.payload.items.map((item) => ({
          productId: item.productId,
          unitId: item.unitId,
          quantity: item.quantity,
          lineDiscountKobo: item.lineDiscountKobo,
        })),
        cartDiscountKobo: record.payload.cartDiscountKobo,
        discountReason: record.payload.discountReason ?? undefined,
        payments: record.payload.payments.map((payment) => ({
          method: payment.method,
          amountKobo: payment.amountKobo,
          reference: payment.reference ?? null,
        })),
        dueDate: record.payload.dueDate ?? null,
        notes: record.payload.notes ?? null,
      },
    );
    return {
      status: 'applied',
      reference: sale.sale.id,
      receiptNumber: sale.sale.receiptNumber,
      warnings: sale.replayed
        ? ['This sale had already been applied; the original receipt was kept.']
        : [],
    };
  }

  if (record.recordType === 'customer') {
    const customer = await createCustomer(db, auth, requestId, {
      fullName: record.payload.customer.fullName,
      phone: record.payload.customer.phone ?? null,
      email: null,
      address: record.payload.customer.address ?? null,
      notes: 'Registered offline on an Android device.',
      creditLimitKobo: record.payload.customer.creditLimitKobo ?? null,
      status: 'active',
    });
    return { status: 'applied', reference: customer.id, receiptNumber: null, warnings: [] };
  }

  if (record.recordType === 'customer_repayment') {
    const repayment = await recordCustomerRepayment(
      db,
      auth,
      requestId,
      record.payload.customerId,
      {
        operationId: envelope.operationId,
        amountKobo: record.payload.amountKobo,
        settleAll: false,
        method: record.payload.method,
        reference: record.payload.reference ?? null,
        notes: record.payload.notes ?? null,
      },
    );
    return {
      status: 'applied',
      reference: repayment.customer.id,
      receiptNumber: repayment.payments[0]?.receiptNumber ?? null,
      warnings: [],
    };
  }

  if (record.recordType === 'stock_receipt') {
    const receipt = record.payload.receipt;
    // Validate before touching the ledger: a zero-cost receipt would corrupt stock valuation.
    if (receipt.unitCostKobo === null || receipt.unitCostKobo <= 0)
      return {
        status: 'rejected',
        code: 'UNIT_COST_REQUIRED',
        message:
          'A stock receipt needs a real unit cost so stock value and profit stay accurate. Record it on the shop computer.',
        terminal: false,
      };
    const movement = await receiveStock(db, auth, requestId, {
      productId: receipt.productId,
      quantity: receipt.quantity,
      unitId: receipt.unitId ?? (await baseUnitOf(tx, receipt.productId)),
      unitCostKobo: receipt.unitCostKobo,
      supplierId: receipt.supplierId ?? null,
      reason: receipt.reason,
      referenceId: null,
      operationId: envelope.operationId,
      batchNumber: receipt.batchNumber ?? null,
      manufacturingDate: receipt.manufacturingDate ?? null,
      expiryDate: receipt.expiryDate ?? null,
      movementType: 'stock_received',
    });
    return {
      status: 'applied',
      reference: movement.movement.id,
      receiptNumber: null,
      warnings: [],
    };
  }

  if (record.recordType === 'purchase_order') {
    const order = record.payload.order;
    const purchase = await createPurchase(db, auth, requestId, {
      ...order,
      operationId: envelope.operationId,
      status: 'ordered',
    });
    return {
      status: 'applied',
      reference: purchase.id,
      receiptNumber: null,
      warnings: ['This purchase order still needs goods receiving on the shop computer.'],
    };
  }

  const expense = record.payload.expense;
  const created = await createExpense(db, auth, requestId, {
    ...expense,
    operationId: envelope.operationId,
    status: 'recorded',
    attachment: null,
  });
  return {
    status: 'applied',
    reference: created.id,
    receiptNumber: null,
    warnings: [],
  };
}

/** Products are received in their base unit unless the device names another configured unit. */
async function baseUnitOf(tx: SqlExecutor, productId: string) {
  const row = (
    await tx.all<{ base_unit_id: string }>('SELECT base_unit_id FROM products WHERE id = ?', [
      productId,
    ])
  )[0];
  if (!row) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'This product does not exist.');
  return row.base_unit_id;
}

export function requireSyncPermission(auth: AuthContext, permission: 'sync.manage' | 'sync.view') {
  if (!hasPermission(auth.user.permissions, permission))
    throw new ApiError(
      403,
      'PERMISSION_DENIED',
      'Your account does not have permission to synchronize device records.',
    );
}

/** Accept a batch from an approved paired device. Each record commits or rolls back on its own. */
export async function ingestBatch(
  db: Database,
  auth: AuthContext,
  requestId: string,
  envelopes: OfflineEnvelope[],
): Promise<SyncBatchResponse> {
  requireSyncPermission(auth, 'sync.manage');
  if (!auth.deviceId)
    throw new ApiError(
      403,
      'DEVICE_REQUIRED',
      'Synchronization must come from a paired device, not an ordinary browser session.',
    );
  if (envelopes.length > SYNC_BATCH_LIMIT)
    throw new ApiError(
      400,
      'BATCH_TOO_LARGE',
      `Send at most ${SYNC_BATCH_LIMIT} records per synchronization request.`,
    );

  const accepted: SyncAcceptedRecord[] = [];
  const rejected: SyncRejectedRecord[] = [];
  const conflicts: SyncConflictRecord[] = [];

  for (const envelope of envelopes) {
    const recordType = envelope.record.recordType;
    if (envelope.deviceId !== auth.deviceId)
      throw new ApiError(
        403,
        'DEVICE_MISMATCH',
        'This batch contains records created by a different installation.',
      );

    const fingerprint = await envelopeFingerprint({
      schemaVersion: envelope.schemaVersion,
      operationId: envelope.operationId,
      deviceId: envelope.deviceId,
      clientCreatedAt: envelope.clientCreatedAt,
      clientDate: envelope.clientDate,
      capturedByUserId: envelope.capturedByUserId,
      record: envelope.record,
    });

    if (fingerprint !== envelope.fingerprint) {
      rejected.push({
        operationId: envelope.operationId,
        recordType,
        code: 'FINGERPRINT_MISMATCH',
        message: 'This record changed after it was saved on the device, so it was not accepted.',
        terminal: true,
      });
      continue;
    }

    const createdMs = Date.parse(envelope.clientCreatedAt);
    if (Number.isNaN(createdMs)) {
      rejected.push({
        operationId: envelope.operationId,
        recordType,
        code: 'DEVICE_CLOCK_INVALID',
        message: 'This record has an invalid device timestamp.',
        terminal: false,
      });
      continue;
    }
    if (createdMs - Date.now() > MAX_CLOCK_SKEW_MS) {
      rejected.push({
        operationId: envelope.operationId,
        recordType,
        code: 'DEVICE_CLOCK_AHEAD',
        message:
          'The phone clock is more than three days ahead of the shop computer. Correct the phone date and time, then synchronize again.',
        terminal: false,
      });
      continue;
    }

    const outcome = await db.transaction(async (tx) => {
      const existing = (
        await tx.all<OfflineRecordRow>('SELECT * FROM offline_records WHERE operation_id = ?', [
          envelope.operationId,
        ])
      )[0];

      if (existing) {
        if (existing.payload_hash !== fingerprint || existing.device_id !== envelope.deviceId)
          throw new ApiError(
            409,
            'OPERATION_CONFLICT',
            'An offline record with this identifier already exists with different contents.',
          );
        if (existing.status !== 'pending') return { replay: true as const, row: existing };
        if (existing.attempts >= MAX_ATTEMPTS)
          throw new ApiError(
            409,
            'SYNC_ATTEMPTS_EXHAUSTED',
            'This record has failed to apply repeatedly. Ask an administrator to review it.',
          );
        await tx.run(
          'UPDATE offline_records SET attempts = attempts + 1, received_at = ? WHERE id = ?',
          [new Date().toISOString(), existing.id],
        );
      } else {
        const now = new Date().toISOString();
        await tx.run(
          `INSERT INTO offline_records (
            id, operation_id, device_id, record_type, schema_version, captured_by,
            client_created_at, client_date, envelope_json, payload_hash, status, attempts,
            received_at, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',1,?,?)`,
          [
            crypto.randomUUID(),
            envelope.operationId,
            envelope.deviceId,
            recordType,
            envelope.schemaVersion,
            envelope.capturedByUserId,
            envelope.clientCreatedAt,
            envelope.clientDate,
            canonicalJson(envelope),
            fingerprint,
            now,
            now,
          ],
        );
      }

      const stored = (
        await tx.all<OfflineRecordRow>('SELECT * FROM offline_records WHERE operation_id = ?', [
          envelope.operationId,
        ])
      )[0]!;

      let result: ApplyResult;
      try {
        result = await applyEnvelope(tx, auth, requestId, envelope);
      } catch (error) {
        result = classifyError(error);
      }

      if (result.status === 'applied') {
        await tx.run(
          `UPDATE offline_records SET status='applied', applied_at=?, result_reference=?,
            receipt_number=?, error_code=NULL, error_message=NULL WHERE id=?`,
          [new Date().toISOString(), result.reference, result.receiptNumber, stored.id],
        );
        await audit(tx, {
          action: 'sync.record_applied',
          actorId: auth.user.id,
          deviceId: auth.deviceId,
          requestId,
          entityType: stored.record_type,
          entityId: result.reference,
          metadata: {
            operationId: envelope.operationId,
            recordType: stored.record_type,
            clientDate: envelope.clientDate,
          },
        });
      } else if (result.status === 'conflict') {
        await tx.run(
          `UPDATE offline_records SET status='conflict', applied_at=NULL, result_reference=NULL,
            error_code=?, error_message=? WHERE id=?`,
          [result.code, result.message, stored.id],
        );
        await audit(tx, {
          action: 'sync.record_conflict',
          actorId: auth.user.id,
          deviceId: auth.deviceId,
          requestId,
          entityType: stored.record_type,
          entityId: stored.id,
          metadata: { operationId: envelope.operationId, code: result.code },
        });
      } else {
        // `applied_at` stays NULL for a rejected record: nothing was written to business data.
        await tx.run(
          `UPDATE offline_records SET status='rejected', applied_at=NULL,
            error_code=?, error_message=? WHERE id=?`,
          [result.code, result.message, stored.id],
        );
        await audit(tx, {
          action: 'sync.record_rejected',
          actorId: auth.user.id,
          deviceId: auth.deviceId,
          requestId,
          entityType: stored.record_type,
          entityId: stored.id,
          metadata: { operationId: envelope.operationId, code: result.code },
        });
      }

      return { replay: false as const, row: stored, result };
    });

    if (outcome.replay) {
      const row = outcome.row;
      if (row.status === 'applied')
        accepted.push({
          operationId: envelope.operationId,
          recordType,
          outcome: 'duplicate',
          reference: row.result_reference ?? '',
          receiptNumber: row.receipt_number,
          auditIds: [],
          warnings: ['This record was already synchronized and was not applied twice.'],
        });
      else if (row.status === 'rejected')
        rejected.push({
          operationId: envelope.operationId,
          recordType,
          code: row.error_code ?? 'REJECTED',
          message: row.error_message ?? 'The shop computer rejected this record.',
          terminal: true,
        });
      else
        conflicts.push({
          operationId: envelope.operationId,
          recordType,
          code: row.error_code ?? 'CONFLICT',
          message: row.error_message ?? 'This record conflicts with newer data.',
          currentVersion: 1,
        });
    } else if (outcome.result.status === 'applied') {
      accepted.push({
        operationId: envelope.operationId,
        recordType,
        outcome: 'applied',
        reference: outcome.result.reference,
        receiptNumber: outcome.result.receiptNumber,
        auditIds: [],
        warnings: outcome.result.warnings,
      });
    } else if (outcome.result.status === 'conflict') {
      conflicts.push({
        operationId: envelope.operationId,
        recordType,
        code: outcome.result.code,
        message: outcome.result.message,
        currentVersion: outcome.result.currentVersion,
      });
    } else {
      rejected.push({
        operationId: envelope.operationId,
        recordType,
        code: outcome.result.code,
        message: outcome.result.message,
        terminal: outcome.result.terminal,
      });
    }
  }

  if (accepted.length) {
    await db.run('UPDATE sync_devices SET last_push_at=?, updated_at=? WHERE device_id=?', [
      new Date().toISOString(),
      new Date().toISOString(),
      auth.deviceId,
    ]);
  }

  const pendingRow = (
    await db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM offline_records WHERE device_id=? AND status='pending'",
      [auth.deviceId],
    )
  )[0]!;

  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    accepted,
    rejected,
    conflicts,
    remaining: Number(pendingRow.count),
  };
}

export async function syncStatus(db: Database, auth: AuthContext): Promise<SyncStatusResponse> {
  requireSyncPermission(auth, 'sync.view');
  if (!auth.deviceId)
    throw new ApiError(403, 'DEVICE_REQUIRED', 'Synchronization status requires a paired device.');
  const counts = await db.all<{ status: string; count: number }>(
    'SELECT status, COUNT(*) AS count FROM offline_records WHERE device_id = ? GROUP BY status',
    [auth.deviceId],
  );
  const byStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
  const device = (
    await db.all<{ id: string; status: 'pending' | 'approved' | 'revoked' }>(
      'SELECT id,status FROM devices WHERE id = ?',
      [auth.deviceId],
    )
  )[0];
  const syncDevice = (
    await db.all<{ last_push_at: string | null }>(
      'SELECT last_push_at FROM sync_devices WHERE device_id = ?',
      [auth.deviceId],
    )
  )[0];
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    implemented: true,
    serverTime: new Date().toISOString(),
    pending: byStatus.get('pending') ?? 0,
    synced: byStatus.get('applied') ?? 0,
    rejected: byStatus.get('rejected') ?? 0,
    conflict: byStatus.get('conflict') ?? 0,
    device: {
      id: auth.deviceId,
      status: device?.status ?? 'pending',
      lastSyncedAt: syncDevice?.last_push_at ?? null,
    },
  };
}

export type PendingRecordSummary = {
  operationId: string;
  recordType:
    'sale' | 'customer' | 'customer_repayment' | 'stock_receipt' | 'purchase_order' | 'expense';
  deviceId: string;
  clientDate: string;
  status: 'pending' | 'applied' | 'rejected' | 'conflict';
  reference: string | null;
  receiptNumber: string | null;
  message: string | null;
  attempts: number;
  createdAt: string;
  appliedAt: string | null;
};

/** Owner-facing review list. Browsers see every device; a device sees only its own records. */
export async function listOfflineRecords(
  db: Database,
  auth: AuthContext,
  options: { status?: string; page: number; pageSize: number },
): Promise<{
  items: PendingRecordSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  requireSyncPermission(auth, 'sync.view');
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.status) {
    where.push('status = ?');
    values.push(options.status);
  }
  if (auth.transport === 'bearer' && auth.deviceId) {
    where.push('device_id = ?');
    values.push(auth.deviceId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM offline_records ${clause}`,
      values,
    )
  )[0]!.count;
  const rows = await db.all<OfflineRecordRow>(
    `SELECT * FROM offline_records ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...values, options.pageSize, (options.page - 1) * options.pageSize],
  );
  return {
    items: rows.map((row) => ({
      operationId: row.operation_id,
      recordType: row.record_type,
      deviceId: row.device_id,
      clientDate: row.client_date,
      status: row.status,
      reference: row.result_reference,
      receiptNumber: row.receipt_number,
      message: row.error_message,
      attempts: row.attempts,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    })),
    page: options.page,
    pageSize: options.pageSize,
    total: Number(total),
    totalPages: Math.max(1, Math.ceil(Number(total) / options.pageSize)),
  };
}

export async function offlineSummary(db: Database, auth: AuthContext): Promise<OfflineSummary> {
  requireSyncPermission(auth, 'sync.view');
  const today = new Date().toISOString().slice(0, 10);
  const scope = auth.transport === 'bearer' && auth.deviceId ? 'WHERE device_id = ?' : '';
  const scopeValues = scope ? [auth.deviceId!] : [];
  const rows = await db.all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM offline_records ${scope} GROUP BY status`,
    scopeValues,
  );
  const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
  const syncedToday = (
    await db.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM offline_records ${scope ? `${scope} AND` : 'WHERE'} status='applied' AND applied_at >= ?`,
      [...scopeValues, `${today}T00:00:00.000Z`],
    )
  )[0]!.count;
  const lastError = (
    await db.all<{ error_message: string | null }>(
      "SELECT error_message FROM offline_records WHERE status='rejected' ORDER BY created_at DESC LIMIT 1",
    )
  )[0];
  const lastSync = (
    await db.all<{ last_push_at: string | null }>(
      'SELECT last_push_at FROM sync_devices ORDER BY last_push_at DESC LIMIT 1',
    )
  )[0];
  return {
    pending: byStatus.get('pending') ?? 0,
    syncedToday: Number(syncedToday),
    rejected: byStatus.get('rejected') ?? 0,
    conflict: byStatus.get('conflict') ?? 0,
    lastSyncedAt: lastSync?.last_push_at ?? null,
    lastError: lastError?.error_message ?? null,
  };
}
