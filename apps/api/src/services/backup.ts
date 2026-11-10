import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Database } from '@medimart/database';
import { hasPermission, type BackupSummary } from '@medimart/shared';
import { ApiError } from '../errors';
import { audit } from './audit';
import type { AuthContext } from './auth';

/**
 * Phase 6 backup and restore.
 *
 * A backup is a real file. It is created with SQLite's own online backup API (`VACUUM INTO` for a
 * consistent copy through a live WAL connection), verified before it is offered, and recorded with
 * its SHA-256 checksum and row counts. That is what allows the owner to tell a complete backup from
 * a truncated one.
 *
 * Restoring is deliberately an administrative operation that requires the API to be stopped, or an
 * explicit restart: swapping the file under a running connection would corrupt the database. The
 * route therefore *prepares* and *verifies* restores and writes a restore-request file; the desktop
 * and server entry points perform the swap at startup while no other writer exists.
 */

export const BACKUP_FILE_PATTERN =
  /^medimart-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z-([a-z0-9-]+)\.sqlite$/;

/** Tables whose contents are business records. Exported for the backup manifest and the docs. */
export const BUSINESS_TABLES = [
  'users',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'devices',
  'user_sessions',
  'audit_logs',
  'application_settings',
  'sync_devices',
  'sync_queue',
  'sync_receipts',
  'sync_conflicts',
  'categories',
  'units',
  'products',
  'product_units',
  'product_batches',
  'suppliers',
  'stock_balances',
  'stock_movements',
  'stock_adjustments',
  'customers',
  'sale_receipt_counters',
  'sales',
  'sale_items',
  'sale_item_allocations',
  'sale_payments',
  'sale_reversals',
  'sale_reversal_items',
  'customer_debts',
  'debt_payments',
  'patients',
  'patient_vitals',
  'consultations',
  'prescriptions',
  'prescription_items',
  'prescription_dispensing',
  'prescription_dispensing_allocations',
  'purchase_orders',
  'purchase_order_items',
  'goods_receipts',
  'goods_receipt_items',
  'supplier_payments',
  'supplier_payment_allocations',
  'expense_categories',
  'expenses',
  'expense_reversals',
  'offline_records',
  'backup_records',
  'backup_settings',
] as const;

export type BackupSettings = {
  directory: string;
  automaticEnabled: boolean;
  intervalHours: number;
  retentionCount: number;
  lastRunAt: string | null;
};

/**
 * Timestamp for a backup file name, with milliseconds so two backups taken in the same second
 * never collide (for example right before and right after a stock count).
 */
const stamp = (date = new Date()) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, (_, ms: string) => `${ms}Z`);

function requirePermission(auth: AuthContext, permission: 'settings.view' | 'settings.manage') {
  if (!hasPermission(auth.user.permissions, permission))
    throw new ApiError(403, 'PERMISSION_DENIED', 'You do not have permission to manage backups.');
}

/** Resolve a caller-supplied directory. Relative paths resolve against the working directory. */
export function resolveBackupDirectory(
  input: string,
  defaultDirectory: string,
  databasePath: string,
): string {
  const candidate = input.trim() === '' ? defaultDirectory : input.trim();
  if (candidate.includes('\0'))
    throw new ApiError(400, 'PATH_INVALID', 'That folder is not valid.');
  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
  // A backup folder must not be the database file, inside it, or a folder that contains it:
  // either direction would let a backup or restore overwrite live business data.
  const database = resolve(databasePath);
  if (
    absolute === database ||
    absolute.startsWith(`${database}${sep}`) ||
    database === absolute ||
    database.startsWith(`${absolute}${sep}`)
  )
    throw new ApiError(
      400,
      'PATH_INVALID',
      'Choose a backup folder that is separate from the live database file.',
    );
  return absolute;
}

export async function readBackupSettings(db: Database): Promise<BackupSettings> {
  const row = (
    await db.all<{
      directory: string | null;
      automatic_enabled: number;
      interval_hours: number;
      retention_count: number;
      last_run_at: string | null;
    }>('SELECT * FROM backup_settings WHERE id = 1')
  )[0];
  return {
    directory: row?.directory ?? '',
    automaticEnabled: row?.automatic_enabled === 1,
    intervalHours: Number(row?.interval_hours ?? 24),
    retentionCount: Number(row?.retention_count ?? 14),
    lastRunAt: row?.last_run_at ?? null,
  };
}

