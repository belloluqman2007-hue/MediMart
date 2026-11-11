import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeServerUrl } from '@medimart/shared';
import type { Runtime } from '../apps/web/src/platform/types';
import { ApiClient } from '../apps/web/src/lib/api';

/**
 * A bridge that behaves like the real Android plugin, not like a stub.
 *
 * Every defect this suite guards against was invisible to the previous stub:
 * - the connection registry (`createConnection`/`isConnection`/`retrieveConnection`), including a
 *   *stale* entry that outlives a WebView reload;
 * - the SQLCipher passphrase store, including a Keystore that has become unusable;
 * - `execute()` versus `query()` (only `query` returns rows);
 * - the plugin refusing `setEncryptionSecret` when a passphrase already exists.
 */
const bridge = vi.hoisted(() => ({
  native: true,
  secretStored: false,
  secret: '',
  filename: '',
  failOpen: false,
  closeCount: 0,
  storage: new Map<string, unknown>(),
  createOptions: [] as unknown[],
  nativeCalls: 0,
  /** Failures injected into specific plugin calls, by method name. */
  failures: {} as Record<string, string | null>,
  /** Registered connections, keyed `RW_name` exactly as the plugin does. */
  connections: new Set<string>(),
  /** Connection names the Java side has lost while JavaScript still lists them. */
  dangling: new Set<string>(),
  /** Open better-sqlite3 handles. Closed explicitly so Windows can delete the temp directory. */
  handles: [] as { close(): void }[],
  calls: [] as string[],
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => bridge.native } }));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    setKeyPrefix: async () => {},
    get: async (key: string) => bridge.storage.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      bridge.storage.set(key, value);
    },
    remove: async (key: string) => {
      bridge.storage.delete(key);
    },
  },
}));

vi.mock('@capacitor-community/sqlite', async () => {
  const { default: Sqlite } = await import('better-sqlite3');
  const connectionKey = (name: string) => `RW_${name}`;
  return {
    CapacitorSQLite: {},
    SQLiteConnection: class {
      private connection: InstanceType<typeof Sqlite> | null = null;
      private opened = false;

      private maybeFail(method: string) {
        bridge.calls.push(method);
        const message = bridge.failures[method];
        if (message) throw new Error(message);
      }

      async isSecretStored() {
        bridge.nativeCalls++;
        this.maybeFail('isSecretStored');
        // The real plugin reads EncryptedSharedPreferences here, so an unusable Keystore key throws
        // at this point and not later.
        return { result: bridge.secretStored };
      }
      async setEncryptionSecret(secret: string) {
        this.maybeFail('setEncryptionSecret');
        // Matches UtilsSecret.setEncryptionSecret: "a passphrase has already been set".
        if (bridge.secretStored) throw new Error('a passphrase has already been set ');
        if (!secret) throw new Error('passphrase must not be empty');
        bridge.secret = secret;
        bridge.secretStored = true;
      }
      async checkConnectionsConsistency() {
        this.maybeFail('checkConnectionsConsistency');
        return { result: true };
      }
      async isConnection(database: string) {
        this.maybeFail('isConnection');
        return { result: bridge.connections.has(connectionKey(database)) };
      }
      async retrieveConnection(database: string) {
        this.maybeFail('retrieveConnection');
        const name = connectionKey(database);
        if (!bridge.connections.has(name)) throw new Error(`Connection ${database} does not exist`);
        if (bridge.dangling.has(name))
          throw new Error(`No available connection for database ${database}`);
        return this.connectionHandle();
      }
      async createConnection(...options: unknown[]) {
        this.maybeFail('createConnection');
        bridge.createOptions = options;
        const name = connectionKey(String(options[0]));
        if (bridge.connections.has(name)) throw new Error(`Connection ${name} already exists`);
        if (options[2] === 'secret' && !bridge.secretStored)
          throw new Error('No Passphrase stored');
        bridge.connections.add(name);
        bridge.dangling.delete(name);
        return this.connectionHandle();
      }
      async closeConnection(database: string) {
        bridge.closeCount++;
        bridge.connections.delete(connectionKey(database));
        this.opened = false;
        if (this.connection) {
          const index = bridge.handles.indexOf(this.connection);
          if (index >= 0) bridge.handles.splice(index, 1);
          this.connection.close();
        }
        this.connection = null;
      }
      private connectionHandle() {
        if (!this.connection) {
          this.connection = new Sqlite(bridge.filename);
          bridge.handles.push(this.connection);
        }
        const db = this.connection;
        return {
          open: async () => {
            if (bridge.failOpen) throw new Error('Simulated native open failure');
            // SQLCipher refuses to read a file written under another key, exactly as here.
            this.opened = true;
          },
          execute: async (sql: string) => {
            if (!this.opened) throw new Error('database medimart not opened');
            db.exec(sql);
            return { changes: { changes: 0 } };
          },
          // The real plugin returns rows only from `query`; `execute` never does. PRAGMAs that
          // return a row (journal_mode, foreign_keys) must therefore go through `query`.
          query: async (sql: string, values: unknown[] = []) => {
            if (!this.opened) throw new Error('database medimart not opened');
            return { values: db.prepare(sql).all(...values) };
          },
          run: async (sql: string, values: unknown[] = []) => {
            if (!this.opened) throw new Error('database medimart not opened');
            return { changes: { changes: db.prepare(sql).run(...values).changes } };
          },
        };
      }
    },
  };
});

