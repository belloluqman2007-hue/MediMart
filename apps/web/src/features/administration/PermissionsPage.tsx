import { useMemo, useState } from 'react';
import { CheckCircle2, Info, LoaderCircle, ShieldCheck } from 'lucide-react';
import {
  hasPermission,
  permissionDescriptions,
  permissions as permissionCatalogue,
  roleCodes,
  roleLabels,
  type Permission,
  type RoleCode,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Badge, PageHeading } from '../../components/ui';
import { useAsync } from '../inventory/lib';
import { ErrorBlock, LoadingBlock, SearchField } from '../inventory/shared';
import { useDebounced } from './useDebounced';

type CatalogueEntry = { code: string; description: string };
type Payload = {
  roles: { id: string; code: RoleCode; name: string }[];
  grants: { role: RoleCode; permission: string }[];
  catalogue: CatalogueEntry[];
};

/**
 * Groups the flat permission catalogue into the areas a shopkeeper thinks in, so the matrix reads as
 * "what the pharmacist can do in the pharmacy" instead of 69 alphabetical codes.
 */
const permissionGroups: { key: string; label: string; match: (permission: string) => boolean }[] = [
  { key: 'workspace', label: 'Workspace & dashboard', match: (p) => p.startsWith('dashboard.') },
  {
    key: 'pos',
    label: 'Point of sale',
    match: (p) => p.startsWith('pos.') || p.startsWith('sales.'),
  },
  {
    key: 'inventory',
    label: 'Inventory & products',
    match: (p) => p.startsWith('inventory.') || p.startsWith('products.'),
  },
  { key: 'batches', label: 'Batches & expiry', match: (p) => p.startsWith('batches.') },
  {
    key: 'purchasing',
    label: 'Purchasing & suppliers',
    match: (p) => p.startsWith('purchases.') || p.startsWith('suppliers.'),
  },
  {
    key: 'customers',
    label: 'Customers, debts & payments',
    match: (p) =>
      p.startsWith('customers.') ||
      p.startsWith('debts.') ||
      p.startsWith('payments.') ||
      p.startsWith('cash_register.'),
  },
  {
    key: 'patients',
    label: 'Patients & clinical records',
    match: (p) => p.startsWith('patients.') || p.startsWith('consultations.'),
  },
  {
    key: 'prescriptions',
    label: 'Prescriptions & dispensing',
    match: (p) => p.startsWith('prescriptions.'),
  },
  {
    key: 'finance',
    label: 'Expenses & financial reports',
    match: (p) => p.startsWith('expenses.') || p.startsWith('reports.'),
  },
  {
    key: 'admin',
    label: 'Administration & security',
    match: (p) => /^(staff\.|permissions\.|audit\.|settings\.|devices\.|sync\.|backup\.)/.test(p),
  },
  {
    key: 'categories',
    label: 'Categories & units',
    match: (p) => p.startsWith('categories.') || p.startsWith('units.'),
  },
  {
    key: 'retail',
    label: 'Workspaces',
    match: (p) => p.startsWith('minimart.') || p.startsWith('pharmacy.'),
  },
];

function groupFor(permission: string) {
  return permissionGroups.find((group) => group.match(permission))?.key ?? 'other';
}

