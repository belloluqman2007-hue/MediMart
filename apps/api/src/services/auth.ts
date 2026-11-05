import type { Database, SqlExecutor } from '@medimart/database';
import type { UserProfile, RoleCode, Permission } from '@medimart/shared';
import type { z } from 'zod';
import type {
  changePasswordSchema,
  loginSchema,
  ownerRegistrationSchema,
  staffRegistrationSchema,
} from '@medimart/shared';
import type { ApiConfig } from '../config';
import { ApiError } from '../errors';
import { audit } from './audit';
import {
  csrfForToken,
  hashPassword,
  hashToken,
  opaqueToken,
  secureEqual,
  verifyPassword,
} from './crypto';
export interface AuthContext {
  user: UserProfile;
  sessionId: string;
  rawToken: string;
  transport: 'cookie' | 'bearer';
  deviceId: string | null;
  expiresAt: string;
}
export type RequestMeta = { requestId: string; userAgent: string };
type UserRow = {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  status: string;
  deleted_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
};
export async function getProfile(tx: SqlExecutor, id: string): Promise<UserProfile> {
  const row = (
    await tx.all<{ id: string; full_name: string; email: string }>(
      'SELECT id,full_name,email FROM users WHERE id = ?',
      [id],
    )
  )[0];
  if (!row) throw new ApiError(401, 'SESSION_INVALID', 'Please sign in again.');
  const roles = await tx.all<{ code: RoleCode }>(
    'SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? ORDER BY r.code',
    [id],
  );
  const permissions = await tx.all<{ code: Permission }>(
    'SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = ? ORDER BY p.code',
    [id],
  );
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    roles: roles.map((r) => r.code),
    permissions: permissions.map((p) => p.code),
  };
}
/** Recheck a session and live grants INSIDE a write transaction after expensive work. */
export async function requireActiveContext(
  tx: SqlExecutor,
  auth: AuthContext,
  permission?: Permission,
): Promise<UserProfile> {
  const active = await tx.all(
    `SELECT s.id FROM user_sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN devices d ON d.id=s.device_id WHERE s.id=? AND s.user_id=? AND s.token_hash=? AND s.transport=? AND s.revoked_at IS NULL
    AND s.expires_at>? AND u.status='active' AND u.deleted_at IS NULL
    AND (s.device_id IS NULL OR d.status='approved')`,
    [
      auth.sessionId,
      auth.user.id,
      hashToken(auth.rawToken),
      auth.transport,
      new Date().toISOString(),
    ],
  );
  if (active.length !== 1)
    throw new ApiError(401, 'SESSION_INVALID', 'Your session has ended. Please sign in again.');
  const profile = await getProfile(tx, auth.user.id);
  if (permission && !profile.permissions.includes(permission))
    throw new ApiError(
      403,
      'PERMISSION_DENIED',
      'Your account no longer has permission to perform this action.',
    );
  return profile;
}
export class AuthService {
  // Unknown-user attempts still perform Argon2 work, avoiding a cheap timing oracle.
  private readonly dummyHash = hashPassword(opaqueToken());
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
  ) {}
  async bootstrapStatus() {
    const row = (await this.db.all<{ count: number }>('SELECT COUNT(*) AS count FROM users'))[0]!;
    return {
      required: row.count === 0,
      enabled: row.count === 0 && Boolean(this.config.bootstrapToken),
    };
  }
  private async issue(
    tx: SqlExecutor,
    userId: string,
    meta: RequestMeta,
    deviceId: string | null = null,
  ) {
    const token = opaqueToken();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.config.sessionHours * 3_600_000).toISOString();
    const transport = deviceId ? ('bearer' as const) : ('cookie' as const);
    await tx.run(
      'INSERT INTO user_sessions (id,user_id,device_id,token_hash,transport,user_agent,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        id,
        userId,
        deviceId,
        hashToken(token),
        transport,
        meta.userAgent.slice(0, 256),
        now,
        now,
        expiresAt,
      ],
    );
    return {
      token,
      transport,
      user: await getProfile(tx, userId),
      expiresAt,
      csrfToken: transport === 'cookie' ? csrfForToken(token) : undefined,
    };
  }
  async registerOwner(input: z.infer<typeof ownerRegistrationSchema>, meta: RequestMeta) {
    if (
      !this.config.bootstrapToken ||
      !secureEqual(input.bootstrapToken, this.config.bootstrapToken)
    )
      throw new ApiError(403, 'SETUP_TOKEN_INVALID', 'A valid server setup token is required.');
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      if ((await tx.all<{ count: number }>('SELECT COUNT(*) AS count FROM users'))[0]!.count !== 0)
        throw new ApiError(
          409,
          'SETUP_COMPLETE',
          'The owner account has already been created. Ask an authorized administrator for an account.',
        );
      const id = crypto.randomUUID();
      await tx.run('INSERT INTO users (id,full_name,email,password_hash) VALUES (?,?,?,?)', [
        id,
        input.fullName,
        input.email,
        hash,
      ]);
      await tx.run(
        "INSERT INTO user_roles (id,user_id,role_id,assigned_by) SELECT ?,?,id,? FROM roles WHERE code='owner'",
        [crypto.randomUUID(), id, id],
      );
      await audit(tx, {
        action: 'owner.registered',
        actorId: id,
        entityType: 'user',
        entityId: id,
        requestId: meta.requestId,
      });
      return this.issue(tx, id, meta);
    });
  }
  async login(input: z.infer<typeof loginSchema>, meta: RequestMeta) {
    const snapshot = (
      await this.db.all<UserRow>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [
        input.email,
      ])
    )[0];
    const validPassword = await verifyPassword(
      snapshot?.password_hash ?? (await this.dummyHash),
      input.password,
    ).catch(() => false);
    // Return failures from the transaction, then throw outside it so lockout/audit writes survive.
    const outcome = await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const current = snapshot
        ? (await tx.all<UserRow>('SELECT * FROM users WHERE id = ?', [snapshot.id]))[0]
        : undefined;
      const locked = Boolean(current?.locked_until && current.locked_until > now);
      const valid =
        current &&
        snapshot &&
        Boolean(current.password_hash) &&
        validPassword &&
        current.password_hash === snapshot.password_hash &&
        current.status === 'active' &&
        !current.deleted_at &&
        !locked;
      if (!valid) {
        if (current && !locked && current.status === 'active') {
          const failures =
            current.locked_until && current.locked_until <= now
              ? 1
              : current.failed_login_count + 1;
          const until = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
          await tx.run(
            'UPDATE users SET failed_login_count=?,locked_until=?,updated_at=? WHERE id=?',
            [failures, until, now, current.id],
          );
        }
        await audit(tx, {
          action: 'auth.login_failed',
          actorId: current?.id,
          requestId: meta.requestId,
          metadata: { reason: locked ? 'locked' : 'credentials' },
        });
        return {
          error: new ApiError(
            401,
            'INVALID_CREDENTIALS',
            'Unable to sign in. Check your credentials, or wait if this account is temporarily locked.',
          ),
        };
      }
      if (input.device) {
        const device = (
          await tx.all<{ status: string; secret_hash: string | null }>(
            'SELECT status,secret_hash FROM devices WHERE id=?',
            [input.device.id],
          )
        )[0];
        if (
          !device ||
          device.status !== 'approved' ||
          !device.secret_hash ||
          !secureEqual(device.secret_hash, hashToken(input.device.secret))
        ) {
          await audit(tx, {
            action: 'auth.device_denied',
            actorId: current.id,
            requestId: meta.requestId,
          });
          return {
            error: new ApiError(
              403,
              'DEVICE_NOT_PAIRED',
              'This device must be paired and approved before signing in.',
            ),
          };
        }
        await tx.run('UPDATE devices SET last_seen_at=?,updated_at=? WHERE id=?', [
          now,
          now,
          input.device.id,
        ]);
      }
      await tx.run(
        'UPDATE users SET failed_login_count=0,locked_until=NULL,updated_at=? WHERE id=?',
        [now, current.id],
      );
      const session = await this.issue(tx, current.id, meta, input.device?.id);
      await audit(tx, {
        action: 'auth.login',
        actorId: current.id,
        deviceId: input.device?.id,
        requestId: meta.requestId,
      });
      return { session };
    });
    if (outcome.error) throw outcome.error;
    return outcome.session!;
  }
  async authenticate(token: string, transport: 'cookie' | 'bearer'): Promise<AuthContext> {
    const now = new Date().toISOString();
    const row = (
      await this.db.all<{
        id: string;
        user_id: string;
        device_id: string | null;
        expires_at: string;
      }>(
        `SELECT s.id,s.user_id,s.device_id,s.expires_at FROM user_sessions s
      JOIN users u ON u.id=s.user_id LEFT JOIN devices d ON d.id=s.device_id
      WHERE s.token_hash=? AND s.transport=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND u.status='active' AND u.deleted_at IS NULL AND (s.device_id IS NULL OR d.status='approved')`,
        [hashToken(token), transport, now],
      )
    )[0];
    if (!row)
      throw new ApiError(401, 'SESSION_INVALID', 'Your session has ended. Please sign in again.');
    await this.db.run('UPDATE user_sessions SET last_seen_at=? WHERE id=?', [now, row.id]);
    return {
      user: await getProfile(this.db, row.user_id),
      sessionId: row.id,
      rawToken: token,
      transport,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
    };
  }
  async registerStaff(
    input: z.infer<typeof staffRegistrationSchema>,
    actor: AuthContext,
    meta: RequestMeta,
  ) {
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const profile = await requireActiveContext(tx, actor, 'staff.manage');
      if (input.roles.includes('administrator') && !profile.roles.includes('owner'))
        throw new ApiError(403, 'ROLE_ESCALATION', 'Only the owner can create an administrator.');
      const placeholders = input.roles.map(() => '?').join(',');
      const roles = await tx.all<{ id: string }>(
        `SELECT id FROM roles WHERE code IN (${placeholders})`,
        input.roles,
      );
      if (roles.length !== input.roles.length)
        throw new ApiError(409, 'ROLE_UNAVAILABLE', 'A selected role is not available.');
      const grants = await tx.all<{ code: Permission }>(
        `SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id JOIN roles r ON r.id=rp.role_id WHERE r.code IN (${placeholders})`,
        input.roles,
      );
      if (grants.some((grant) => !profile.permissions.includes(grant.code)))
        throw new ApiError(
          403,
          'ROLE_ESCALATION',
          'You cannot grant permissions that you do not hold.',
        );
      if (
        (await tx.all('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [input.email])).length
      )
        throw new ApiError(409, 'EMAIL_IN_USE', 'An account already uses this email address.');
      const id = crypto.randomUUID();
      await tx.run('INSERT INTO users (id,full_name,email,password_hash) VALUES (?,?,?,?)', [
        id,
        input.fullName,
        input.email,
        hash,
      ]);
      for (const role of input.roles)
        await tx.run(
          'INSERT INTO user_roles (id,user_id,role_id,assigned_by) SELECT ?,?,id,? FROM roles WHERE code=?',
          [crypto.randomUUID(), id, actor.user.id, role],
        );
      await audit(tx, {
        action: 'staff.registered',
        actorId: actor.user.id,
        deviceId: actor.deviceId,
        entityType: 'user',
        entityId: id,
        requestId: meta.requestId,
        metadata: { roles: input.roles },
      });
      return getProfile(tx, id);
    });
  }
  async changePassword(
    input: z.infer<typeof changePasswordSchema>,
    auth: AuthContext,
    meta: RequestMeta,
  ) {
    const current = (
      await this.db.all<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', [
        auth.user.id,
      ])
    )[0];
    if (
      !current ||
      !(await verifyPassword(current.password_hash, input.currentPassword).catch(() => false))
    ) {
      await audit(this.db, {
        action: 'auth.password_change_denied',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId: meta.requestId,
      });
      throw new ApiError(401, 'PASSWORD_INCORRECT', 'The current password is not correct.');
    }
    const hash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await requireActiveContext(tx, auth);
      const now = new Date().toISOString();
      const update = await tx.run(
        'UPDATE users SET failed_login_count=0,locked_until=NULL,password_hash=?,password_changed_at=?,version=version+1,updated_at=? WHERE id=? AND password_hash=?',
        [hash, now, now, auth.user.id, current.password_hash],
      );
      if (update.changes !== 1)
        throw new ApiError(
          409,
          'ACCOUNT_CHANGED',
          'The account changed. Sign in again before retrying.',
        );
      await tx.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [
        now,
        auth.user.id,
      ]);
      await audit(tx, {
        action: 'auth.password_changed',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId: meta.requestId,
      });
    });
  }
  async logout(auth: AuthContext, meta: RequestMeta, all = false) {
    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE user_sessions SET revoked_at=? WHERE ${all ? 'user_id' : 'id'}=? AND revoked_at IS NULL`,
        [new Date().toISOString(), all ? auth.user.id : auth.sessionId],
      );
      await audit(tx, {
        action: all ? 'auth.logout_all' : 'auth.logout',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId: meta.requestId,
      });
    });
  }
}
