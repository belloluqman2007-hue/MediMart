import { sha256 } from '@medimart/shared';
import type { Database } from './connection';
import { ledgerSql, migrations, type Migration } from './migrations';
/** PRAGMA foreign_keys is a no-op inside a transaction, so migrations that rebuild a referenced table toggle it around the transaction. */
const setForeignKeys = (database: Database, enabled: boolean) =>
  database.run(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
/** What a `migrate()` call did, so callers can log and verify it without re-querying. */
export type MigrationOutcome = {
  /** Migrations applied by this call (0 when the database was already current). */
  applied: number;
  /** Schema version after the call. */
  version: number;
};

export async function migrate(
  database: Database,
  plan: readonly Migration[] = migrations,
): Promise<MigrationOutcome> {
  if (plan.some((entry, index) => entry.version !== index + 1))
    throw new Error('Migrations must be contiguous and ordered from version 1.');
  const checksums = await Promise.all(
    plan.map((m) => sha256(`${m.version}\n${m.name}\n${m.statements.join('\n')}\n`)),
  );
  // A migration that rebuilds a referenced table must run with enforcement suspended; the plan
  // still verifies integrity with PRAGMA foreign_key_check before it commits.
  const pending = await pendingMigrations(database, plan.length);
  const suspend = plan.slice(pending).some((migration) => migration.requiresForeignKeysOff);
  if (suspend) await setForeignKeys(database, false);
  try {
    return await runPlan(database, plan, checksums);
  } finally {
    if (suspend) await setForeignKeys(database, true);
  }
}

/** How many migrations the database has already applied (0 when the ledger does not exist). */
async function pendingMigrations(database: Database, total: number) {
  try {
    const rows = await database.all<{ version: number }>(
      'SELECT version FROM database_migrations ORDER BY version',
    );
    return rows.length > total ? total : rows.length;
  } catch {
    return 0;
  }
}

async function runPlan(
  database: Database,
  plan: readonly Migration[],
  checksums: readonly string[],
): Promise<MigrationOutcome> {
  return database.transaction(async (tx) => {
    await tx.run(ledgerSql);
    const applied = await tx.all<{ version: number; name: string; checksum: string }>(
      'SELECT version,name,checksum FROM database_migrations ORDER BY version',
    );
    for (const [index, record] of applied.entries()) {
      if (
        record.version !== index + 1 ||
        !plan[index] ||
        record.checksum !== checksums[index] ||
        record.name !== plan[index].name
      ) {
        throw new Error(
          `Migration drift or unsupported database version at ${record.version}; refusing to open.`,
        );
      }
    }
    for (let i = applied.length; i < plan.length; i++) {
      const migration = plan[i]!;
      for (const statement of migration.statements) await tx.run(statement);
      await tx.run('INSERT INTO database_migrations (id,version,name,checksum) VALUES (?,?,?,?)', [
        crypto.randomUUID(),
        migration.version,
        migration.name,
        checksums[i]!,
      ]);
    }
    const violations = await tx.all('PRAGMA foreign_key_check');
    if (violations.length) throw new Error('Database foreign-key validation failed.');
    return { applied: plan.length - applied.length, version: plan.length };
  });
}
