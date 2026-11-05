# Database foundation

## Storage and versions

Central SQLite is opened through `better-sqlite3`. The runtime tested in this checkout reports SQLite **3.53.4**. Android requests SQLCipher via `@capacitor-community/sqlite` 8.1.1 (its native dependency declares SQLCipher **4.17.0**); its on-device engine has **not** been exercised here.

Both adapters enable foreign keys, WAL, `synchronous=FULL`, and a 5-second busy timeout. The central file and newly created files/directories receive restrictive POSIX permissions. For production, protect the containing directory, disk, OS account, and backups; server SQLite is **not encrypted by this adapter**.

## Migration plan

`packages/database/src/migrations.ts` defines ordered SQL statements shared by both runtimes. A transactional bootstrap creates `database_migrations`, then applies:

| Version | Name                                    | Responsibility                                                                                                        |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1       | `identity_security_and_settings`        | Accounts, RBAC, devices, sessions, audit, application settings and indexes                                            |
| 2       | `offline_outbox_receipts_and_conflicts` | Per-device cursors, durable operations, receipts, conflict evidence and indexes                                       |
| 3       | `least_privilege_role_seeds`            | Seven roles, 25 permission codes, explicit grants; **no user accounts**                                               |
| 4       | `inventory_core`                        | Products, categories, units, suppliers, batches, balances, ledger, adjustments; 17 indexes and 4 append-only triggers |
| 5       | `inventory_seeds`                       | 14 inventory permissions, role grants, 11 units and 11 example categories                                             |

The entire pending plan runs in a serialized `BEGIN IMMEDIATE` transaction. Each ledger entry has a UUID, version, name, SHA-256 checksum, and application timestamp. The runner checks contiguous versions, names and checksums, rejects newer/unknown databases, and checks foreign-key integrity before commit. Failed DDL and ledger writes roll back together.

`seed-v1.ts` is an **immutable historical snapshot**, intentionally independent of the live permission catalog. Editing a released migration, its helpers, or its snapshot is a breaking change. Add version 6+ for changes. There is no automatic destructive downgrade/reset command.

## The 14 Phase 1 tables

| Table                  | Main responsibility / invariants                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                | UUID, normalized unique case-insensitive email, full name, Argon2id hash, active/disabled status, lockout counters, version, timestamps, soft-deletion marker    |
| `roles`                | UUID, unique stable code, human-readable name, system-role flag                                                                                                  |
| `permissions`          | UUID, unique capability code, description                                                                                                                        |
| `user_roles`           | UUID, user/role/assigner foreign keys, unique `(user_id, role_id)`                                                                                               |
| `role_permissions`     | UUID, role/permission foreign keys, unique grant pair                                                                                                            |
| `devices`              | Installation UUID, name/platform/status, hashed secret and pairing code, expiry/attempts, approver and timestamps                                                |
| `user_sessions`        | UUID, user/device foreign keys, unique hashed token, transport, fixed expiry, last seen, revocation; bearer transport requires a device                          |
| `audit_logs`           | UUID, actor/device references, action/entity/correlation identifiers, JSON metadata and creation time; UPDATE/DELETE blocked by triggers                         |
| `application_settings` | UUID, scoped key/value JSON, version and audit timestamps; unique scope/scope-ID/key                                                                             |
| `database_migrations`  | UUID, unique positive version, name/checksum/application time                                                                                                    |
| `sync_devices`         | UUID, unique device foreign key, future authority/cursor fields, push/pull timestamps, protocol version                                                          |
| `sync_queue`           | Operation UUID as primary key, source-device/entity UUIDs, mutation/base version, bounded JSON, complete-envelope hash, status, attempts, retry/error timestamps |
| `sync_receipts`        | UUID plus globally unique operation UUID, source-device/hash, result JSON and applied version                                                                    |
| `sync_conflicts`       | UUID plus unique operation UUID, source/device/entity identifiers, base/current versions, both payloads, status and explicit resolution fields                   |

All tables use SQLite `STRICT` typing. Primary keys and sync-envelope operation/entity IDs check UUID layout, hexadecimal characters, version and variant; foreign keys validate their references. Foreign keys protect references; indexes cover session lookup/expiry, user/role joins, audit chronology/actors/entities, queue retry state and conflict/device lookup.

