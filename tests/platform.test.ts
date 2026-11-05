import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeServerUrl } from '@medimart/shared';
import type { Runtime } from '../apps/web/src/platform/types';
import { ApiClient } from '../apps/web/src/lib/api';
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
  return {
    CapacitorSQLite: {},
    SQLiteConnection: class {
      private connection: InstanceType<typeof Sqlite> | null = null;
      async isSecretStored() {
        bridge.nativeCalls++;
        return { result: bridge.secretStored };
      }
      async setEncryptionSecret(secret: string) {
        bridge.secret = secret;
        bridge.secretStored = true;
      }
      async checkConnectionsConsistency() {
        return { result: true };
      }
      async isConnection() {
        return { result: false };
      }
      async createConnection(...options: unknown[]) {
        bridge.createOptions = options;
        this.connection = new Sqlite(bridge.filename);
        const db = this.connection;
        return {
          open: async () => {
            if (bridge.failOpen) throw new Error('Simulated native open failure');
          },
          execute: async (sql: string) => {
            db.exec(sql);
            return { changes: { changes: 0 } };
          },
          query: async (sql: string, values: unknown[] = []) => ({
            values: db.prepare(sql).all(...values),
          }),
          run: async (sql: string, values: unknown[] = []) => ({
            changes: { changes: db.prepare(sql).run(...values).changes },
          }),
        };
      }
      async closeConnection() {
        bridge.closeCount++;
        this.connection?.close();
        this.connection = null;
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
  runtime = null;
});
afterEach(async () => {
  await runtime?.database?.close();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
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
