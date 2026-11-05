import { canonicalJson, operationSchema, sha256, type SyncOperation } from '@medimart/shared';
import type { Database, SqlExecutor } from './connection';
export class IdempotencyConflictError extends Error {
  constructor() {
    super('This operation ID already identifies a different operation. Nothing was overwritten.');
    this.name = 'IdempotencyConflictError';
  }
}
async function fingerprint(operation: SyncOperation) {
  return sha256(canonicalJson(operation));
}
/**
 * Future local mutations MUST enter through this unit of work. Business state and
 * the durable outbox entry commit together, or both roll back. No sync transport runs here.
 */
export async function commitLocalOperation(
  database: Database,
  input: SyncOperation,
  mutate: (tx: SqlExecutor) => Promise<void>,
): Promise<{ id: string; replay: boolean }> {
  const operation = operationSchema.parse(input);
  const json = canonicalJson(operation.payload);
  if (new TextEncoder().encode(json).byteLength > 262144)
    throw new Error('Operation payload exceeds 256 KiB.');
  const hash = await fingerprint(operation);
  return database.transaction(async (tx) => {
    const existing = (
      await tx.all<{ payload_hash: string }>('SELECT payload_hash FROM sync_queue WHERE id = ?', [
        operation.id,
      ])
    )[0];
    if (existing) {
      if (existing.payload_hash !== hash) throw new IdempotencyConflictError();
      return { id: operation.id, replay: true };
    }
    await mutate(tx);
    await tx.run(
      'INSERT INTO sync_queue (id,source_device_id,entity_id,entity_type,mutation,base_version,payload_json,payload_hash) VALUES (?,?,?,?,?,?,?,?)',
      [
        operation.id,
        operation.deviceId,
        operation.entityId,
        operation.entityType,
        operation.mutation,
        operation.baseVersion,
        json,
        hash,
      ],
    );
    return { id: operation.id, replay: false };
  });
}
/** A receipt check for a future server-side apply transaction, not an ingestion engine. */
export async function findReceipt(tx: SqlExecutor, operation: SyncOperation) {
  const parsed = operationSchema.parse(operation);
  const row = (
    await tx.all<{
      payload_hash: string;
      source_device_id: string;
      result_json: string;
      applied_version: number;
    }>(
      'SELECT payload_hash,source_device_id,result_json,applied_version FROM sync_receipts WHERE operation_id = ?',
      [parsed.id],
    )
  )[0];
  if (!row) return null;
  if (row.payload_hash !== (await fingerprint(parsed)) || row.source_device_id !== parsed.deviceId)
    throw new IdempotencyConflictError();
  return { result: JSON.parse(row.result_json) as unknown, appliedVersion: row.applied_version };
}
export async function recordReceipt(
  tx: SqlExecutor,
  operation: SyncOperation,
  result: Record<string, unknown>,
  appliedVersion: number,
) {
  const parsed = operationSchema.parse(operation);
  if (!Number.isSafeInteger(appliedVersion) || appliedVersion < 1)
    throw new Error('Invalid applied version.');
  const existing = await findReceipt(tx, parsed);
  if (existing) return existing;
  await tx.run(
    'INSERT INTO sync_receipts (id,operation_id,source_device_id,payload_hash,result_json,applied_version) VALUES (?,?,?,?,?,?)',
    [
      crypto.randomUUID(),
      parsed.id,
      parsed.deviceId,
      await fingerprint(parsed),
      canonicalJson(result),
      appliedVersion,
    ],
  );
  return { result, appliedVersion };
}
/** Capture both sides. Never silently resolve a conflict by last-write-wins. */
export async function recordConflict(
  tx: SqlExecutor,
  operation: SyncOperation,
  serverPayload: Record<string, unknown>,
  currentVersion: number,
) {
  const parsed = operationSchema.parse(operation);
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 1 ||
    currentVersion === parsed.baseVersion
  )
    throw new Error('A conflict requires a different, positive authoritative version.');
  await tx.run(
    'INSERT INTO sync_conflicts (id,operation_id,source_device_id,entity_id,entity_type,base_version,current_version,local_payload_json,server_payload_json) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      crypto.randomUUID(),
      parsed.id,
      parsed.deviceId,
      parsed.entityId,
      parsed.entityType,
      parsed.baseVersion,
      currentVersion,
      canonicalJson(parsed.payload),
      canonicalJson(serverPayload),
    ],
  );
}
