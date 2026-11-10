import type { Migration } from './migrations';

/**
 * Phase 6 permission grant: an approved Android installation captures and synchronizes its own
 * offline business records. `sync.manage` already existed for administrators; cashiers,
 * pharmacists, storekeepers and managers now hold it so they can push the records they parked
 * while the shop computer was unreachable. Every synchronized record is still re-authorized by
 * the domain service on the central server — this grant is not a permission bypass.
 *
 * IDs are constants, not `randomblob()`, so the migration is deterministic and reproducible.
 * Released migrations v1–v12 are never edited.
 */
const grants: readonly { id: string; role: string; permission: string }[] = [
  { id: '40000000-0000-4000-8000-0c52c49de73a', role: 'cashier', permission: 'sync.manage' },
  { id: '40000000-0000-4000-8000-f36037099adc', role: 'cashier', permission: 'sync.view' },
  { id: '40000000-0000-4000-8000-a30c591ae39e', role: 'pharmacist', permission: 'sync.manage' },
  { id: '40000000-0000-4000-8000-e59ba3eb527b', role: 'pharmacist', permission: 'sync.view' },
  { id: '40000000-0000-4000-8000-fb2a7fc394da', role: 'storekeeper', permission: 'sync.manage' },
  { id: '40000000-0000-4000-8000-e9c7c0a8e94c', role: 'storekeeper', permission: 'sync.view' },
  {
    id: '40000000-0000-4000-8000-36317ce88c5d',
    role: 'healthcare_professional',
    permission: 'sync.view',
  },
  { id: '40000000-0000-4000-8000-7b1fc22489db', role: 'manager', permission: 'sync.manage' },
];

export const deviceMigrations: readonly Migration[] = [
  {
    version: 13,
    name: 'offline_sync_grants_for_shop_roles',
    statements: grants.map(
      (grant) => `INSERT OR IGNORE INTO role_permissions (id,role_id,permission_id)
      SELECT '${grant.id}', r.id, p.id
      FROM roles r, permissions p WHERE r.code='${grant.role}' AND p.code='${grant.permission}'`,
    ),
  },
];