export function PermissionsPage() {
  const { api, user } = useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [activeRole, setActiveRole] = useState<RoleCode>('pharmacist');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 200);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const canManage = Boolean(user && hasPermission(user.permissions, 'permissions.manage'));

  const catalogue = useAsync(() => api.request<Payload>('/api/permissions'), []);
  // A successful reload replaces the local grant copy that optimistic toggles maintain.
  const loaded = catalogue.data;
  const payload = data ?? loaded;

  const granted = useMemo(() => {
    const map = new Map<RoleCode, Set<string>>();
    for (const role of roleCodes) map.set(role, new Set());
    for (const grant of payload?.grants ?? []) map.get(grant.role)?.add(grant.permission);
    return map;
  }, [payload]);

  /**
   * The database stores a short technical description written when each permission was introduced;
   * the shared catalogue carries the reviewed plain-language wording. Prefer the reviewed wording,
   * fall back to the stored one for any permission the database knows but this build does not.
   */
  const descriptions = useMemo(() => {
    const map = new Map<string, string>(Object.entries(permissionDescriptions));
    for (const entry of payload?.catalogue ?? [])
      if (!map.has(entry.code)) map.set(entry.code, entry.description);
    return map;
  }, [payload]);

  const visiblePermissions = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    return (permissionCatalogue as readonly string[]).filter((permission) => {
      if (!needle) return true;
      return (
        permission.toLowerCase().includes(needle) ||
        (descriptions.get(permission) ?? '').toLowerCase().includes(needle)
      );
    });
  }, [debounced, descriptions]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, string[]>();
    for (const permission of visiblePermissions) {
      const key = groupFor(permission);
      const list = buckets.get(key) ?? [];
      list.push(permission);
      buckets.set(key, list);
    }
    // Known groups in catalogue order first; any unmapped permission falls into a trailing "Other".
    const rank = (key: string) => {
      const index = permissionGroups.findIndex((group) => group.key === key);
      return index === -1 ? permissionGroups.length : index;
    };
    return [...buckets.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [visiblePermissions]);

  const toggle = async (role: RoleCode, permission: string, next: boolean) => {
    setSaving(`${role}:${permission}`);
    setFailure(null);
    try {
      await api.request(`/api/permissions/${role}/${encodeURIComponent(permission)}`, 'PUT', {
        granted: next,
      });
      setData((current) =>
        current
          ? {
              ...current,
              grants: next
                ? [...current.grants, { role, permission }]
                : current.grants.filter(
                    (grant) => !(grant.role === role && grant.permission === permission),
                  ),
            }
          : current,
      );
      setMessage(
        `${roleLabels[role]} ${next ? 'can now' : 'can no longer'} ${describe(permission, descriptions)}.`,
      );
    } catch (problem) {
      setFailure((problem as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const activeGrants = granted.get(activeRole) ?? new Set<string>();

  return (
    <>
      <PageHeading
        title="Permissions"
        description="Choose exactly what each role can do. The server enforces every rule — hiding a button is never the protection."
      />
      {message && (
        <div className="notice notice-success" role="status">
          <CheckCircle2 size={16} />
          <span>{message}</span>
          <button className="notice-dismiss" onClick={() => setMessage(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {!canManage && (
        <div className="notice notice-info" role="status">
          <Info size={16} />
          You can review what each role is allowed to do. Changing roles needs the “manage
          permissions” permission, which only the owner holds.
        </div>
      )}
      {catalogue.error ? (
        <ErrorBlock message={catalogue.error} onRetry={catalogue.reload} />
      ) : !payload ? (
        <LoadingBlock label="Loading the permission model…" />
      ) : (
        <>
          <div className="role-tabs" role="tablist" aria-label="Roles">
            {roleCodes.map((role) => {
              const count = granted.get(role)?.size ?? 0;
              return (
                <button
                  key={role}
                  role="tab"
                  aria-selected={activeRole === role}
                  className={`role-tab ${activeRole === role ? 'is-active' : ''}`}
                  onClick={() => setActiveRole(role)}
                >
                  <ShieldCheck size={15} />
                  <span>{roleLabels[role]}</span>
                  <span className="role-tab-count">{count}</span>
                </button>
              );
            })}
          </div>
          <section className="card permission-card">
            <div className="card-heading">
              <div>
                <h2>{roleLabels[activeRole]}</h2>
                <p>
                  {activeGrants.size} of {permissionCatalogue.length} permissions granted.
                  {activeRole === 'owner' &&
                    ' The owner role always holds every permission and is protected from change.'}
                </p>
              </div>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder="Filter permissions…"
                label="Filter permissions"
              />
            </div>
            {failure && (
              <div className="notice notice-error" role="alert">
                {failure}
              </div>
            )}
            <div className="permission-groups">
              {grouped.map(([key, permissions]) => {
                const meta = permissionGroups.find((group) => group.key === key);
                return (
                  <div key={key} className="permission-group">
                    <h3>{meta?.label ?? 'Other'}</h3>
                    <ul>
                      {permissions.map((permission) => {
                        const on = activeGrants.has(permission as Permission);
                        const busy = saving === `${activeRole}:${permission}`;
                        const locked = !canManage || activeRole === 'owner';
                        return (
                          <li key={permission} className={on ? 'is-granted' : ''}>
                            <label className={locked ? 'is-locked' : ''}>
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={locked || busy}
                                onChange={(event) =>
                                  void toggle(activeRole, permission, event.target.checked)
                                }
                              />
                              <span className="permission-text">
                                <code>{permission}</code>
                                <small>
                                  {descriptions.get(permission) ??
                                    describe(permission, descriptions)}
                                </small>
                              </span>
                              {busy && <LoaderCircle size={15} className="spin" />}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
          <p className="permission-footnote">
            <Badge tone="green">Live</Badge> Permission changes are read from the database on every
            request, so a revoked permission stops working immediately — even for a user who is
            already signed in.
          </p>
        </>
      )}
    </>
  );
}

/** Turns `products.import` into "import products", for a message a shopkeeper can read. */
function describe(permission: string, descriptions: Map<string, string>) {
  const described = descriptions.get(permission);
  if (described) return described.replace(/^Can\s+/i, '').replace(/\.$/, '');
  const [area, action] = permission.split('.');
  return `${(action ?? '').replace(/_/g, ' ')} ${area ? area.replace(/_/g, ' ') : permission}`.trim();
}
