import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SerializedDatabase, type SqlDriver, type SqlRow } from './connection';
export function openNodeDatabase(filename: string): SerializedDatabase {
  if (filename !== ':memory:')
    mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const sqlite = new BetterSqlite3(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('busy_timeout = 5000');
  const driver: SqlDriver = {
    async run(sql, values = []) {
      return { changes: sqlite.prepare(sql).run(...values).changes };
    },
    async all<T extends SqlRow>(sql: string, values = []) {
      return sqlite.prepare(sql).all(...values) as T[];
    },
    async close() {
      sqlite.close();
    },
  };
  return new SerializedDatabase(driver);
}
