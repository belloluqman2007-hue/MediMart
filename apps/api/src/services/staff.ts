import type { Database, SqlExecutor } from '@medimart/database';
import type { Permission, RoleCode, UserProfile } from '@medimart/shared';
import { roleCodes } from '@medimart/shared';
import type { AuthContext } from './auth';
import { getProfile } from './auth';
import { ApiError } from '../errors';
import { audit } from './audit';
import { hashPassword } from './crypto';

/**
 * Staff administration.
 *
 * The rules that keep this safe, and why each one exists:
 *
 * 1. **Nobody edits their own access.** An owner cannot remove their own last owner role, disable
 *    themselves, or reset their own password through this path. Locking every administrator out of
 *    a shop's own database would be unrecoverable, and the recovery would be a manual SQL edit.
 * 2. **The last owner is protected.** Removing the owner role or disabling the account is refused
 *    when it would leave no active owner.
 * 3. **No privilege escalation.** A caller may only assign roles whose grants they already hold —
 *    the same rule `registerStaff` already enforces — so a manager cannot mint an owner.
 * 4. **Role changes are live.** Permissions are read from the database on every request, so revoking
 *    a role ends that user's access on their next request, without waiting for a session to expire.
 * 5. **Every change is audited** with the actor, the target and the before/after roles.
 */

export type StaffRow = {
  id: string;
  fullName: string;
  email: string;
  status: 'active' | 'disabled';
  roles: RoleCode[];
  lastSignInAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
  activeSessions: number;
};

const STAFF_LIST_LIMIT = 500;

export async function listStaff(db: SqlExecutor, query: { search?: string }) {
  const values: string[] = [];
  let filter = 'u.deleted_at IS NULL';
  if (query.search) {
    filter += ' AND (u.full_name LIKE ? OR u.email LIKE ?)';
    const pattern = `%${query.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    values.push(pattern, pattern);
  }
  const rows = await db.all<{
    id: string;
    full_name: string;
    email: string;
    status: 'active' | 'disabled';
    created_at: string;
    locked_until: string | null;
    roles: string | null;
    last_seen_at: string | null;
    active_sessions: number;
  }>(
    `SELECT u.id,u.full_name,u.email,u.status,u.created_at,u.locked_until,
       (SELECT group_concat(r.code, ',') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) AS roles,
       (SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.user_id=u.id) AS last_seen_at,
       (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
     FROM users u WHERE ${filter}
     ORDER BY u.full_name ASC LIMIT ${STAFF_LIST_LIMIT}`,
    [new Date().toISOString(), ...values],
  );
  return rows.map<StaffRow>((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    roles: (row.roles ? row.roles.split(',') : []) as RoleCode[],
    lastSignInAt: row.last_seen_at,
    createdAt: row.created_at,
    lockedUntil: row.locked_until,
    activeSessions: Number(row.active_sessions),
  }));
}

/** Grants a caller holds, used to refuse assigning a role that would escalate privilege. */
async function assertCanGrant(tx: SqlExecutor, actor: AuthContext, roles: readonly RoleCode[]) {
  if (!roles.length) throw new ApiError(400, 'ROLE_REQUIRED', 'Choose at least one role.');
  const unknown = roles.filter((role) => !(roleCodes as readonly string[]).includes(role));
  if (unknown.length)
    throw new ApiError(400, 'ROLE_UNKNOWN', `Unknown role: ${unknown.join(', ')}.`);
  const placeholders = roles.map(() => '?').join(',');
  const rows = await tx.all<{ code: Permission }>(
    `SELECT DISTINCT p.code FROM permissions p
     JOIN role_permissions rp ON rp.permission_id=p.id
     JOIN roles r ON r.id=rp.role_id WHERE r.code IN (${placeholders})`,
    [...roles],
  );
  const caller = await getProfile(tx, actor.user.id);
  const missing = rows.filter((row) => !caller.permissions.includes(row.code));
  if (missing.length)
    throw new ApiError(
      403,
      'ROLE_ESCALATION',
      'You cannot grant a role whose permissions you do not hold.',
    );
}

async function activeOwnerCount(tx: SqlExecutor, excludingUserId?: string) {
  const row = (
    await tx.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM users u
       JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
       WHERE r.code='owner' AND u.status='active' AND u.deleted_at IS NULL AND u.id <> ?`,
      [excludingUserId ?? ''],
    )
  )[0]!;
  return Number(row.count);
}

export async function updateStaffRoles(
  db: Database,
  actor: AuthContext,
  requestId: string,
  targetId: string,
  roles: readonly RoleCode[],
): Promise<UserProfile> {
  return db.transaction(async (tx) => {
    const before = await getProfile(tx, targetId);
    if (targetId === actor.user.id)
      throw new ApiError(
        409,
        'SELF_ROLE_CHANGE',
        'You cannot change your own roles. Ask another owner to do it.',
      );
    const target = (
      await tx.all<{ status: string }>(
        'SELECT status FROM users WHERE id = ? AND deleted_at IS NULL',
        [targetId],
      )
    )[0];
    if (!target) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That staff account does not exist.');
    await assertCanGrant(tx, actor, roles);
    if (before.roles.includes('owner') && !roles.includes('owner')) {
      if ((await activeOwnerCount(tx, targetId)) === 0)
        throw new ApiError(
          409,
          'LAST_OWNER',
          'This is the last active owner. Give another account the owner role first.',
        );
    }
    await tx.run('DELETE FROM user_roles WHERE user_id = ?', [targetId]);
    for (const role of roles)
      await tx.run(
        'INSERT INTO user_roles (id,user_id,role_id,assigned_by) SELECT ?,?,id,? FROM roles WHERE code=?',
        [crypto.randomUUID(), targetId, actor.user.id, role],
      );
    await audit(tx, {
      action: 'staff.roles_changed',
      actorId: actor.user.id,
      deviceId: actor.deviceId,
      requestId,
      entityType: 'user',
      entityId: targetId,
      metadata: { before: before.roles, after: [...roles] },
    });
    return getProfile(tx, targetId);
  });
}

