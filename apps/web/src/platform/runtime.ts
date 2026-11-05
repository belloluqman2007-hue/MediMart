import { Capacitor } from '@capacitor/core';
import { normalizeServerUrl, sha256 } from '@medimart/shared';
import { readSetting, writeSetting } from '@medimart/database';
import type { Runtime } from './types';
export async function initializeRuntime(): Promise<Runtime> {
  if (!Capacitor.isNativePlatform()) {
    return {
      native: false,
      deviceId: null,
      database: null,
      serverUrl: '',
      getToken: async () => null,
      saveToken: async () => {
        throw new Error('Browser sessions use HttpOnly cookies, never JavaScript storage.');
      },
      clearToken: async () => {},
      setServerUrl: async () => {
        throw new Error(
          'Browser clients use the current host. Configure the API proxy on the server.',
        );
      },
      deviceProof: async () => null,
      recordPairingStatus: async () => {},
    };
  }
  const { openNativeDatabase } = await import('./native-database');
  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
  await SecureStorage.setKeyPrefix('medimart_');
  const db = await openNativeDatabase();
  const deviceId = await db.transaction(async (tx) => {
    let id = await readSetting<string>(tx, 'installation_id', 'device', 'this-installation');
    if (!id) {
      id = crypto.randomUUID();
      await writeSetting(tx, 'installation_id', id, {
        scope: 'device',
        scopeId: 'this-installation',
      });
      await tx.run(
        "INSERT INTO devices (id,name,platform,status) VALUES (?,'This Android installation','android','pending')",
        [id],
      );
      await tx.run('INSERT INTO sync_devices (id,device_id) VALUES (?,?)', [
        crypto.randomUUID(),
        id,
      ]);
    }
    return id;
  });
  let serverUrl = (await readSetting<string>(db, 'central_server_url', 'device', deviceId)) || '';
  const key = async (type: string) => `${type}_${await sha256(`${deviceId}:${serverUrl}`)}`;
  const runtime: Runtime = {
    native: true,
    deviceId,
    database: db,
    get serverUrl() {
      return serverUrl;
    },
    getToken: async () => {
      const value = await SecureStorage.get(await key('session'), false);
      return typeof value === 'string' ? value : null;
    },
    saveToken: async (token) => {
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session token.');
      await SecureStorage.set(await key('session'), token);
    },
    clearToken: async () => {
      await SecureStorage.remove(await key('session'));
    },
    setServerUrl: async (input) => {
      const normalized = normalizeServerUrl(input, import.meta.env.VITE_ALLOW_HTTP_LAN === 'true');
      if (normalized === serverUrl) return;
      const pending = (
        await db.all<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sync_queue WHERE status!='acknowledged'",
        )
      )[0]!.count;
      if (pending > 0 || (await readSetting<string>(db, 'enrolled_server_url', 'device', deviceId)))
        throw new Error(
          'This installation is already enrolled or has unsynchronized records. Server re-enrollment is intentionally not available in Phase 1.',
        );
      await runtime.clearToken();
      await writeSetting(db, 'central_server_url', normalized, {
        scope: 'device',
        scopeId: deviceId,
      });
      serverUrl = normalized;
    },
    deviceProof: async (create = false) => {
      if (!serverUrl) return null;
      let secret = await SecureStorage.get(await key('device_secret'), false);
      if (!secret && create) {
        secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
        await SecureStorage.set(await key('device_secret'), secret);
      }
      return typeof secret === 'string' ? { id: deviceId, secret } : null;
    },
    recordPairingStatus: async (status) => {
      await db.transaction(async (tx) => {
        await tx.run('UPDATE devices SET status=?,updated_at=? WHERE id=?', [
          status,
          new Date().toISOString(),
          deviceId,
        ]);
        await writeSetting(tx, 'enrolled_server_url', serverUrl, {
          scope: 'device',
          scopeId: deviceId,
        });
      });
    },
  };
  return runtime;
}
