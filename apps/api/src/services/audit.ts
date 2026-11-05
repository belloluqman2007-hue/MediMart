import type { SqlExecutor } from '@medimart/database';
export type AuditEvent = {
  action: string;
  requestId: string;
  actorId?: string | null;
  deviceId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, string | number | boolean | string[]>;
};
export async function audit(tx: SqlExecutor, event: AuditEvent) {
  await tx.run(
    'INSERT INTO audit_logs (id,actor_user_id,device_id,action,entity_type,entity_id,request_id,metadata_json) VALUES (?,?,?,?,?,?,?,?)',
    [
      crypto.randomUUID(),
      event.actorId ?? null,
      event.deviceId ?? null,
      event.action,
      event.entityType ?? null,
      event.entityId ?? null,
      event.requestId,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
