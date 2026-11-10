import { inventoryMigrations } from './migrations-inventory';
import { timestamp, uuid } from './schema-helpers';
import { permissions, roleCodes, roleLabels, rolePermissions } from './seed-v1';
export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
  /**
   * Set when the migration rebuilds a table that other tables reference (SQLite cannot drop a
   * CHECK constraint in place). Foreign-key enforcement is suspended for the plan and
   * `PRAGMA foreign_key_check` must still pass before the transaction commits.
   */
  requiresForeignKeysOff?: boolean;
}
export const ledgerSql = `CREATE TABLE IF NOT EXISTS database_migrations (
  ${uuid('id')} PRIMARY KEY, version INTEGER NOT NULL UNIQUE CHECK (version > 0),
  name TEXT NOT NULL, checksum TEXT NOT NULL CHECK (length(checksum) = 64), applied_at ${timestamp}
) STRICT`;
const identity: Migration = {
  version: 1,
  name: 'identity_security_and_settings',
  statements: [
    `CREATE TABLE users (
      ${uuid('id')} PRIMARY KEY, full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
      email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
      password_hash TEXT CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0), locked_until TEXT,
      password_changed_at ${timestamp}, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at ${timestamp}, updated_at ${timestamp}, deleted_at TEXT
    ) STRICT`,
    `CREATE TABLE roles (
      ${uuid('id')} PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)), created_at ${timestamp}, updated_at ${timestamp}
    ) STRICT`,
    `CREATE TABLE permissions (
      ${uuid('id')} PRIMARY KEY, code TEXT NOT NULL UNIQUE, description TEXT NOT NULL, created_at ${timestamp}
    ) STRICT`,
    `CREATE TABLE user_roles (
      ${uuid('id')} PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
      assigned_by TEXT REFERENCES users(id) ON DELETE RESTRICT, created_at ${timestamp}, UNIQUE (user_id,role_id)
    ) STRICT`,
    `CREATE TABLE role_permissions (
      ${uuid('id')} PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, created_at ${timestamp},
      UNIQUE (role_id,permission_id)
    ) STRICT`,
    `CREATE TABLE devices (
      ${uuid('id')} PRIMARY KEY, name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
      platform TEXT NOT NULL CHECK (platform IN ('android','desktop','web')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
      secret_hash TEXT CHECK (secret_hash IS NULL OR length(secret_hash) = 64),
      pairing_code_hash TEXT CHECK (pairing_code_hash IS NULL OR length(pairing_code_hash) = 64),
      pairing_expires_at TEXT, pairing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (pairing_attempts >= 0),
      registered_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      approved_by TEXT REFERENCES users(id) ON DELETE RESTRICT, approved_at TEXT,
      last_seen_at TEXT, created_at ${timestamp}, updated_at ${timestamp},
      CHECK ((pairing_code_hash IS NULL AND pairing_expires_at IS NULL) OR (pairing_code_hash IS NOT NULL AND pairing_expires_at IS NOT NULL))
    ) STRICT`,
    `CREATE TABLE user_sessions (
      ${uuid('id')} PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      transport TEXT NOT NULL CHECK (transport IN ('cookie','bearer')),
      user_agent TEXT NOT NULL DEFAULT '', created_at ${timestamp}, last_seen_at ${timestamp},
      expires_at TEXT NOT NULL, revoked_at TEXT,
      CHECK (expires_at > created_at), CHECK (transport != 'bearer' OR device_id IS NOT NULL)
    ) STRICT`,
    `CREATE TABLE audit_logs (
      ${uuid('id')} PRIMARY KEY, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100), entity_type TEXT, entity_id TEXT,
      request_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
      created_at ${timestamp}
    ) STRICT`,
    `CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit logs are append-only'); END`,
    `CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit logs are append-only'); END`,
    `CREATE TABLE application_settings (
      ${uuid('id')} PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('application','device','user')),
      scope_id TEXT NOT NULL DEFAULT 'global', key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)), version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, created_at ${timestamp}, updated_at ${timestamp},
      UNIQUE (scope,scope_id,key)
    ) STRICT`,
    'CREATE INDEX idx_user_roles_role ON user_roles(role_id)',
    'CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_id)',
    'CREATE INDEX idx_sessions_user_active ON user_sessions(user_id,revoked_at,expires_at)',
    'CREATE INDEX idx_sessions_device ON user_sessions(device_id)',
    'CREATE INDEX idx_devices_status ON devices(status,created_at)',
    'CREATE INDEX idx_audit_created ON audit_logs(created_at,id)',
    'CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id,created_at)',
    'CREATE INDEX idx_audit_device ON audit_logs(device_id)',
    'CREATE INDEX idx_audit_entity ON audit_logs(entity_type,entity_id)',
  ],
};
const sync: Migration = {
  version: 2,
  name: 'offline_outbox_receipts_and_conflicts',
  statements: [
    `CREATE TABLE sync_devices (
      ${uuid('id')} PRIMARY KEY, device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE RESTRICT,
      server_id TEXT, last_pull_cursor TEXT, last_push_at TEXT, last_pull_at TEXT,
      protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version > 0),
      created_at ${timestamp}, updated_at ${timestamp}
    ) STRICT`,
    `CREATE TABLE sync_queue (
      ${uuid('id')} PRIMARY KEY, source_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
      ${uuid('entity_id')}, entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 2 AND 64),
      mutation TEXT NOT NULL CHECK (mutation IN ('create','update','delete')),
      base_version INTEGER NOT NULL CHECK (base_version >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 262144),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','acknowledged','conflict','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at TEXT, last_error TEXT,
      created_at ${timestamp}, updated_at ${timestamp},
      CHECK ((mutation = 'create' AND base_version = 0) OR (mutation != 'create' AND base_version > 0))
    ) STRICT`,
    `CREATE TABLE sync_receipts (
      ${uuid('id')} PRIMARY KEY, ${uuid('operation_id')} UNIQUE,
      source_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      applied_version INTEGER NOT NULL CHECK (applied_version > 0), received_at ${timestamp}
    ) STRICT`,
    `CREATE TABLE sync_conflicts (
      ${uuid('id')} PRIMARY KEY, ${uuid('operation_id')} UNIQUE,
      source_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
      ${uuid('entity_id')}, entity_type TEXT NOT NULL,
      base_version INTEGER NOT NULL CHECK (base_version >= 0), current_version INTEGER NOT NULL CHECK (current_version > 0),
      local_payload_json TEXT NOT NULL CHECK (json_valid(local_payload_json)),
      server_payload_json TEXT NOT NULL CHECK (json_valid(server_payload_json)),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
      resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
      resolved_by TEXT REFERENCES users(id) ON DELETE RESTRICT, resolved_at TEXT, created_at ${timestamp},
      CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL) OR (status != 'open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
    ) STRICT`,
    'CREATE INDEX idx_sync_queue_due ON sync_queue(status,next_attempt_at,created_at)',
    'CREATE INDEX idx_sync_queue_device ON sync_queue(source_device_id)',
    'CREATE INDEX idx_sync_queue_entity ON sync_queue(entity_type,entity_id)',
    'CREATE INDEX idx_sync_receipts_device ON sync_receipts(source_device_id,received_at)',
    'CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(status,created_at)',
    'CREATE INDEX idx_sync_conflicts_device ON sync_conflicts(source_device_id)',
  ],
};
const roleId = (index: number) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const permissionId = (index: number) =>
  `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const seeds: string[] = [];
roleCodes.forEach((role, i) =>
  seeds.push(
    `INSERT INTO roles (id,code,name) VALUES ('${roleId(i)}','${role}','${roleLabels[role]}')`,
  ),
);
permissions.forEach((permission, i) =>
  seeds.push(
    `INSERT INTO permissions (id,code,description) VALUES ('${permissionId(i)}','${permission}','${permission.replace('.', ': ')}')`,
  ),
);
let grantIndex = 0;
roleCodes.forEach((role, i) =>
  rolePermissions[role].forEach((permission) => {
    seeds.push(
      `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('30000000-0000-4000-8000-${String(++grantIndex).padStart(12, '0')}','${roleId(i)}','${permissionId(permissions.indexOf(permission))}')`,
    );
  }),
);
/** Never edit a released migration: add a new version instead. Checksums detect drift. */
export const migrations: readonly Migration[] = [
  identity,
  sync,
  { version: 3, name: 'least_privilege_role_seeds', statements: seeds },
  ...inventoryMigrations,
];
