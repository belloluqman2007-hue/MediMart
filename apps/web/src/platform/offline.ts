import {
  canonicalJson,
  OFFLINE_SCHEMA_VERSION,
  sha256,
  type OfflineEnvelope,
  type OfflineRecord,
  type OfflineSummary,
  type PosProduct,
  type SyncBatchResponse,
} from '@medimart/shared';
import { readSetting, writeSetting } from '@medimart/database';
import type { ApiClient } from '../lib/api';
import { ApiClientError } from '../lib/api';
import type { Runtime } from './types';

/**
 * Device-side offline capture.
 *
 * Everything here runs on the Android device against its own encrypted SQLite database:
 * 1. The POS catalogue is cached so a clerk can still search products and prices while the shop
 *    computer is unreachable. The cache is a *convenience snapshot*, never an authority.
 * 2. A sale captured offline is written to `offline_records` with a fingerprint, in one local
 *    transaction, and given a provisional receipt number. It survives app restarts.
 * 3. When the connection returns, records are pushed in small batches. The server's answer decides
 *    each record's fate; the device only mirrors that answer.
 *
 * There is deliberately no "trusted local price" and no offline credit limit decision: the server
 * re-validates every record and rejects what it cannot verify. A rejection is shown to the clerk
 * instead of being silently discarded.
 */

export const CATALOG_CACHE_KEY = 'pos_catalog_cache';

export type CachedCatalog = {
  savedAt: string;
  shopName: string;
  products: PosProduct[];
};

export type LocalOfflineRecord = {
  operationId: string;
  recordType: OfflineRecord['recordType'];
  status: 'pending' | 'applied' | 'rejected' | 'conflict';
  createdAt: string;
  clientDate: string;
  receiptNumber: string | null;
  reference: string | null;
  message: string | null;
  envelope: OfflineEnvelope;
};

export function offlineAvailable(runtime: Runtime) {
  return runtime.native && runtime.database !== null;
}

/** The catalogue snapshot used when the shop computer cannot be reached. */
export async function readCachedCatalog(runtime: Runtime): Promise<CachedCatalog | null> {
  if (!offlineAvailable(runtime)) return null;
  const value = await readSetting<CachedCatalog>(
    runtime.database!,
    CATALOG_CACHE_KEY,
    'device',
    runtime.deviceId ?? 'this-installation',
  );
  if (!value || !Array.isArray(value.products) || value.products.length === 0) return null;
  return value;
}

/** Refresh the offline catalogue while online. A failure here must never break the online POS. */
export async function cacheCatalog(runtime: Runtime, shopName: string, products: PosProduct[]) {
  if (!offlineAvailable(runtime) || products.length === 0) return;
  await writeSetting(
    runtime.database!,
    CATALOG_CACHE_KEY,
    { savedAt: new Date().toISOString(), shopName, products: products.slice(0, 800) },
    { scope: 'device', scopeId: runtime.deviceId ?? 'this-installation' },
  );
}

function provisionalReceipt(sequence: number) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `OFF-${day}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Save one offline record in a single local transaction. The operation ID is generated here, once,
 * and reused by every retry so the server can recognise a duplicate after a dropped response.
 */
export async function saveOfflineRecord(
  runtime: Runtime,
  record: OfflineRecord,
  capturedByUserId: string,
): Promise<{ operationId: string; receiptNumber: string | null; envelope: OfflineEnvelope }> {
  if (!offlineAvailable(runtime) || !runtime.deviceId)
    throw new Error('Offline storage is only available inside the MediMart Android application.');
  const db = runtime.database!;
  const now = new Date();
  const operationId = crypto.randomUUID();
  const base: Omit<OfflineEnvelope, 'fingerprint'> = {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    operationId,
    deviceId: runtime.deviceId,
    clientCreatedAt: now.toISOString(),
    clientDate: now.toISOString().slice(0, 10),
    capturedByUserId,
    record,
  };
  const fingerprint = await sha256(canonicalJson(base));
  const envelope: OfflineEnvelope = { ...base, fingerprint };

  return db.transaction(async (tx) => {
    const count = (
      await tx.all<{ count: number }>('SELECT COUNT(*) AS count FROM offline_records')
    )[0]!.count;
    const receiptNumber =
      record.recordType === 'sale' ? provisionalReceipt(Number(count) + 1) : null;
    await tx.run(
      `INSERT INTO offline_records (
        id, operation_id, device_id, record_type, schema_version, captured_by, client_created_at,
        client_date, envelope_json, payload_hash, status, attempts, receipt_number, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`,
      [
        crypto.randomUUID(),
        operationId,
        runtime.deviceId,
        record.recordType,
        OFFLINE_SCHEMA_VERSION,
        capturedByUserId,
        envelope.clientCreatedAt,
        envelope.clientDate,
        canonicalJson(envelope),
        fingerprint,
        receiptNumber,
        now.toISOString(),
      ],
    );
    return { operationId, receiptNumber, envelope };
  });
}

export async function listLocalOfflineRecords(
  runtime: Runtime,
  limit = 100,
): Promise<LocalOfflineRecord[]> {
  if (!offlineAvailable(runtime)) return [];
  const rows = await runtime.database!.all<{
    operation_id: string;
    record_type: LocalOfflineRecord['recordType'];
    status: LocalOfflineRecord['status'];
    created_at: string;
    client_date: string;
    receipt_number: string | null;
    result_reference: string | null;
    error_message: string | null;
    envelope_json: string;
  }>(
    `SELECT operation_id,record_type,status,created_at,client_date,receipt_number,
      result_reference,error_message,envelope_json
     FROM offline_records ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    operationId: row.operation_id,
    recordType: row.record_type,
    status: row.status,
    createdAt: row.created_at,
    clientDate: row.client_date,
    receiptNumber: row.receipt_number,
    reference: row.result_reference,
    message: row.error_message,
    envelope: JSON.parse(row.envelope_json) as OfflineEnvelope,
  }));
}

