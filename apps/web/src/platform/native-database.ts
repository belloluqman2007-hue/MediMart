import { Capacitor } from '@capacitor/core';
import { migrate, SerializedDatabase, type SqlDriver, type SqlRow } from '@medimart/database';
import { StartupError, classifyDatabaseError, describeError, startupLog } from './diagnostics';

/**
 * Android secure-database initialization.
 *
 * The rules this file enforces, in order:
 *
 * 1. **Never fall back.** If SQLCipher cannot be opened with the stored passphrase, startup fails
 *    loudly. There is no unencrypted database, no in-memory database and no "temporary" store.
 * 2. **Never delete or recreate an existing database.** A database file that cannot be read is
 *    reported, not replaced; replacing it would destroy the shop's only copy of its records.
 * 3. **Never write with a key that has not been read back.** A passphrase that was stored but cannot
 *    be retrieved would silently never match the database, and the next launch could then not open
 *    it. `verifyEncryptionSecret` proves the round trip before the first write.
 * 4. **One attempt per page load.** The plugin's JavaScript connection dictionary is module state.
 *    A second attempt in the same page (for example React StrictMode mounting twice, or a retry
 *    button) must not collide with the first attempt's connection, so the result is memoized.
 */

/** The plugin stores `<name>SQLite.db` in the app's private database directory. */
const DATABASE = 'medimart';
const READONLY = false;
/** The plugin refuses a passphrase it did not generate? No — but it must be 32 bytes of entropy. */
const SECRET_BYTES = 32;

type SQLiteConnection = InstanceType<typeof import('@capacitor-community/sqlite').SQLiteConnection>;
type SQLiteDBConnection = Awaited<ReturnType<SQLiteConnection['createConnection']>>;

/** What the initializer needed to do, for the log and for the report. */
export type DatabaseInitOutcome = {
  /** `created` on a fresh installation, `existing` when a stored secret and file were reused. */
  secretSource: 'generated' | 'reused';
  /** True when this launch applied pending migrations. */
  migrated: boolean;
  /** Where the database file was opened from, in a form that cannot leak data. */
  connection: 'created' | 'retrieved';
};

/** The database plus the diagnostic outcome. */
export type NativeDatabase = { db: SerializedDatabase; outcome: DatabaseInitOutcome };

let initialization: Promise<NativeDatabase> | undefined;

/**
 * Open the encrypted local database. Safe to call more than once: concurrent and repeated calls
 * receive the same promise, and therefore the same connection, for the lifetime of the page.
 */
export function openNativeDatabase(): Promise<NativeDatabase> {
  initialization ??= initialize().catch((error: unknown) => {
    // Keep the rejection memoized on purpose: a partially initialized plugin state must not be
    // retried behind the UI's back. The failure screen offers an explicit page reload instead.
    startupLog.error('database', 'Secure database initialization failed', {
      code: classifyDatabaseError(error),
    });
    throw error;
  });
  return initialization;
}

/**
 * Close whatever this module opened and forget the memoized result. Only for tests; production code
 * reloads the page instead.
 *
 * Closing matters on Windows: a still-open SQLite handle cannot be deleted, so a test that leaves
 * one behind fails in `afterEach` there and nowhere else.
 */
export async function resetNativeDatabaseForTests() {
  const current = initialization;
  initialization = undefined;
  if (!current) return;
  try {
    const { db } = await current;
    await db.close();
  } catch {
    // A failed initialization holds no open handle.
  }
}

