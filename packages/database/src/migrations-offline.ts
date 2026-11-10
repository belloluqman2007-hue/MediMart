import type { Migration } from './migrations';
import { timestamp, uuid } from './schema-helpers';

/**
 * Phase 6 schema: Android offline capture, synchronization receipts and backup history.
 *
 * Design boundaries:
 * - An offline record is an *intention*. The central server applies it through the same domain
 *   services used online, inside one transaction, and keeps the authoritative outcome on the
 *   record row. A re-sent record is answered from that recorded outcome and never applied twice.
 * - `offline_records` is append-only apart from its own sync-status columns, so a rejected record
 *   stays visible for review instead of being deleted.
 * - Backups are real files on disk; this table records what was written, its checksum and its
 *   integrity result so an owner can tell a good backup from a truncated one.
 *
 * Released migrations v1–v11 are never edited.
 */
const offlineCapture: Migration = {
  version: 12,
  name: 'offline_capture_sync_receipts_and_backups',
  statements: [
    `CREATE TABLE offline_records (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} NOT NULL UNIQUE,
      ${uuid('device_id')} NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
      record_type TEXT NOT NULL CHECK (record_type IN ('sale','customer','customer_repayment','stock_receipt','purchase_order','expense')),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      ${uuid('captured_by')} NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      client_created_at TEXT NOT NULL,
      client_date TEXT NOT NULL CHECK (client_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json) AND length(envelope_json) <= 262144),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','conflict')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      result_reference TEXT,
      receipt_number TEXT,
      error_code TEXT,
      error_message TEXT,
      received_at ${timestamp},
      -- Set only when the server actually applied the record; a rejection keeps it NULL.
      applied_at TEXT,
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_offline_records_status ON offline_records(status,created_at)',
    'CREATE INDEX idx_offline_records_device ON offline_records(device_id,status)',
    `CREATE TRIGGER offline_records_no_delete BEFORE DELETE ON offline_records BEGIN SELECT RAISE(ABORT, 'offline records are append-only'); END`,
    `CREATE TRIGGER offline_records_no_content_update BEFORE UPDATE OF operation_id,envelope_json,payload_hash,device_id ON offline_records BEGIN SELECT RAISE(ABORT, 'offline record contents are append-only'); END`,
    `CREATE TABLE backup_records (
      ${uuid('id')} PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE CHECK (length(file_name) BETWEEN 3 AND 200),
      kind TEXT NOT NULL CHECK (kind IN ('manual','automatic')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      migration_version INTEGER NOT NULL CHECK (migration_version > 0),
      table_counts_json TEXT NOT NULL CHECK (json_valid(table_counts_json)),
      verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
      note TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_backup_records_created ON backup_records(created_at)',
    `CREATE TRIGGER backup_records_no_delete BEFORE DELETE ON backup_records BEGIN SELECT RAISE(ABORT, 'backup records are append-only'); END`,
    `CREATE TRIGGER backup_records_no_update BEFORE UPDATE ON backup_records BEGIN SELECT RAISE(ABORT, 'backup records are append-only'); END`,
    `CREATE TABLE backup_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      directory TEXT,
      automatic_enabled INTEGER NOT NULL DEFAULT 1 CHECK (automatic_enabled IN (0,1)),
      interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 168),
      retention_count INTEGER NOT NULL DEFAULT 14 CHECK (retention_count BETWEEN 1 AND 90),
      last_run_at TEXT,
      updated_at ${timestamp}
    ) STRICT`,
    'INSERT INTO backup_settings (id,automatic_enabled,interval_hours,retention_count) VALUES (1,1,24,14)',
  ],
};

export const offlineMigrations: readonly Migration[] = [offlineCapture];
