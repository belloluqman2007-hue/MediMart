import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitLocalOperation, migrate, readSyncStatus, recordConflict } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';

describe('read-only sync diagnostics', () => {
  it('reports all states per device, persists after restart and never alters the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'medimart-sync-status-'));
    const file = join(dir, 'test.sqlite');
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    let db = openNodeDatabase(file);
    try {
      await migrate(db);
      for (const id of [first, second])
        await db.run("INSERT INTO devices (id,name,platform) VALUES (?,'Device','android')", [id]);
      const statuses = ['pending', 'in_flight', 'acknowledged', 'failed', 'conflict'] as const;
      for (const status of statuses) {
        const id = crypto.randomUUID();
        await commitLocalOperation(
          db,
          {
            id,
            deviceId: first,
            entityId: crypto.randomUUID(),
            entityType: 'foundation_record',
            mutation: 'create',
            baseVersion: 0,
            payload: { secret: 'not returned' },
          },
          async () => {},
        );
        await db.run('UPDATE sync_queue SET status=? WHERE id=?', [status, id]);
      }
      await commitLocalOperation(
        db,
        {
          id: crypto.randomUUID(),
          deviceId: second,
          entityId: crypto.randomUUID(),
          entityType: 'foundation_record',
          mutation: 'create',
          baseVersion: 0,
          payload: {},
        },
        async () => {},
      );
      const conflict = {
        id: crypto.randomUUID(),
        deviceId: first,
        entityId: crypto.randomUUID(),
        entityType: 'foundation_record',
        mutation: 'update' as const,
        baseVersion: 1,
        payload: { note: 'private' },
      };
      await db.transaction(async (tx) =>
        recordConflict(tx, conflict, { note: 'server private' }, 2),
      );
      expect((await readSyncStatus(db, second)).openConflicts).toBe(0);
      const before = await db.all('SELECT * FROM sync_queue ORDER BY id');
      await db.close();
      db = openNodeDatabase(file);
      await migrate(db);
      expect(await readSyncStatus(db, first)).toEqual({
        pending: 1,
        inFlight: 1,
        acknowledged: 1,
        failed: 1,
        conflicted: 1,
        openConflicts: 1,
      });
      expect((await readSyncStatus(db, second)).pending).toBe(1);
      expect((await readSyncStatus(db)).pending).toBe(2);
      expect(await db.all('SELECT * FROM sync_queue ORDER BY id')).toEqual(before);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
