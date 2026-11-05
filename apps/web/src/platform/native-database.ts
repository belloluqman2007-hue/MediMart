import { Capacitor } from '@capacitor/core';
import { migrate, SerializedDatabase, type SqlDriver, type SqlRow } from '@medimart/database';
/** Imported only on native platforms. No IndexedDB/localStorage imitation of SQLite. */
export async function openNativeDatabase() {
  if (!Capacitor.isNativePlatform())
    throw new Error('Native SQLite is unavailable on this platform.');
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  if (!(await sqlite.isSecretStored()).result) {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    // The plugin protects its SQLCipher secret with Android Keystore-backed storage.
    await sqlite.setEncryptionSecret(key);
  }
  const consistent = await sqlite.checkConnectionsConsistency();
  const exists = await sqlite.isConnection('medimart', false);
  const connection =
    consistent.result && exists.result
      ? await sqlite.retrieveConnection('medimart', false)
      : await sqlite.createConnection('medimart', true, 'secret', 1, false);
  const driver: SqlDriver = {
    async run(sql, values = []) {
      const result = values.length
        ? await connection.run(sql, [...values], false)
        : await connection.execute(sql, false);
      return { changes: result.changes?.changes ?? 0 };
    },
    async all<T extends SqlRow>(sql: string, values = []) {
      return ((await connection.query(sql, [...values])).values as T[]) ?? [];
    },
    async close() {
      await sqlite.closeConnection('medimart', false);
    },
  };
  const db = new SerializedDatabase(driver);
  try {
    await connection.open();
    await connection.execute('PRAGMA foreign_keys=ON;', false);
    await connection.query('PRAGMA journal_mode=WAL;');
    await connection.execute('PRAGMA synchronous=FULL;', false);
    await connection.execute('PRAGMA busy_timeout=5000;', false);
    const foreignKeys = (await db.all<{ foreign_keys: number }>('PRAGMA foreign_keys;'))[0]
      ?.foreign_keys;
    if (foreignKeys !== 1) throw new Error('Native SQLite foreign-key enforcement is unavailable.');
    await migrate(db);
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}
