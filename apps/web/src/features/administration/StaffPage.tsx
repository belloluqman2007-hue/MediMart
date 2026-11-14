import { useMemo, useState } from 'react';
import { Ban, CheckCircle2, KeyRound, Plus, ShieldCheck, UserRoundCog, Users } from 'lucide-react';
import { hasPermission, roleCodes, roleLabels, type RoleCode } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Badge, Button, FormError, Modal, PageHeading } from '../../components/ui';
import {
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  SearchField,
  StatusBadge,
} from '../inventory/shared';
import { formatDateTime, useAsync } from '../inventory/lib';
import { useDebounced } from './useDebounced';

type StaffRow = {
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

type PendingAction =
  | { kind: 'roles'; staff: StaffRow }
  | { kind: 'status'; staff: StaffRow }
  | { kind: 'password'; staff: StaffRow }
  | null;

export function StaffPage() {
  const { api, user } = useApp();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const canManage = Boolean(user && hasPermission(user.permissions, 'staff.manage'));
  const canGrantRoles = Boolean(user && hasPermission(user.permissions, 'permissions.manage'));

  const staff = useAsync(
    () =>
      api
        .request<{ users: StaffRow[] }>(
          `/api/staff${debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : ''}`,
        )
        .then((data) => data.users),
    [debouncedSearch],
  );
  const rows = staff.data;

  const summary = useMemo(() => {
    const list = rows ?? [];
    return {
      total: list.length,
      active: list.filter((row) => row.status === 'active').length,
      disabled: list.filter((row) => row.status === 'disabled').length,
      signedIn: list.filter((row) => row.activeSessions > 0).length,
    };
  }, [rows]);

  return (
    <>
      <PageHeading
        title="Staff"
        description="Every person who signs in to MediMart gets their own account and their own permissions. Nothing is shared."
        action={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} /> Add staff
            </Button>
          )
        }
      />
      {message && (
        <div className="notice notice-success" role="status">
          <CheckCircle2 size={16} /> {message}
        </div>
      )}
      <div className="insight-strip">
        <div className="insight">
          <span className="insight-label">Accounts</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="insight">
          <span className="insight-label">Active</span>
          <strong>{summary.active}</strong>
        </div>
        <div className="insight">
          <span className="insight-label">Signed in now</span>
          <strong>{summary.signedIn}</strong>
        </div>
        <div className="insight">
          <span className="insight-label">Disabled</span>
          <strong>{summary.disabled}</strong>
        </div>
      </div>
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Team accounts</h2>
            <p>
              Roles decide what each person can see and do. Changes take effect on their next
              request — no sign-out needed.
            </p>
          </div>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search name or email…"
            label="Search staff"
          />
        </div>
        {staff.error ? (
          <ErrorBlock message={staff.error} onRetry={staff.reload} />
        ) : !rows ? (
          <LoadingBlock label="Loading your team…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title={search ? 'No matching accounts' : 'No staff accounts yet'}
            message={
              search
                ? 'Try a different name or email address.'
                : 'Invite your pharmacist, cashier or storekeeper so their work is attributed to them.'
            }
            action={
              canManage && !search ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus size={16} /> Add your first staff member
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Last active</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelf = row.id === user?.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="person-cell">
                          <span className="person-avatar" aria-hidden="true">
                            {initials(row.fullName)}
                          </span>
                          <div>
                            <div className="table-primary">{row.fullName}</div>
                            <small className="muted">{row.email}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="badge-row">
                          {row.roles.length === 0 ? (
                            <span className="muted small">No role assigned</span>
                          ) : (
                            row.roles.map((role) => (
                              <Badge key={role} tone={role === 'owner' ? 'green' : 'neutral'}>
                                {roleLabels[role] ?? role}
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td>
                        {row.status === 'active' ? (
                          <StatusBadge tone="green">Active</StatusBadge>
                        ) : (
                          <StatusBadge tone="red">Disabled</StatusBadge>
                        )}
                        {row.lockedUntil && new Date(row.lockedUntil) > new Date() && (
                          <div>
                            <small className="muted">Temporarily locked</small>
                          </div>
                        )}
                      </td>
                      <td className="numeric">{row.activeSessions}</td>
                      <td>
                        <span className="muted small">
                          {row.lastSignInAt ? formatDateTime(row.lastSignInAt) : 'Never signed in'}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          {canGrantRoles && (
                            <Button
                              variant="ghost"
                              onClick={() => setPending({ kind: 'roles', staff: row })}
                              title={`Change roles for ${row.fullName}`}
                            >
                              <ShieldCheck size={15} /> Roles
                            </Button>
                          )}
                          {canManage && !isSelf && (
                            <>
                              <Button
                                variant="ghost"
                                onClick={() => setPending({ kind: 'password', staff: row })}
                                title="Issue a new password"
                              >
                                <KeyRound size={15} /> Password
                              </Button>
                              {row.status === 'active' ? (
                                <Button
                                  variant="ghost"
                                  onClick={() => setPending({ kind: 'status', staff: row })}
                                >
                                  <Ban size={15} /> Disable
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  onClick={() => setPending({ kind: 'status', staff: row })}
                                >
                                  <CheckCircle2 size={15} /> Enable
                                </Button>
                              )}
                            </>
                          )}
                          {isSelf && <span className="muted small">This is you</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && (
        <CreateStaffDialog
          open
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            setMessage(`${name} can now sign in with the password you set.`);
            staff.reload();
          }}
        />
      )}
      {pending?.kind === 'roles' && (
        <RolesDialog
          key={pending.staff.id}
          pending={pending.staff}
          onClose={() => setPending(null)}
          onSaved={(name) => {
            setPending(null);
            setMessage(`Roles updated for ${name}. Their access changed immediately.`);
            staff.reload();
          }}
        />
      )}
      {pending?.kind === 'status' && (
        <StatusDialog
          key={pending.staff.id}
          pending={pending.staff}
          onClose={() => setPending(null)}
          onSaved={(text) => {
            setPending(null);
            setMessage(text);
            staff.reload();
          }}
        />
      )}
      {pending?.kind === 'password' && (
        <PasswordDialog
          key={pending.staff.id}
          pending={pending.staff}
          onClose={() => setPending(null)}
          onSaved={(name) => {
            setPending(null);
            setMessage(`A new password was set for ${name}. Their other sessions were signed out.`);
            staff.reload();
          }}
        />
      )}
    </>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function CreateStaffDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { api } = useApp();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<RoleCode[]>(['cashier']);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.request('/api/staff', 'POST', { fullName, email, password, roles });
      onCreated(fullName);
    } catch (problem) {
      const failure = problem as Error & { fields?: Record<string, string[]> };
      setError(failure.message);
      setFieldErrors(failure.fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a staff member">
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-intro">
          Give them the password in person. They should change it from Settings after their first
          sign-in.
        </p>
        <FormError message={error} />
        <Field label="Full name" error={fieldErrors.fullName?.[0]}>
          <input
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <Field label="Email address" error={fieldErrors.email?.[0]}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <Field
          label="Temporary password"
          hint="At least 12 characters. Avoid the person's name or the shop name."
          error={fieldErrors.password?.[0]}
        >
          <input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <RolePicker value={roles} onChange={setRoles} />
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create account
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RolePicker({
  value,
  onChange,
  disabledRoles = [],
}: {
  value: RoleCode[];
  onChange: (roles: RoleCode[]) => void;
  disabledRoles?: RoleCode[];
}) {
  const toggle = (role: RoleCode) => {
    onChange(value.includes(role) ? value.filter((item) => item !== role) : [...value, role]);
  };
  return (
    <fieldset className="field-label role-picker">
      <legend>Roles</legend>
      <div className="role-options">
        {roleCodes.map((role) => {
          const selected = value.includes(role);
          const locked = disabledRoles.includes(role);
          return (
            <label
              key={role}
              className={`role-option ${selected ? 'is-selected' : ''} ${locked ? 'is-locked' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected}
                disabled={locked}
                onChange={() => toggle(role)}
              />
              <UserRoundCog size={15} />
              <span>{roleLabels[role]}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function RolesDialog({
  pending,
  onClose,
  onSaved,
}: {
  pending: StaffRow | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { api } = useApp();
  // Mounted only while a target exists (see the call site), so the initial value is the target's.
  const [roles, setRoles] = useState<RoleCode[]>(pending?.roles ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;
  const ownerLocked = pending.roles.includes('owner');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/staff/${pending.id}/roles`, 'PUT', { roles });
      onSaved(pending.fullName);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Roles for ${pending.fullName}`}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="dialog-intro">
          A person may hold more than one role; their access is the union of the roles. You cannot
          grant a role that holds permissions you do not have yourself.
        </p>
        <FormError message={error} />
        <RolePicker
          value={roles}
          onChange={setRoles}
          disabledRoles={ownerLocked ? ['owner'] : []}
        />
        {ownerLocked && (
          <p className="muted small">
            The owner role is protected and cannot be removed here. Transfer ownership explicitly in
            Settings.
          </p>
        )}
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save roles
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function StatusDialog({
  pending,
  onClose,
  onSaved,
}: {
  pending: StaffRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { api } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!pending) return null;
  const disabling = pending.status === 'active';

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/staff/${pending.id}/${disabling ? 'disable' : 'enable'}`, 'POST', {});
      onSaved(
        disabling
          ? `${pending.fullName} is disabled and signed out everywhere. Their records stay intact.`
          : `${pending.fullName} can sign in again.`,
      );
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <ConfirmDialog
        open
        danger={disabling}
        busy={busy}
        title={disabling ? `Disable ${pending.fullName}?` : `Enable ${pending.fullName}?`}
        message={
          disabling
            ? 'They will be signed out of every device immediately and cannot sign in again until you enable them. Their past sales, stock movements and audit entries are preserved and still show their name.'
            : 'They will be able to sign in again with their existing password and roles.'
        }
        confirmLabel={disabling ? 'Disable account' : 'Enable account'}
        onConfirm={() => void run()}
        onCancel={onClose}
      />
      {error && (
        <div className="toast-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

function PasswordDialog({
  pending,
  onClose,
  onSaved,
}: {
  pending: StaffRow | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { api } = useApp();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/staff/${pending.id}/reset-password`, 'POST', { password });
      onSaved(pending.fullName);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Reset password for ${pending.fullName}`}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-intro">
          Set a new password and hand it over in person. Every existing session for this account is
          signed out, so a lost phone cannot keep working.
        </p>
        <FormError message={error} />
        <Field label="New password" hint="At least 12 characters.">
          <input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <div className="form-actions">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Set new password
          </Button>
        </div>
      </form>
    </Modal>
  );
}