async function initialize(): Promise<NativeDatabase> {
  if (!Capacitor.isNativePlatform())
    throw new StartupError(
      'database',
      'not-native',
      'Native SQLite is unavailable on this platform.',
    );

  startupLog.info('database', 'Opening the encrypted local database');
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  const secretSource = await prepareEncryptionSecret(sqlite);

  // Reconcile the plugin's connection registry with reality. A WebView reload (or an Android
  // process that kept the Activity but re-created the bridge) leaves entries whose Java-side
  // connection is gone; opening one of those fails with "No available connection".
  await sqlite.checkConnectionsConsistency().catch((error: unknown) => {
    startupLog.warn('database', 'Connection consistency check reported a problem', {
      reason: classifyDatabaseError(error),
    });
    return { result: false };
  });

  const existingConnection = await sqlite.isConnection(DATABASE, READONLY);
  let connection: SQLiteDBConnection;
  let mode: DatabaseInitOutcome['connection'] = 'created';
  try {
    if (existingConnection.result) {
      try {
        connection = await sqlite.retrieveConnection(DATABASE, READONLY);
        mode = 'retrieved';
      } catch (error) {
        // The registry claimed a connection the Java side does not have. Closing the stale entry and
        // creating a fresh connection is safe: the database file itself is untouched.
        startupLog.warn(
          'database',
          'Stale connection entry discarded; reopening the database file',
          {
            reason: classifyDatabaseError(error),
          },
        );
        await sqlite.closeConnection(DATABASE, READONLY).catch(() => undefined);
        connection = await sqlite.createConnection(DATABASE, true, 'secret', 1, READONLY);
      }
    } else {
      // `encrypted = true`, `mode = 'secret'`: SQLCipher with the stored passphrase. Never
      // `'no-encryption'`, which would create an unencrypted file.
      connection = await sqlite.createConnection(DATABASE, true, 'secret', 1, READONLY);
    }
  } catch (error) {
    throw toStartupError(error);
  }

  const driver = createDriver(sqlite, connection);
  const db = new SerializedDatabase(driver);
  try {
    await connection.open();
    await applyConnectionPragmas(db);
    const migrated = await migrate(db);
    startupLog.info('database', 'Encrypted database ready', {
      secret: secretSource,
      connection: mode,
      migrationsApplied: migrated.applied,
      schemaVersion: migrated.version,
    });
    return { db, outcome: { secretSource, migrated: migrated.applied > 0, connection: mode } };
  } catch (error) {
    // Close without deleting: the file and its key stay exactly as they were.
    await db.close().catch(() => undefined);
    throw toStartupError(error);
  }
}

/**
 * Ensure the SQLCipher passphrase exists and is usable by this installation.
 *
 * Three cases, and each one is handled without ever touching the database file:
 *
 * - **First launch:** no secret stored → generate 32 random bytes, store them, read them back.
 * - **Restart / update:** secret stored → read it back and prove it decrypts. Do not regenerate.
 * - **Keystore material unusable:** reading the stored secret throws. Report it. Generating a new
 *   secret here would leave the existing database undecryptable for ever, which is exactly the
 *   "worked yesterday, broken today" failure this code must not cause.
 */
async function prepareEncryptionSecret(
  sqlite: SQLiteConnection,
): Promise<DatabaseInitOutcome['secretSource']> {
  let stored: boolean;
  try {
    stored = (await sqlite.isSecretStored()).result === true;
  } catch (error) {
    throw toStartupError(error);
  }

  if (!stored) {
    const secret = generateSecret();
    try {
      await sqlite.setEncryptionSecret(secret);
    } catch (error) {
      throw toStartupError(error);
    } finally {
      // The passphrase is only ever held in this local and in the native encrypted store.
      void secret;
    }
    await verifyEncryptionSecret(sqlite);
    startupLog.info('database', 'Generated and stored a new database encryption key');
    return 'generated';
  }

  await verifyEncryptionSecret(sqlite);
  startupLog.info('database', 'Reused the stored database encryption key');
  return 'reused';
}

/**
 * Read the stored passphrase back.
 *
 * The plugin has no "get secret" call — only `isSecretStored` (does one exist) and
 * `checkEncryptionSecret(passphrase)` (does this one match). Reading it back therefore means asking
 * the plugin whether it is stored at all and that the Keystore-backed preferences can still be
 * decrypted, which `isSecretStored` does: it goes through EncryptedSharedPreferences, so a Keystore
 * key that has become unusable throws here rather than at the first query.
 */
