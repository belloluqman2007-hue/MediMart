import type { Database } from './connection';

/** Aggregate diagnostics only. Never return operation payloads or error details. */
export async function readSyncStatus(db: Database, deviceId?: string) {
  return db.transaction(async (tx) => {
    const where = deviceId ? ' WHERE source_device_id = ?' : '';
    const args = deviceId ? [deviceId] : [];
    const rows = await tx.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM sync_queue${where} GROUP BY status`,
      args,
    );
    const counts = { pending: 0, inFlight: 0, acknowledged: 0, failed: 0, conflicted: 0 };
    for (const row of rows) {
      switch (row.status) {
        case 'pending':
          counts.pending = row.count;
          break;
        case 'in_flight':
          counts.inFlight = row.count;
          break;
        case 'acknowledged':
          counts.acknowledged = row.count;
          break;
        case 'failed':
          counts.failed = row.count;
          break;
        case 'conflict':
          counts.conflicted = row.count;
          break;
      }
    }
    const conflictWhere = deviceId ? "status = 'open' AND source_device_id = ?" : "status = 'open'";
    const openConflicts = (
      await tx.all<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sync_conflicts WHERE ${conflictWhere}`,
        args,
      )
    )[0]!.count;
    return { ...counts, openConflicts };
  });
}
