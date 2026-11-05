import { sha256 } from '@medimart/shared';
import type { Database } from './connection';
import { ledgerSql, migrations, type Migration } from './migrations';
export async function migrate(
  database: Database,
  plan: readonly Migration[] = migrations,
): Promise<void> {
  if (plan.some((entry, index) => entry.version !== index + 1))
    throw new Error('Migrations must be contiguous and ordered from version 1.');
  const checksums = await Promise.all(
    plan.map((m) => sha256(`${m.version}\n${m.name}\n${m.statements.join('\n')}\n`)),
  );
  await database.transaction(async (tx) => {
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
  });
}