export async function setStaffStatus(
  db: Database,
  actor: AuthContext,
  requestId: string,
  targetId: string,
  status: 'active' | 'disabled',
): Promise<StaffRow> {
  return db.transaction(async (tx) => {
    const before = await getProfile(tx, targetId);
    if (targetId === actor.user.id)
      throw new ApiError(
        409,
        'SELF_DISABLE',
        'You cannot disable your own account. Ask another owner to do it.',
      );
    if (status === 'disabled' && before.roles.includes('owner')) {
      if ((await activeOwnerCount(tx, targetId)) === 0)
        throw new ApiError(
          409,
          'LAST_OWNER',
          'This is the last active owner. Give another account the owner role first.',
        );
    }
    await tx.run(
      'UPDATE users SET status=?, version=version+1, updated_at=? WHERE id=? AND deleted_at IS NULL',
      [status, new Date().toISOString(), targetId],
    );
    if (status === 'disabled') {
      // Disabling must be immediate: end every live session, not just future sign-ins.
      await tx.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [
        new Date().toISOString(),
        targetId,
      ]);
    }
    await audit(tx, {
      action: status === 'disabled' ? 'staff.disabled' : 'staff.enabled',
      actorId: actor.user.id,
      deviceId: actor.deviceId,
      requestId,
      entityType: 'user',
      entityId: targetId,
      metadata: { roles: before.roles },
    });
    // The caller needs the new account state to update the row it just changed; a profile alone does
    // not carry `status`, so the staff row is returned.
    const rows = await listStaff(tx, {});
    return rows.find((row) => row.id === targetId)!;
  });
}

/**
 * An administrator sets a temporary password for a staff member. The target's sessions are revoked
 * and their lockout cleared; the audit row records who did it and when, never the password.
 */
export async function resetStaffPassword(
  db: Database,
  actor: AuthContext,
  requestId: string,
  targetId: string,
  newPassword: string,
): Promise<void> {
  const hash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const target = (
      await tx.all<{ id: string }>('SELECT id FROM users WHERE id=? AND deleted_at IS NULL', [
        targetId,
      ])
    )[0];
    if (!target) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That staff account does not exist.');
    const now = new Date().toISOString();
    await tx.run(
      'UPDATE users SET password_hash=?, password_changed_at=?, failed_login_count=0, locked_until=NULL, version=version+1, updated_at=? WHERE id=?',
      [hash, now, now, targetId],
    );
    await tx.run('UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [
      now,
      targetId,
    ]);
    await audit(tx, {
      action: 'staff.password_reset',
      actorId: actor.user.id,
      deviceId: actor.deviceId,
      requestId,
      entityType: 'user',
      entityId: targetId,
    });
  });
}

/**
 * Grant or revoke one capability for one role.
 *
 * This is the only mutation of the permission model. Two invariants make it safe:
 *
 * - The caller must already hold the capability they are granting (no escalation), and must hold
 *   `permissions.manage` (checked by the route).
 * - The owner role cannot gain or lose a grant here. The owner is defined as "every capability";
 *   letting it be edited would create a state where the owner is less than an owner, and the
 *   recovery path would be manual SQL.
 */
export async function setRolePermission(
  db: Database,
  actor: AuthContext,
  requestId: string,
  roleCode: RoleCode,
  permissionCode: Permission,
  granted: boolean,
): Promise<{ role: RoleCode; permission: Permission; granted: boolean; affectedUsers: number }> {
  return db.transaction(async (tx) => {
    if (roleCode === 'owner')
      throw new ApiError(
        409,
        'OWNER_IMMUTABLE',
        'The owner role always holds every capability and cannot be edited.',
      );
    const caller = await getProfile(tx, actor.user.id);
    if (granted && !caller.permissions.includes(permissionCode))
      throw new ApiError(
        403,
        'PERMISSION_ESCALATION',
        'You cannot grant a capability you do not hold yourself.',
      );
    const role = (await tx.all<{ id: string }>('SELECT id FROM roles WHERE code=?', [roleCode]))[0];
    if (!role) throw new ApiError(404, 'ROLE_NOT_FOUND', 'That role does not exist.');
    const permission = (
      await tx.all<{ id: string }>('SELECT id FROM permissions WHERE code=?', [permissionCode])
    )[0];
    if (!permission)
      throw new ApiError(404, 'PERMISSION_NOT_FOUND', 'That capability does not exist.');

    if (granted)
      await tx.run(
        'INSERT OR IGNORE INTO role_permissions (id,role_id,permission_id) VALUES (?,?,?)',
        [crypto.randomUUID(), role.id, permission.id],
      );
    else
      await tx.run('DELETE FROM role_permissions WHERE role_id=? AND permission_id=?', [
        role.id,
        permission.id,
      ]);

    const affected = (
      await tx.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE ur.role_id=? AND u.status=? AND u.deleted_at IS NULL',
        [role.id, 'active'],
      )
    )[0]!;
    await audit(tx, {
      action: granted ? 'permissions.granted' : 'permissions.revoked',
      actorId: actor.user.id,
      deviceId: actor.deviceId,
      requestId,
      entityType: 'role',
      entityId: role.id,
      metadata: {
        role: roleCode,
        permission: permissionCode,
        affectedUsers: Number(affected.count),
      },
    });
    return {
      role: roleCode,
      permission: permissionCode,
      granted,
      affectedUsers: Number(affected.count),
    };
  });
}