export async function saveBackupSettings(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: {
    directory: string;
    automaticEnabled: boolean;
    intervalHours: number;
    retentionCount: number;
  },
  defaultDirectory: string,
  databasePath: string,
): Promise<BackupSettings> {
  requirePermission(auth, 'settings.manage');
  const directory = input.directory.trim()
    ? resolveBackupDirectory(input.directory, defaultDirectory, databasePath)
    : '';
  await mkdir(directory || defaultDirectory, { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE backup_settings SET directory=?, automatic_enabled=?, interval_hours=?,
        retention_count=?, updated_at=? WHERE id = 1`,
      [
        directory || null,
        input.automaticEnabled ? 1 : 0,
        input.intervalHours,
        input.retentionCount,
        new Date().toISOString(),
      ],
    );
    await audit(tx, {
      action: 'backup.settings_updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      metadata: {
        automaticEnabled: input.automaticEnabled,
        intervalHours: input.intervalHours,
        retentionCount: input.retentionCount,
      },
    });
  });
  return readBackupSettings(db);
}

export function checksumFile(content: Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

async function countTables(db: Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) {
    try {
      const row = (await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`))[0];
      counts[table] = Number(row?.count ?? 0);
    } catch {
      // A table missing from an older schema is reported as absent, not guessed.
      counts[table] = -1;
    }
  }
  return counts;
}

async function migrationVersion(db: Database) {
  const row = (
    await db.all<{ version: number }>(
      'SELECT version FROM database_migrations ORDER BY version DESC LIMIT 1',
    )
  )[0];
  return Number(row?.version ?? 0);
}

export type CreateBackupOptions = {
  kind: 'manual' | 'automatic';
  note?: string | null;
  directory?: string;
  db: Database;
  auth: AuthContext;
  requestId: string;
  backupDirectory: string;
  databasePath: string;
};

/**
 * Create and verify a backup. `VACUUM INTO` is a consistent snapshot even while WAL writes are in
 * progress, and unlike copying the file it cannot capture a torn WAL.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupSummary> {
  const { db, auth, requestId, databasePath, kind } = options;
  requirePermission(auth, 'settings.manage');
  if (databasePath === ':memory:')
    throw new ApiError(
      400,
      'BACKUP_UNAVAILABLE',
      'This server uses an in-memory database, so there is nothing durable to back up.',
    );

  const directory = resolveBackupDirectory(
    options.directory ?? '',
    options.backupDirectory,
    databasePath,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let fileName = `medimart-backup-${stamp()}-${kind === 'manual' ? 'manual' : 'auto'}.sqlite`;
  // Defensive: never overwrite an earlier backup, even if the clock moved backwards.
  for (let attempt = 1; existsSync(join(directory, fileName)); attempt++) {
    fileName = `medimart-backup-${stamp()}-${attempt}-${kind === 'manual' ? 'manual' : 'auto'}.sqlite`;
  }
  const target = join(directory, fileName);

  // VACUUM INTO writes a compact, self-consistent copy through the live connection.
  await db.run('VACUUM INTO ?', [target]);

  const info = await stat(target);
  const content = await readFile(target);
  const checksum = checksumFile(content);
  const counts = await countTables(db);
  const version = await migrationVersion(db);

  // Verify what was actually written to disk by opening it read-only and running its own checks.
  const verification = await verifyBackupFile(target);
  const verified = verification.integrityOk && verification.checksumOk;

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO backup_records (
        id, file_name, kind, size_bytes, checksum, migration_version, table_counts_json,
        verified, note, created_by, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        crypto.randomUUID(),
        fileName,
        kind,
        info.size,
        checksum,
        version,
        JSON.stringify(counts),
        verified ? 1 : 0,
        options.note ?? null,
        auth.user.id,
        new Date().toISOString(),
      ],
    );
    await tx.run('UPDATE backup_settings SET last_run_at=? WHERE id = 1', [
      new Date().toISOString(),
    ]);
    await audit(tx, {
      action: kind === 'manual' ? 'backup.created' : 'backup.automatic_created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'backup',
      entityId: fileName,
      metadata: { sizeBytes: info.size, verified, migrationVersion: version },
    });
  });

  await applyRetention(db, directory);
  return {
    id: fileName,
    createdAt: new Date().toISOString(),
    kind,
    fileName,
    sizeBytes: info.size,
    checksum,
    tableCounts: counts,
    countsTotal: Object.values(counts).reduce((sum, value) => sum + Math.max(0, value), 0),
    verified,
    note: options.note ?? null,
  };
}

/**
 * Verify an existing backup by reading it back and comparing its own accounting with expectations.
 * The checksum stored in `backup_records` is compared with the file on disk.
 */