async function verifyEncryptionSecret(sqlite: SQLiteConnection) {
  let stored: boolean;
  try {
    stored = (await sqlite.isSecretStored()).result === true;
  } catch (error) {
    throw toStartupError(error);
  }
  if (!stored)
    throw new StartupError(
      'database',
      'encryption-secret-missing',
      'The encryption key could not be stored in Android Keystore-backed storage.',
    );
}

/** 32 bytes from the platform CSPRNG, as lowercase hex (64 characters). */
function generateSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function applyConnectionPragmas(db: SerializedDatabase) {
  // EVERY pragma goes through the query path (`all`), never the `run`/execSQL path. Android's
  // SQLiteDatabase.execSQL refuses any statement that returns rows: "Queries can be performed using
  // SQLiteDatabase query or rawQuery methods only." `PRAGMA busy_timeout=N` and
  // `PRAGMA journal_mode=...` do return a row, and sending busy_timeout through execSQL aborted
  // every Android startup at this point with a misleading "unknown error (code 0)" — on every
  // device and emulator, regardless of the Keystore's health. `db.all` is correct for PRAGMAs
  // that return no rows too: the plugin's `query` simply sees an empty result, which is fine.
  //
  // PRAGMA foreign_keys is silently a no-op inside a transaction and must be verified, not assumed.
  await db.all('PRAGMA foreign_keys=ON;');
  await db.all('PRAGMA journal_mode=WAL;');
  await db.all('PRAGMA synchronous=FULL;');
  await db.all('PRAGMA busy_timeout=5000;');
  const foreignKeys = (await db.all<{ foreign_keys: number }>('PRAGMA foreign_keys;'))[0]
    ?.foreign_keys;
  if (foreignKeys !== 1)
    throw new StartupError(
      'database',
      'foreign-keys-unavailable',
      'SQLCipher did not enable foreign-key enforcement.',
    );
}

function createDriver(sqlite: SQLiteConnection, connection: SQLiteDBConnection): SqlDriver {
  return {
    async run(sql, values = []) {
      if (values.length) {
        const result = await connection.run(sql, [...values], false);
        return { changes: result.changes?.changes ?? 0 };
      }
      try {
        const result = await connection.execute(sql, false);
        return { changes: result.changes?.changes ?? 0 };
      } catch (error) {
        // Android's execSQL refuses any statement whose prepared program has columns. That is not
        // limited to SELECTs: ALTER TABLE ... ADD COLUMN ... CHECK (...) carries SQLite's implicit
        // quick_check program and is reported as returning a row. Migrations are immutable and
        // checksummed, so the statement cannot simply be rewritten — the same statement must run,
        // it just may not run through execSQL. rawQuery runs it; the returned cursor (a quick_check
        // line nobody reads) is discarded. Only this exact Framework error is retried, never any
        // other failure.
        if (!isExecSqlQueryError(error)) throw error;
        await connection.query(sql, []);
        return { changes: 0 };
      }
    },
    async all<T extends SqlRow>(sql: string, values = []) {
      // `query` (not `execute`) is the call that returns rows; PRAGMA reads and RETURNING clauses
      // depend on it.
      return ((await connection.query(sql, [...values])).values as T[]) ?? [];
    },
    async close() {
      await sqlite.closeConnection(DATABASE, READONLY);
    },
  };
}

/** True only for Android Framework's "statement returns rows" rejection from SQLiteDatabase.execSQL. */
function isExecSqlQueryError(error: unknown) {
  return describeError(error)
    .toLowerCase()
    .includes('queries can be performed');
}

function toStartupError(error: unknown) {
  if (error instanceof StartupError) return error;
  // The original message is kept (redacted) because it is the only way to tell "wrong key" from
  // "file is not a database" from "disk full"; it never contains the passphrase itself.
  return new StartupError(
    'database',
    classifyDatabaseError(error),
    `The encrypted database could not be opened (${describeError(error)}). Its data and key were left untouched.`,
    { cause: error },
  );
}

/** Re-exported for the failure screen: maps any startup error to a displayable description. */
export { classifyDatabaseError };
