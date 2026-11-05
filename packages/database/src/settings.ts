import { canonicalJson } from '@medimart/shared';
import type { SqlExecutor } from './connection';
export async function readSetting<T>(
  tx: SqlExecutor,
  key: string,
  scope = 'application',
  scopeId = 'global',
): Promise<T | null> {
  const row = (
    await tx.all<{ value_json: string }>(
      'SELECT value_json FROM application_settings WHERE key = ? AND scope = ? AND scope_id = ?',
      [key, scope, scopeId],
    )
  )[0];
  return row ? (JSON.parse(row.value_json) as T) : null;
}
export async function writeSetting(
  tx: SqlExecutor,
  key: string,
  value: unknown,
  options: { scope?: 'application' | 'device' | 'user'; scopeId?: string; actorId?: string } = {},
) {
  // Only non-secret configuration goes here. Native secrets belong in the OS keystore.
  await tx.run(
    `INSERT INTO application_settings (id,scope,scope_id,key,value_json,updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT (scope,scope_id,key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, version=application_settings.version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [
      crypto.randomUUID(),
      options.scope || 'application',
      options.scopeId || 'global',
      key,
      canonicalJson(value),
      options.actorId || null,
    ],
  );
}