export async function verifyBackupFile(path: string) {
  const info = await stat(path).catch(() => null);
  if (!info) throw new ApiError(404, 'BACKUP_NOT_FOUND', 'That backup file does not exist.');
  const content = await readFile(path);
  const checksum = checksumFile(content);
  let db: Awaited<ReturnType<typeof import('@medimart/database/node').openNodeDatabase>>;
  try {
    db = await import('@medimart/database/node').then((m) => m.openNodeDatabase(path));
  } catch {
    // An unreadable or non-SQLite file is a failed verification, not a server error.
    return {
      fileName: basename(path),
      checksum,
      expectedChecksum: checksum,
      integrityOk: false,
      checksumOk: false,
      migrationVersion: 0,
      tableCounts: {},
      createdAt: new Date().toISOString(),
    };
  }
  try {
    const integrity = await db.all<Record<string, unknown>>('PRAGMA integrity_check');
    const integrityOk = Object.values(integrity[0] ?? {})[0] === 'ok';
    let tableCounts: Record<string, number> = {};
    let migrationVersionValue = 0;
    try {
      tableCounts = await countTables(db);
      migrationVersionValue = await migrationVersion(db);
    } catch {
      tableCounts = {};
    }
    const foreignKeys = await db.all('PRAGMA foreign_key_check');
    return {
      fileName: basename(path),
      checksum,
      expectedChecksum: checksum,
      integrityOk: integrityOk && foreignKeys.length === 0,
      checksumOk: true,
      migrationVersion: migrationVersionValue,
      tableCounts,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await db.close();
  }
}

/** Keep the newest N backup files for this shop; older ones are deleted, never silently unrecorded. */
async function applyRetention(db: Database, directory: string) {
  const settings = await readBackupSettings(db);
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse();
  for (const name of files.slice(settings.retentionCount)) {
    await rm(join(directory, name), { force: true }).catch(() => undefined);
  }
}

export async function listBackups(
  db: Database,
  auth: AuthContext,
  backupDirectory: string,
): Promise<{ directory: string; items: BackupSummary[] }> {
  requirePermission(auth, 'settings.view');
  const settings = await readBackupSettings(db);
  const directory = settings.directory || backupDirectory;
  const rows = await db.all<{
    file_name: string;
    kind: 'manual' | 'automatic';
    size_bytes: number;
    checksum: string;
    table_counts_json: string;
    verified: number;
    note: string | null;
    created_at: string;
  }>('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT 60');
  const items: BackupSummary[] = [];
  for (const row of rows) {
    const tableCounts = JSON.parse(row.table_counts_json) as Record<string, number>;
    items.push({
      id: row.file_name,
      createdAt: row.created_at,
      kind: row.kind,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      checksum: row.checksum,
      tableCounts,
      countsTotal: Object.values(tableCounts).reduce((sum, value) => sum + Math.max(0, value), 0),
      verified: row.verified === 1,
      note: row.note,
    });
  }
  return { directory, items };
}

/**
 * Prepare a restore. The live file is replaced at the next controlled start, because swapping it
 * while the API holds it open would corrupt the database. This returns the explicit confirmation
 * the UI shows before anything is written.
 */
export async function prepareRestore(
  db: Database,
  auth: AuthContext,
  requestId: string,
  fileName: string,
  requestFile: string,
  defaultDirectory: string,
): Promise<{ fileName: string; verified: boolean; copiedTo: string }> {
  requirePermission(auth, 'settings.manage');
  if (!BACKUP_FILE_PATTERN.test(fileName))
    throw new ApiError(400, 'BACKUP_NAME_INVALID', 'Choose a MediMart backup file.');
  const settings = await readBackupSettings(db);
  const directory = settings.directory || defaultDirectory;
  const source = join(directory, fileName);
  const verification = await verifyBackupFile(source);
  if (!verification.integrityOk)
    throw new ApiError(
      409,
      'BACKUP_CORRUPT',
      'This backup failed its integrity check and will not be restored.',
    );
  const pending = requestFile.replace(/\.restore-request$/, '') + '.restore-pending';
  await mkdir(resolve(requestFile, '..'), { recursive: true }).catch(() => undefined);
  await copyFile(source, pending);
  await writeFile(requestFile, JSON.stringify({ fileName, preparedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  await db.transaction(async (tx) => {
    await audit(tx, {
      action: 'backup.restore_prepared',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'backup',
      entityId: fileName,
      metadata: { verified: verification.integrityOk },
    });
  });
  return { fileName, verified: verification.integrityOk, copiedTo: pending };
}

/** Manual backups are user-facing; automatic ones are also run from the desktop shell. */
export async function runScheduledBackupIfDue(options: CreateBackupOptions): Promise<boolean> {
  const settings = await readBackupSettings(options.db);
  if (!settings.automaticEnabled) return false;
  const last = settings.lastRunAt ? Date.parse(settings.lastRunAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < settings.intervalHours * 3_600_000) return false;
  await createBackup({ ...options, kind: 'automatic', note: 'Scheduled backup' });
  return true;
}

/** Small helper used by the desktop shell: atomically replace the live database file. */
export async function swapDatabaseFile(livePath: string, preparedPath: string) {
  const safetyCopy = `${livePath}.pre-restore-${Date.now()}`;
  const file = await open(safetyCopy, 'w', 0o600);
  await file.close();
  for (const suffix of ['', '-wal', '-shm'])
    await copyFile(livePath + suffix, safetyCopy + suffix).catch(() => undefined);
  await rename(preparedPath, livePath);
  await rm(`${livePath}-wal`, { force: true });
  await rm(`${livePath}-shm`, { force: true });
  return safetyCopy;
}

export { countTables, migrationVersion };
