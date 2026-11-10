import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Database } from '@medimart/database';
import {
  offlineEnvelopeSchema,
  offlineQuerySchema,
  type OfflineSummary,
  type SyncBatchResponse,
  type SyncStatusResponse,
} from '@medimart/shared';
import { ApiError } from '../errors';
import { requireAuth, requirePermission } from '../middleware/security';
import type { AuthService, AuthContext } from '../services/auth';
import {
  ingestBatch,
  listOfflineRecords,
  offlineSummary,
  syncStatus,
  SYNC_BATCH_LIMIT,
} from '../services/sync';
import {
  createBackup,
  listBackups,
  prepareRestore,
  readBackupSettings,
  saveBackupSettings,
  verifyBackupFile,
  BACKUP_FILE_PATTERN,
} from '../services/backup';
import type { ApiConfig } from '../config';
import { join } from 'node:path';

export type SyncRouteContext = {
  backupDirectory: string;
  databasePath: string;
  restoreRequestFile: string;
};

const batchSchema = z.strictObject({
  envelopes: z.array(offlineEnvelopeSchema).min(1).max(SYNC_BATCH_LIMIT),
});

const backupsettingsSchema = z.strictObject({
  directory: z.string().trim().max(400),
  automaticEnabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  retentionCount: z.number().int().min(1).max(90),
});

const createBackupSchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
  directory: z.string().trim().max(400).optional(),
});

const restoreSchema = z.strictObject({
  fileName: z.string().trim().max(200).regex(BACKUP_FILE_PATTERN, 'Choose a MediMart backup file.'),
});

const meta = (req: Request) => ({
  auth: req.auth! as AuthContext,
  requestId: req.requestId,
});

export function registerSyncRoutes(
  app: Express,
  db: Database,
  auth: AuthService,
  config: ApiConfig,
  context: SyncRouteContext,
) {
  const authenticated = requireAuth(auth);
  const guard = (permission: Parameters<typeof requirePermission>[0]) => [
    authenticated,
    requirePermission(permission),
  ];

  // --- Offline capture and synchronization -----------------------------------

  /** Status of this installation's queue. Browser administrators see the whole queue. */
  app.get('/api/sync/status', ...guard('sync.view'), async (req, res) => {
    const { auth: who } = meta(req);
    if (who.deviceId) {
      const result: SyncStatusResponse = await syncStatus(db, who);
      res.json(result);
      return;
    }
    // Browser sessions have no installation identity, so report the central queue instead of lying.
    const rows = await db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM offline_records GROUP BY status',
    );
    const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
    res.json({
      protocolVersion: 1,
      implemented: true,
      serverTime: new Date().toISOString(),
      pending: byStatus.get('pending') ?? 0,
      synced: byStatus.get('applied') ?? 0,
      rejected: byStatus.get('rejected') ?? 0,
      conflict: byStatus.get('conflict') ?? 0,
      device: null,
    });
  });

  app.get('/api/sync/summary', ...guard('sync.view'), async (req, res) => {
    const summary: OfflineSummary = await offlineSummary(db, meta(req).auth);
    res.json(summary);
  });

  app.get('/api/sync/records', ...guard('sync.view'), async (req, res) => {
    const query = offlineQuerySchema.parse(req.query);
    res.json(await listOfflineRecords(db, meta(req).auth, query));
  });

  app.post('/api/sync/push', ...guard('sync.manage'), async (req, res) => {
    const { envelopes } = batchSchema.parse(req.body);
    const { auth: who, requestId } = meta(req);
    const result: SyncBatchResponse = await ingestBatch(db, who, requestId, envelopes);
    res.json(result);
  });

  // --- Backup and restore -----------------------------------------------------

  app.get('/api/backups', ...guard('settings.view'), async (req, res) => {
    const settings = await readBackupSettings(db);
    const result = await listBackups(db, meta(req).auth, context.backupDirectory);
    res.json({ ...result, settings, defaultDirectory: context.backupDirectory });
  });

  app.put('/api/backups/settings', ...guard('settings.manage'), async (req, res) => {
    const input = backupsettingsSchema.parse(req.body);
    const { auth: who, requestId } = meta(req);
    res.json(
      await saveBackupSettings(
        db,
        who,
        requestId,
        input,
        context.backupDirectory,
        context.databasePath,
      ),
    );
  });

  app.post('/api/backups', ...guard('settings.manage'), async (req, res) => {
    const input = createBackupSchema.parse(req.body ?? {});
    const { auth: who, requestId } = meta(req);
    res.status(201).json(
      await createBackup({
        db,
        auth: who,
        requestId,
        kind: 'manual',
        note: input.note ?? null,
        directory: input.directory,
        backupDirectory: context.backupDirectory,
        databasePath: context.databasePath,
      }),
    );
  });

  /** Verify a stored backup on demand: integrity, checksum and row counts. */
  app.get('/api/backups/:fileName/verify', ...guard('settings.view'), async (req, res) => {
    const fileName = z.string().regex(BACKUP_FILE_PATTERN).parse(req.params.fileName);
    const settings = await readBackupSettings(db);
    const directory = settings.directory || context.backupDirectory;
    const record = (
      await db.all<{ checksum: string }>(
        'SELECT checksum FROM backup_records WHERE file_name = ?',
        [fileName],
      )
    )[0];
    const result = await verifyBackupFile(join(directory, fileName));
    res.json({ ...result, expectedChecksum: record?.checksum ?? result.checksum, directory });
  });

  /**
   * Prepare a restore. The file is copied beside the live database and verified; the swap happens
   * on the next controlled restart. Nothing is overwritten while the API is running.
   */
  app.post('/api/backups/restore', ...guard('settings.manage'), async (req, res) => {
    const { fileName } = restoreSchema.parse(req.body);
    const { auth: who, requestId } = meta(req);
    if (config.environment === 'production' && !config.managedDesktop)
      throw new ApiError(
        409,
        'RESTORE_REQUIRES_STOP',
        'Stop the MediMart server, then restore the backup file from your backup folder.',
      );
    res
      .status(202)
      .json(
        await prepareRestore(
          db,
          who,
          requestId,
          fileName,
          context.restoreRequestFile,
          context.backupDirectory,
        ),
      );
  });

  void BACKUP_FILE_PATTERN;
}