`users.password_hash` is nullable **only to leave room for non-authenticating local profile mirrors**. The central registration service always creates an Argon2id hash. Login explicitly rejects profiles without a hash. Password hashes must never be synchronized to devices through the business queue.

All stored timestamps are UTC ISO-8601 strings. Mutating services explicitly update `updated_at`. No monetary business table is created in Phase 1. The shared money contract permits only safe integers in **kobo**; future monetary columns must use `INTEGER` (never `REAL`), appropriate range/typing checks, and domain-specific validation. The generic JSON envelope is not a replacement for domain schemas.

## Inventory tables (Phase 2, 9 tables)

| Table               | Main responsibility / invariants                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units`             | Unique unit code, name, symbol, `is_system`; built-in units are protected from rename/delete                                                                                             |
| `categories`        | Self-referencing parent, `kind` (`pharmacy`/`minimart`), unique name per parent, cycle protection in the service layer                                                                   |
| `suppliers`         | Contact and business details, notes, status; deactivated rather than deleted                                                                                                             |
| `products`          | UUID, type, status, unique non-empty SKU/barcode (case-insensitive), category and base-unit FKs, `CHECK (selling >= purchase)`, created/updated by                                       |
| `product_units`     | Per-product conversion factors, unique `(product_id, unit_id)`, `CHECK (factor >= 2)`, never equal to the base unit                                                                      |
| `product_batches`   | Batch number, manufacturing/expiry dates, received and remaining quantity, cost per unit, supplier FK, recorded timestamp, unique `(product_id, batch_number)`, `CHECK (remaining >= 0)` |
| `stock_balances`    | Cached balance per product/batch with a version counter; never authoritative                                                                                                             |
| `stock_movements`   | Append-only ledger with `CHECK (new_balance = previous_balance + quantity)`, unique `operation_id`, reason, user, device and reference IDs                                               |
| `stock_adjustments` | One row per adjustment with direction, reason and permission evidence                                                                                                                    |

Total: **23 tables**. Money columns are INTEGER kobo; quantities are INTEGER base units. The ledger
is the source of truth and `stock_balances` is a cache verified by `/api/inventory/reconciliation`.
Migrations v4/v5 only add objects and rows, so applying them to an existing Phase 1 database
preserves every existing record.

## Queue and conflict contract

- Create: `baseVersion = 0`.
- Update/delete: `baseVersion >= 1`, representing the authoritative version originally read.
- `commitLocalOperation` validates the envelope, limits UTF-8 payloads to 256 KiB, computes a deterministic SHA-256 fingerprint, and commits callback + queue entry together.
- Exact UUID/content retries are no-ops; UUID/content collisions throw without overwrite.
- `findReceipt`/`recordReceipt` are intended to run inside a future authoritative apply transaction. Receipts bind operation, device and fingerprint.
- `recordConflict` stores both local and authoritative payloads. Unique operation IDs protect evidence against silent replacement. It does not choose a winner or mutate the entity.
- Foundation table names and common internal aliases cannot be operation entity types. This defensive check does not authorize a callback or validate a future domain payload: the future worker must use an explicit business-handler allowlist, domain schemas and live permissions.
- Queue statuses prepare for future processing; **no code currently advances/retries/sends business operations**.

## Settings and secret separation

- Browser business name: central `application_settings`.
- Native installation ID and central URL: local `application_settings`, device scope.
- Native session token and registration secret: secure-storage plugin, keyed by installation + server origin.
- SQLCipher passphrase: SQLite plugin's Keystore-protected encryption-secret store.
- Bootstrap token: server environment only.
- Server session/device/pairing secrets: one-way hashes only.

## Backup and recovery boundaries

There is no operational backup/restore feature yet. Do **not** copy only a live `.sqlite` file while WAL transactions are active. A future backup service must use SQLite's online-backup API or a controlled stop/checkpoint/copy procedure, encrypt and authenticate backups, and test restore/migration compatibility.

For development inspection, stop the API cleanly before copying its database files. Never delete, rename, or reset a populated application database to bypass a migration error. Investigate drift against the exact released code and retain an offline copy of the original files.

Android cloud backup and device transfer are disabled/excluded to prevent copying identity or an encrypted database without its Keystore keys. Device loss, uninstall, app-data clearing and key loss are **not recoverable through Phase 1**. A key-recovery/backup procedure is a release prerequisite before storing real business records.