export async function localOfflineSummary(runtime: Runtime): Promise<OfflineSummary> {
  if (!offlineAvailable(runtime))
    return {
      pending: 0,
      syncedToday: 0,
      rejected: 0,
      conflict: 0,
      lastSyncedAt: null,
      lastError: null,
    };
  const rows = await runtime.database!.all<{ status: string; count: number }>(
    'SELECT status, COUNT(*) AS count FROM offline_records GROUP BY status',
  );
  const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
  const today = new Date().toISOString().slice(0, 10);
  const syncedToday = (
    await runtime.database!.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM offline_records WHERE status='applied' AND applied_at >= ?",
      [`${today}T00:00:00.000Z`],
    )
  )[0]!.count;
  const lastError = (
    await runtime.database!.all<{ error_message: string | null }>(
      "SELECT error_message FROM offline_records WHERE status!='pending' AND error_message IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
  )[0];
  return {
    pending: byStatus.get('pending') ?? 0,
    syncedToday: Number(syncedToday),
    rejected: byStatus.get('rejected') ?? 0,
    conflict: byStatus.get('conflict') ?? 0,
    lastSyncedAt: null,
    lastError: lastError?.error_message ?? null,
  };
}

export type PushOutcome = {
  sent: number;
  applied: number;
  duplicates: number;
  rejected: number;
  conflicts: number;
  remaining: number;
  offline: boolean;
};

/**
 * Push pending records and mirror the server's verdict locally. Stops early when the connection
 * drops, leaving the rest pending rather than marking anything as synchronized by assumption.
 */
export async function pushOfflineRecords(
  runtime: Runtime,
  api: ApiClient,
  limit = 25,
): Promise<PushOutcome> {
  const outcome: PushOutcome = {
    sent: 0,
    applied: 0,
    duplicates: 0,
    rejected: 0,
    conflicts: 0,
    remaining: 0,
    offline: false,
  };
  if (!offlineAvailable(runtime)) return outcome;
  const db = runtime.database!;

  const pending = await db.all<{ envelope_json: string; operation_id: string }>(
    "SELECT envelope_json,operation_id FROM offline_records WHERE status='pending' ORDER BY created_at ASC LIMIT ?",
    [limit],
  );
  if (pending.length === 0) return outcome;

  let response: SyncBatchResponse;
  try {
    response = await api.request<SyncBatchResponse>('/api/sync/push', 'POST', {
      envelopes: pending.map((row) => JSON.parse(row.envelope_json) as OfflineEnvelope),
    });
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'CONNECTION_FAILED') {
      outcome.offline = true;
      return outcome;
    }
    throw error;
  }
  outcome.sent = pending.length;

  await db.transaction(async (tx) => {
    for (const accepted of response.accepted) {
      await tx.run(
        `UPDATE offline_records SET status='applied', applied_at=?, result_reference=?,
          receipt_number=COALESCE(?,receipt_number), error_code=NULL, error_message=NULL
         WHERE operation_id=?`,
        [
          new Date().toISOString(),
          accepted.reference,
          accepted.receiptNumber,
          accepted.operationId,
        ],
      );
      if (accepted.outcome === 'applied') outcome.applied += 1;
      else outcome.duplicates += 1;
    }
    for (const rejected of response.rejected) {
      await tx.run(
        "UPDATE offline_records SET status='rejected', error_code=?, error_message=? WHERE operation_id=?",
        [rejected.code, rejected.message, rejected.operationId],
      );
      outcome.rejected += 1;
    }
    for (const conflict of response.conflicts) {
      await tx.run(
        "UPDATE offline_records SET status='conflict', error_code=?, error_message=? WHERE operation_id=?",
        [conflict.code, conflict.message, conflict.operationId],
      );
      outcome.conflicts += 1;
    }
  });
  outcome.remaining = Number(response.remaining);
  return outcome;
}

/**
 * Re-queue a rejected record after a supervisor has dealt with the cause. The envelope and its
 * fingerprint are preserved, so the server can still recognise the original intention.
 */
export async function retryOfflineRecord(runtime: Runtime, operationId: string) {
  if (!offlineAvailable(runtime)) return;
  await runtime.database!.run(
    "UPDATE offline_records SET status='pending', attempts=0, error_code=NULL, error_message=NULL WHERE operation_id=? AND status IN ('rejected','conflict')",
    [operationId],
  );
}
