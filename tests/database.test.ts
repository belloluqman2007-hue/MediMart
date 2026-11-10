import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDatabase } from '@medimart/database/node';
import {
  commitLocalOperation,
  findReceipt,
  IdempotencyConflictError,
  migrate,
  migrations,
  readSetting,
  recordConflict,
  recordReceipt,
  SerializedDatabase,
  writeSetting,
  type Database,
} from '@medimart/database';
import {
  canonicalJson,
  moneyKoboSchema,
  operationSchema,
  type SyncOperation,
} from '@medimart/shared';
let db: Database;
const deviceId = crypto.randomUUID();
const op = (overrides: Partial<SyncOperation> = {}): SyncOperation => ({
  id: crypto.randomUUID(),
  deviceId,
  entityId: crypto.randomUUID(),
  entityType: 'foundation_record',
  mutation: 'create',
  baseVersion: 0,
  payload: { note: 'No business transactions in phase 1' },
  ...overrides,
});
beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db);
  await db.run('INSERT INTO devices (id,name,platform) VALUES (?,?,?)', [
    deviceId,
    'Test installation',
    'android',
  ]);
});
afterEach(async () => {
  await db.close();
});
describe('SQLite schema and migrations', () => {
  it('creates every requested table and seven roles without a default user', async () => {
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(tables.map((r) => r.name)).toEqual([
      'application_settings',
      'audit_logs',
      'categories',
      'customer_debts',
      'customers',
      'database_migrations',
      'debt_payments',
      'devices',
      'expense_categories',
      'expense_reversals',
      'expenses',
      'goods_receipt_items',
      'goods_receipts',
      'permissions',
      'product_batches',
      'product_units',
      'products',
      'purchase_order_items',
      'purchase_orders',
      'receipt_counters',
      'role_permissions',
      'roles',
      'sale_item_allocations',
      'sale_items',
      'sale_payments',
      'sale_reversal_items',
      'sale_reversals',
      'sales',
      'stock_adjustments',
      'stock_balances',
      'stock_movements',
      'supplier_payment_allocations',
      'supplier_payments',
      'suppliers',
      'sync_conflicts',
      'sync_devices',
      'sync_queue',
      'sync_receipts',
      'units',
      'user_roles',
      'user_sessions',
      'users',
    ]);
    expect((await db.all('SELECT * FROM roles')).length).toBe(7);
    expect(await db.all('SELECT * FROM users')).toHaveLength(0);
    expect((await db.all<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys).toBe(
      1,
    );
  });
  it('is repeatable and preserves existing records', async () => {
    await writeSetting(db, 'business_name', 'Test business');
    const before = await db.all('SELECT * FROM database_migrations');
    await migrate(db);
    expect(await db.all('SELECT * FROM database_migrations')).toEqual(before);
    expect(await readSetting(db, 'business_name')).toBe('Test business');
  });
  it('upgrades an older schema without losing data', async () => {
    const old = openNodeDatabase(':memory:');
    try {
      await migrate(old, migrations.slice(0, 1));
      await writeSetting(old, 'business_name', 'Preserved');
      await migrate(old);
      expect(await readSetting(old, 'business_name')).toBe('Preserved');
      expect(await old.all('SELECT * FROM database_migrations')).toHaveLength(migrations.length);
    } finally {
      await old.close();
    }
  });
  it('rejects checksum drift, gaps, and databases from a future version', async () => {
    await expect(
      migrate(db, [{ ...migrations[0]!, name: 'tampered' }, ...migrations.slice(1)]),
    ).rejects.toThrow('drift');
    await expect(migrate(db, migrations.slice(1))).rejects.toThrow('contiguous');
    await expect(migrate(db, migrations.slice(0, 2))).rejects.toThrow('unsupported');
  });
  it('rolls back a failed migration including DDL and ledger changes', async () => {
    await expect(
      migrate(db, [
        ...migrations,
        {
          version: 4,
          name: 'invalid',
          statements: ['CREATE TABLE must_rollback (id TEXT)', 'THIS IS NOT SQL'],
        },
      ]),
    ).rejects.toThrow();
    expect(await db.all("SELECT name FROM sqlite_master WHERE name='must_rollback'")).toHaveLength(
      0,
    );
    expect(await db.all('SELECT * FROM database_migrations')).toHaveLength(migrations.length);
  });
  it('enforces UUID shape, foreign keys, unique grants, and JSON validity', async () => {
    await expect(
      db.run("INSERT INTO devices (id,name,platform) VALUES ('bad','Test','android')"),
    ).rejects.toThrow();
    await expect(
      db.run(
        "INSERT INTO devices (id,name,platform) VALUES ('------------------------------------','Test','android')",
      ),
    ).rejects.toThrow();
    await expect(
      db.run('INSERT INTO user_roles (id,user_id,role_id) VALUES (?,?,?)', [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow();
    await expect(
      db.run(
        "INSERT INTO application_settings (id,scope,key,value_json) VALUES (?,'application','bad','{broken')",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow();
  });
  it('makes audit records append-only', async () => {
    await db.run("INSERT INTO audit_logs (id,action,request_id) VALUES (?,'test',?)", [
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]);
    await expect(db.run("UPDATE audit_logs SET action='hidden'")).rejects.toThrow('append-only');
    await expect(db.run('DELETE FROM audit_logs')).rejects.toThrow('append-only');
  });
  it('closes idempotently and rejects further access', async () => {
    await Promise.all([db.close(), db.close()]);
    await db.close();
    await expect(db.all('SELECT 1')).rejects.toThrow('closed');
  });
  it('closes a connection rather than accepting writes after a failed rollback', async () => {
    let closed = false;
    const broken = new SerializedDatabase({
      async run(sql) {
        if (sql === 'ROLLBACK') throw new Error('I/O failure');
        return { changes: 0 };
      },
      async all() {
        return [];
      },
      async close() {
        closed = true;
      },
    });
    await expect(
      broken.transaction(async () => {
        throw new Error('original failure');
      }),
    ).rejects.toThrow('rollback failed');
    expect(closed).toBe(true);
    await expect(broken.run('SELECT 1')).rejects.toThrow('closed');
  });
  it('serializes requests around asynchronous transactions', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = db.transaction(async (tx) => {
      await writeSetting(tx, 'state', 'uncommitted');
      started();
      await gate;
      throw new Error('rollback');
    });
    const rejection = expect(mutation).rejects.toThrow('rollback');
    await ready;
    const outside = readSetting(db, 'state');
    release();
    await rejection;
    expect(await outside).toBeNull();
  });
});
describe('durable outbox and synchronization primitives (no sync engine)', () => {
  it('commits a local mutation and an outbox entry together', async () => {
    const operation = op();
    await commitLocalOperation(db, operation, (tx) => writeSetting(tx, 'test_marker', 'committed'));
    expect(await readSetting(db, 'test_marker')).toBe('committed');
    expect(
      (
        await db.all<{ status: string; attempts: number }>('SELECT status,attempts FROM sync_queue')
      )[0],
    ).toEqual({ status: 'pending', attempts: 0 });
  });
  it('rolls back both halves if either the mutation or the queue write fails', async () => {
    await expect(
      commitLocalOperation(db, op(), async (tx) => {
        await writeSetting(tx, 'test_marker', 'bad');
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    await expect(
      commitLocalOperation(db, op({ deviceId: crypto.randomUUID() }), (tx) =>
        writeSetting(tx, 'test_marker', 'bad'),
      ),
    ).rejects.toThrow();
    expect(await readSetting(db, 'test_marker')).toBeNull();
    expect(await db.all('SELECT * FROM sync_queue')).toHaveLength(0);
  });
  it('deduplicates an exact replay and rejects changed payloads or identities', async () => {
    const operation = op({ payload: { b: 2, a: 1 } });
    let calls = 0;
    const mutation = async () => {
      calls++;
    };
    await commitLocalOperation(db, operation, mutation);
    expect(
      (await commitLocalOperation(db, { ...operation, payload: { a: 1, b: 2 } }, mutation)).replay,
    ).toBe(true);
    await expect(
      commitLocalOperation(db, { ...operation, entityId: crypto.randomUUID() }, mutation),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      commitLocalOperation(db, { ...operation, payload: { a: 2 } }, mutation),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(calls).toBe(1);
  });
  it('validates base versions, credentials separation, and payload size', async () => {
    expect(operationSchema.safeParse(op({ mutation: 'update', baseVersion: 0 })).success).toBe(
      false,
    );
    const internalTables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(internalTables).toHaveLength(42);
    for (const { name: entityType } of internalTables) {
      expect(operationSchema.safeParse(op({ entityType })).success, entityType).toBe(false);
    }
    for (const entityType of ['user', 'user_role', 'role_permission', 'session', 'setting']) {
      expect(operationSchema.safeParse(op({ entityType })).success, entityType).toBe(false);
    }
    await expect(
      commitLocalOperation(db, op({ payload: { big: 'x'.repeat(262145) } }), async () => {}),
    ).rejects.toThrow('256 KiB');
  });
  it('persists queued operations and identity over a database restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'medimart-'));
    const path = join(dir, 'local.sqlite');
    const operation = op();
    let disk = openNodeDatabase(path);
    try {
      await migrate(disk);
      await disk.run('INSERT INTO devices (id,name,platform) VALUES (?,?,?)', [
        deviceId,
        'Persistent phone',
        'android',
      ]);
      await commitLocalOperation(disk, operation, async () => {});
      await disk.close();
      disk = openNodeDatabase(path);
      await migrate(disk);
      expect(
        (
          await commitLocalOperation(disk, operation, async () => {
            throw new Error('must not apply twice');
          })
        ).replay,
      ).toBe(true);
      expect(await disk.all('SELECT id FROM devices WHERE id=?', [deviceId])).toHaveLength(1);
    } finally {
      await disk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('records receipts idempotently and rejects operation-ID collisions', async () => {
    const operation = op();
    await db.transaction((tx) => recordReceipt(tx, operation, { accepted: true }, 1));
    expect(await findReceipt(db, operation)).toEqual({
      result: { accepted: true },
      appliedVersion: 1,
    });
    await db.transaction((tx) => recordReceipt(tx, operation, { accepted: false }, 2));
    expect(await db.all('SELECT * FROM sync_receipts')).toHaveLength(1);
    await expect(
      findReceipt(db, { ...operation, deviceId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
  it('preserves both conflict versions without changing authoritative data', async () => {
    const operation = op({ mutation: 'update', baseVersion: 1, payload: { note: 'local' } });
    await db.transaction((tx) => recordConflict(tx, operation, { note: 'server' }, 2));
    const conflict = (
      await db.all<{ local_payload_json: string; server_payload_json: string; status: string }>(
        'SELECT local_payload_json,server_payload_json,status FROM sync_conflicts',
      )
    )[0]!;
    expect(JSON.parse(conflict.local_payload_json)).toEqual({ note: 'local' });
    expect(JSON.parse(conflict.server_payload_json)).toEqual({ note: 'server' });
    expect(conflict.status).toBe('open');
    await expect(
      db.transaction((tx) => recordConflict(tx, operation, { note: 'overwrite' }, 3)),
    ).rejects.toThrow();
  });
  it('has deterministic JSON and integer-only money contracts without financial calculations', () => {
    expect(canonicalJson({ z: 2, A: [3, { b: 1, a: 2 }] })).toBe('{"A":[3,{"a":2,"b":1}],"z":2}');
    expect(moneyKoboSchema.safeParse(1500).success).toBe(true);
    expect(moneyKoboSchema.safeParse(15.5).success).toBe(false);
    expect(moneyKoboSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});
