import { randomInt } from 'node:crypto';
import type { Database } from '@medimart/database';
import type { z } from 'zod';
import type { registerDeviceSchema } from '@medimart/shared';
import { ApiError } from '../errors';
import { requireActiveContext, type AuthContext } from './auth';
import { hashToken, secureEqual } from './crypto';
import { audit } from './audit';
export class DeviceService {
  constructor(private readonly db: Database) {}
  async register(input: z.infer<typeof registerDeviceSchema>, requestId: string) {
    // The device saves its random secret in Keystore BEFORE making the request.
    // A dropped response can be retried without losing the installation's identity.
    return this.db.transaction(async (tx) => {
      const previous = (
        await tx.all<{ status: string; secret_hash: string | null }>(
          'SELECT status,secret_hash FROM devices WHERE id=?',
          [input.id],
        )
      )[0];
      if (
        previous &&
        (!previous.secret_hash || !secureEqual(previous.secret_hash, hashToken(input.secret)))
      )
        throw new ApiError(409, 'DEVICE_ID_IN_USE', 'This installation ID is already registered.');
      if (previous?.status === 'revoked')
        throw new ApiError(
          403,
          'DEVICE_REVOKED',
          'This device was revoked. Contact the owner; it cannot re-pair itself.',
        );
      if (previous?.status === 'approved')
        return { id: input.id, status: 'approved' as const, pairingCode: null, expiresAt: null };
      const pairingCode = String(randomInt(0, 100_000_000)).padStart(8, '0');
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const codeHash = hashToken(`pairing:${input.id}:${pairingCode}`);
      if (previous) {
        await tx.run(
          'UPDATE devices SET pairing_code_hash=?,pairing_expires_at=?,pairing_attempts=0,updated_at=? WHERE id=?',
          [codeHash, expiresAt, new Date().toISOString(), input.id],
        );
      } else {
        await tx.run(
          'INSERT INTO devices (id,name,platform,secret_hash,pairing_code_hash,pairing_expires_at) VALUES (?,?,?,?,?,?)',
          [input.id, input.name, input.platform, hashToken(input.secret), codeHash, expiresAt],
        );
        await tx.run('INSERT INTO sync_devices (id,device_id) VALUES (?,?)', [
          crypto.randomUUID(),
          input.id,
        ]);
      }
      await audit(tx, { action: 'device.pairing_requested', deviceId: input.id, requestId });
      return { id: input.id, status: 'pending' as const, pairingCode, expiresAt };
    });
  }
  async status(id: string, secret: string) {
    const row = (
      await this.db.all<{ status: string; secret_hash: string | null }>(
        'SELECT status,secret_hash FROM devices WHERE id=?',
        [id],
      )
    )[0];
    if (!row?.secret_hash || !secureEqual(row.secret_hash, hashToken(secret)))
      throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device registration was not found.');
    return { status: row.status };
  }
  async approve(id: string, code: string, auth: AuthContext, requestId: string) {
    const error = await this.db.transaction(async (tx) => {
      await requireActiveContext(tx, auth, 'devices.manage');
      const row = (
        await tx.all<{
          status: string;
          pairing_code_hash: string | null;
          pairing_expires_at: string | null;
          pairing_attempts: number;
        }>(
          'SELECT status,pairing_code_hash,pairing_expires_at,pairing_attempts FROM devices WHERE id=?',
          [id],
        )
      )[0];
      if (!row) return new ApiError(404, 'DEVICE_NOT_FOUND', 'Device registration was not found.');
      if (row.status !== 'pending')
        return new ApiError(409, 'DEVICE_NOT_PENDING', 'Only pending devices can be approved.');
      if (
        !row.pairing_expires_at ||
        row.pairing_expires_at <= new Date().toISOString() ||
        row.pairing_attempts >= 5
      )
        return new ApiError(
          410,
          'PAIRING_EXPIRED',
          'Request a new code from the device. This pairing request expired or was locked.',
        );
      if (
        !row.pairing_code_hash ||
        !secureEqual(row.pairing_code_hash, hashToken(`pairing:${id}:${code}`))
      ) {
        await tx.run('UPDATE devices SET pairing_attempts=pairing_attempts+1 WHERE id=?', [id]);
        await audit(tx, {
          action: 'device.approval_failed',
          actorId: auth.user.id,
          deviceId: id,
          requestId,
        });
        return new ApiError(400, 'PAIRING_CODE_INVALID', 'That pairing code is not correct.');
      }
      const now = new Date().toISOString();
      await tx.run(
        "UPDATE devices SET status='approved',approved_by=?,approved_at=?,updated_at=?,pairing_code_hash=NULL,pairing_expires_at=NULL WHERE id=?",
        [auth.user.id, now, now, id],
      );
      await audit(tx, {
        action: 'device.approved',
        actorId: auth.user.id,
        deviceId: id,
        requestId,
      });
      return null;
    });
    if (error) throw error;
  }
  async revoke(id: string, auth: AuthContext, requestId: string) {
    await this.db.transaction(async (tx) => {
      await requireActiveContext(tx, auth, 'devices.manage');
      const now = new Date().toISOString();
      const update = await tx.run(
        "UPDATE devices SET status='revoked',updated_at=?,pairing_code_hash=NULL,pairing_expires_at=NULL WHERE id=? AND status!='revoked'",
        [now, id],
      );
      if (update.changes !== 1)
        throw new ApiError(404, 'DEVICE_NOT_FOUND', 'No active registration was found.');
      await tx.run(
        'UPDATE user_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL',
        [now, id],
      );
      await audit(tx, { action: 'device.revoked', actorId: auth.user.id, deviceId: id, requestId });
    });
  }
}