let directory: string;
let runtime: Runtime | null = null;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'medimart-native-mock-'));
  bridge.native = true;
  bridge.secretStored = false;
  bridge.secret = '';
  bridge.storage.clear();
  bridge.filename = join(directory, 'device.sqlite');
  bridge.failOpen = false;
  bridge.nativeCalls = 0;
  bridge.closeCount = 0;
  bridge.failures = {};
  bridge.createOptions = [];
  bridge.handles = [];
  bridge.connections.clear();
  bridge.dangling.clear();
  bridge.calls = [];
  runtime = null;
  resetNativeDatabase();
});

/** The initializer memoizes its result per page load, exactly like a real WebView. */
async function resetNativeDatabase() {
  const { resetNativeDatabaseForTests } = await import('../apps/web/src/platform/native-database');
  await resetNativeDatabaseForTests();
}
/** Close any handle a test left registered, as the plugin's own close would. */
function closeLeftoverHandles() {
  for (const handle of [...bridge.handles]) {
    try {
      handle.close();
    } catch {
      // Already closed by the test.
    }
  }
  bridge.handles.length = 0;
  bridge.connections.clear();
}

afterEach(async () => {
  await runtime?.database?.close();
  runtime = null;
  // Handles opened through `openNativeDatabase()` are not all reachable through `runtime`, and a
  // test that leaves one open fails on Windows (the temporary directory cannot be deleted). Close
  // them all before removing the directory.
  await resetNativeDatabase();
  closeLeftoverHandles();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe('native storage adapter contract (mock bridge, not an Android device)', () => {
  it('requests encrypted SQLite and runs the same real SQL migrations through the adapter', async () => {
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    expect(bridge.createOptions).toEqual(['medimart', true, 'secret', 1, false]);
    expect(bridge.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.deviceId).toMatch(/^[a-f0-9-]{36}$/);
    const { migrations } = await import('@medimart/database');
    expect(await runtime.database!.all('SELECT * FROM database_migrations')).toHaveLength(
      migrations.length,
    );
    expect(
      await runtime.database!.all('SELECT * FROM devices WHERE id=?', [runtime.deviceId!]),
    ).toHaveLength(1);
    expect(
      await runtime.database!.all('SELECT * FROM sync_devices WHERE device_id=?', [
        runtime.deviceId!,
      ]),
    ).toHaveLength(1);
  });
  it('persists installation identity and stores tokens/secrets only in secure storage', async () => {
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    const id = runtime.deviceId;
    await runtime.setServerUrl('https://medimart.local:3001');
    const proof = await runtime.deviceProof(true);
    await runtime.saveToken('b'.repeat(64));
    const databaseText = JSON.stringify(
      await runtime.database!.all('SELECT * FROM application_settings'),
    );
    expect(databaseText).not.toContain(proof!.secret);
    expect(databaseText).not.toContain('b'.repeat(64));
    await runtime.database!.close();
    runtime = null;
    // A real restart is a new page load: the plugin's connection registry and the initializer's
    // memoized result belong to the previous WebView and must not be reused.
    await resetNativeDatabase();
    runtime = await initializeRuntime();
    expect(runtime.deviceId).toBe(id);
    expect(runtime.serverUrl).toBe('https://medimart.local:3001');
    expect(await runtime.getToken()).toBe('b'.repeat(64));
    expect(await runtime.deviceProof()).toEqual(proof);
    await runtime.clearToken();
    expect(await runtime.getToken()).toBeNull();
  });
  it('does not rebind an enrolled installation to a different central server', async () => {
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    await runtime.setServerUrl('https://medimart.local');
    await runtime.deviceProof(true);
    await runtime.recordPairingStatus('approved');
    await expect(runtime.setServerUrl('https://other-server.local')).rejects.toThrow(
      'already enrolled',
    );
    expect(runtime.serverUrl).toBe('https://medimart.local');
  });
  it('fails closed on native database errors instead of using temporary browser storage', async () => {
    bridge.failOpen = true;
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    await expect(initializeRuntime()).rejects.toThrow('native open failure');
    expect(bridge.closeCount).toBe(1);
  });
  it('never uses the native plugins or JavaScript token storage in a browser', async () => {
    bridge.native = false;
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    expect(runtime.native).toBe(false);
    expect(runtime.database).toBeNull();
    expect(bridge.nativeCalls).toBe(0);
    expect(await runtime.getToken()).toBeNull();
    await expect(runtime.saveToken('token')).rejects.toThrow('HttpOnly');
    await expect(runtime.setServerUrl('https://anything.local')).rejects.toThrow('current host');
  });
});
describe('Android secure database first launch, restart and failure handling', () => {
  /**
   * Simulate a new WebView: the JavaScript side of the plugin holds the connection dictionary in
   * module memory, so a reload forgets it while the encrypted file and Keystore key survive.
   */
  async function reloadWebView() {
    closeLeftoverHandles();
    bridge.calls = [];
    await resetNativeDatabase();
  }

  /** Open the database the way the app does on a cold start. */
  async function coldStart() {
    const { openNativeDatabase } = await import('../apps/web/src/platform/native-database');
    return openNativeDatabase();
  }

  it('stores a 256-bit key on first launch, opens SQLCipher with it, and never uses no-encryption', async () => {
    const { outcome } = await coldStart();
    expect(outcome).toMatchObject({
      secretSource: 'generated',
      migrated: true,
      connection: 'created',
    });
    expect(bridge.secret).toMatch(/^[a-f0-9]{64}$/);
    // ['medimart', encrypted=true, mode='secret', version, readonly=false]
    expect(bridge.createOptions[2]).toBe('secret');
    expect(bridge.createOptions[1]).toBe(true);
    expect(bridge.createOptions).not.toContain('no-encryption');
  });

  it('reuses the stored key on restart instead of generating or resetting anything', async () => {
    await coldStart();
    const firstSecret = bridge.secret;
    // A restart is a new WebView: the memoized result and connection registry start empty.
    await reloadWebView();
    const { outcome } = await coldStart();
    expect(outcome.secretSource).toBe('reused');
    expect(outcome.migrated).toBe(false);
    expect(bridge.secret).toBe(firstSecret);
    // The key is only looked up, never written again.
    expect(bridge.calls).toContain('isSecretStored');
    expect(bridge.calls).not.toContain('setEncryptionSecret');
  });

  it('keeps existing records across a restart and does not re-create the installation identity', async () => {
    const first = await import('../apps/web/src/platform/runtime');
    let runtime = await first.initializeRuntime();
    const deviceId = runtime.deviceId;
    await runtime.database!.run(
      `INSERT INTO application_settings (id,scope,scope_id,key,value_json,created_at,updated_at) VALUES (?, 'device','probe','probe','"kept"',?,?)`,
      [crypto.randomUUID(), new Date().toISOString(), new Date().toISOString()],
    );
    await runtime.database!.close();
    await reloadWebView();

    runtime = await first.initializeRuntime();
    expect(runtime.deviceId).toBe(deviceId);
    const rows = await runtime.database!.all<{ value_json: string }>(
      `SELECT value_json FROM application_settings WHERE key='probe'`,
    );
    expect(JSON.parse(rows[0]!.value_json)).toBe('kept');
    await runtime.database!.close();
  });

  it('recovers a stale connection registry entry without touching the database file', async () => {
    await coldStart();
    const fileBefore = readFileSync(bridge.filename).length;
    // The WebView was reloaded: JavaScript still lists the connection, Java no longer has it.
    await reloadWebView();
    bridge.connections.add('RW_medimart');
    bridge.dangling.add('RW_medimart');
    const { outcome } = await coldStart();
    expect(outcome.connection).toBe('created');
    expect(bridge.closeCount).toBeGreaterThan(0);
    expect(readFileSync(bridge.filename).length).toBeGreaterThanOrEqual(fileBefore);
  });

  it('fails closed with a Keystore diagnostic when the stored key cannot be read back', async () => {
    await coldStart();
    await reloadWebView();
    bridge.failures.isSecretStored =
      'The master key android-keystore://_androidx_security_master_key_ exists but is unusable';
    const error = await coldStart().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code: string }).code).toBe('keystore-key-unusable');
    // Crucially: no new key was generated, and nothing was opened with a different key.
    expect(bridge.calls).not.toContain('setEncryptionSecret');
    expect(bridge.calls).not.toContain('createConnection');
  });

  it('refuses to start rather than re-keying when the plugin reports a passphrase in use', async () => {
    // A transient failure while `isSecretStored` says "nothing stored" must not lead to an
    // unencrypted or keyless database.
    bridge.failures.setEncryptionSecret = 'a passphrase has already been set ';
    bridge.failOpen = true;
    await reloadWebView();
    const error = await coldStart().catch((caught: unknown) => caught);
    expect((error as { code: string }).code).toBe('encryption-secret-already-set');
    expect(bridge.createOptions).toEqual([]);
  });

  it('states clearly that the plugin is not loaded when its configuration is rejected', async () => {
    bridge.failures.createConnection = 'CapacitorSQLitePlugin: null';
    await reloadWebView();
    const error = await coldStart().catch((caught: unknown) => caught);
    expect((error as { code: string }).code).toBe('plugin-load-failed');
  });

  it('never logs the encryption key or any long secret-shaped string', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    await coldStart();
    const secret = bridge.secret;
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(secret);
      expect(line).not.toMatch(/\b[0-9a-f]{32,}\b/);
    }
    vi.restoreAllMocks();
  }, 20_000);

  it('reports migration state instead of silently succeeding', async () => {
    const { migrations } = await import('@medimart/database');
    const { db } = await coldStart();
    const applied = await db.all('SELECT version FROM database_migrations');
    expect(applied).toHaveLength(migrations.length);
  });
});

