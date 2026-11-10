import { z } from 'zod';
import { uuidSchema } from './contracts';
// Envelopes only: there are deliberately no business transaction handlers in Phase 1.
// The internal-entity denylist is defense in depth, not authorization. Future workers
// must use an explicit business-handler allowlist, domain schemas and live permissions.
export const operationSchema = z
  .strictObject({
    id: uuidSchema,
    deviceId: uuidSchema,
    entityId: uuidSchema,
    entityType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    mutation: z.enum(['create', 'update', 'delete']),
    baseVersion: z.number().int().nonnegative().safe(),
    payload: z.record(z.string(), z.json()),
  })
  .superRefine((op, ctx) => {
    if (op.mutation === 'create' ? op.baseVersion !== 0 : op.baseVersion < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseVersion'],
        message: 'Creates require version 0; updates/deletes require the version being changed.',
      });
    }
    if (
      [
        'user',
        'users',
        'user_role',
        'user_roles',
        'user_session',
        'user_sessions',
        'session',
        'sessions',
        'device',
        'devices',
        'role',
        'roles',
        'permission',
        'permissions',
        'role_permission',
        'role_permissions',
        'application_setting',
        'application_settings',
        'setting',
        'settings',
        'audit_log',
        'audit_logs',
        'database_migration',
        'database_migrations',
        'sync_device',
        'sync_devices',
        'sync_queue',
        'sync_receipt',
        'sync_receipts',
        'sync_conflict',
        'sync_conflicts',
        // Phase 2 inventory tables are domain entities, but no business handler exists yet.
        // Until one ships with its own schema and live permission checks, keep them off the
        // generic queue so an unimplemented worker can never blind-write inventory records.
        'category',
        'categories',
        'unit',
        'units',
        'product',
        'products',
        'product_unit',
        'product_units',
        'product_batch',
        'product_batches',
        'supplier',
        'suppliers',
        'stock_balance',
        'stock_balances',
        'stock_movement',
        'stock_movements',
        'stock_adjustment',
        'stock_adjustments',
        // Phase 3 POS, sales, payments, customers, and debts tables remain server-validated.
        // Clinical records never enter the generic unimplemented sync outbox.
        'patient',
        'patients',
        'patient_vitals',
        'consultation',
        'consultations',
        'prescription',
        'prescriptions',
        'prescription_items',
        'prescription_dispensing',
        'prescription_dispensing_allocations',
        'customer',
        'customers',
        'receipt_counter',
        'receipt_counters',
        'sale',
        'sales',
        'sale_item',
        'sale_items',
        'sale_item_allocation',
        'sale_item_allocations',
        'sale_payment',
        'sale_payments',
        'sale_reversal',
        'sale_reversals',
        'sale_reversal_item',
        'sale_reversal_items',
        'customer_debt',
        'customer_debts',
        'debt_payment',
        'debt_payments',
      ].includes(op.entityType)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['entityType'],
        message:
          'Authentication, configuration and internal records must not use the business outbox.',
      });
    }
  });
export type SyncOperation = z.infer<typeof operationSchema>;
/** Stable fingerprints include the complete envelope, not just a mutable payload. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Only JSON values can be fingerprinted.');
  return result;
}
export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