describe('server addresses and HTTP transport', () => {
  it('normalizes HTTPS origins and rejects embedded credentials or arbitrary URL components', () => {
    expect(normalizeServerUrl(' https://MEDIMART.local:3001/ ')).toBe(
      'https://medimart.local:3001',
    );
    for (const url of [
      'https://user:password@host.local',
      'https://host.local/api',
      'https://host.local?key=secret',
      'https://host.local#fragment',
      'javascript:alert(1)',
      'file:///tmp/data',
      'not-a-url',
      'http://192.168.1.5:3001',
    ])
      expect(() => normalizeServerUrl(url)).toThrow();
    expect(normalizeServerUrl('http://192.168.1.5:3001', true)).toBe('http://192.168.1.5:3001');
    expect(() => normalizeServerUrl('http://public.example', true)).toThrow();
  });
  it('uses relative browser requests with cookies and CSRF, without a localhost URL in client code', async () => {
    bridge.native = false;
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient(runtime);
    api.setSession({
      user: {
        id: crypto.randomUUID(),
        fullName: 'Test User',
        email: 'test@example.test',
        roles: [],
        permissions: [],
      },
      expiresAt: '2099-01-01',
      csrfToken: 'csrf-proof',
    });
    await api.request('/api/settings', 'PUT', { businessName: 'Test' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/settings');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'X-CSRF-Token': 'csrf-proof' },
    });
  });
  it('does not transmit a token to a newly changed server origin', async () => {
    bridge.native = false;
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    const changing: Runtime = {
      ...runtime,
      native: true,
      serverUrl: 'https://first.local',
      getToken: async () => {
        changing.serverUrl = 'https://second.local';
        return 'b'.repeat(64);
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ApiClient(changing).request('/api/auth/session')).rejects.toThrow(
      'configuration changed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('turns unreachable or invalid API responses into useful errors', async () => {
    bridge.native = false;
    const { initializeRuntime } = await import('../apps/web/src/platform/runtime');
    runtime = await initializeRuntime();
    const api = new ApiClient(runtime);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(api.request('/api/health')).rejects.toThrow('unreachable');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>Not an API</html>', { status: 200 })),
    );
    await expect(api.request('/api/health')).rejects.toThrow('not responding as a MediMart');
  });
  it('keeps the Android package ID, bundled assets, and release security controls in source', async () => {
    const { default: config } = await import('../apps/web/capacitor.config');
    expect(config.appId).toBe('com.medimart.app');
    expect(config.appName).toBe('MediMart');
    expect(config.webDir).toBe('dist');
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.cleartext).toBe(false);
    expect(config.android?.allowMixedContent).toBe(false);
    const manifest = readFileSync('apps/web/android/app/src/main/AndroidManifest.xml', 'utf8');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    const rules = readFileSync(
      'apps/web/android/app/src/main/res/xml/data_extraction_rules.xml',
      'utf8',
    );
    expect(rules).toContain('<device-transfer>');
    expect(rules).toContain('domain="database"');
  });
});
