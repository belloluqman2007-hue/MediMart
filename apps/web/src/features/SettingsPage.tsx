import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  Database,
  Globe2,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  businessSettingsSchema,
  changePasswordSchema,
  hasPermission,
  roleCodes,
  roleLabels,
  staffRegistrationSchema,
  type DeviceSummary,
  type RoleCode,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/api';
import { Badge, Button, FormError, Modal, PageHeading } from '../components/ui';
const tabs = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'connection', label: 'Connection & storage', icon: Server },
  { id: 'team', label: 'Staff access', icon: Users },
  { id: 'devices', label: 'Device pairing', icon: Smartphone },
];
function SignInPrompt({ capability }: { capability?: string }) {
  const { user, bootstrap } = useApp();
  return (
    <div className="settings-access">
      <span className="empty-icon">
        <LockKeyhole size={25} />
      </span>
      <div>
        <h3>{user ? 'This setting needs additional access' : 'Make this workspace yours'}</h3>
        <p>
          {user
            ? `Your account needs ${capability}. Ask your owner or administrator for help.`
            : 'Sign in with your own account to manage business settings and staff access.'}
        </p>
        {!user && (
          <Link to={bootstrap?.required ? '/register' : '/login'} className="button button-primary">
            {bootstrap?.required ? 'Create owner account' : 'Sign in to continue'}
            <ArrowRight size={15} />
          </Link>
        )}
      </div>
    </div>
  );
}
function PasswordChangeForm() {
  const { api, runtime, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    const input = changePasswordSchema.safeParse({
      currentPassword: data.get('currentPassword'),
      newPassword: data.get('newPassword'),
    });
    if (!input.success) {
      setError(input.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    if (input.data.newPassword !== data.get('confirmPassword')) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.request('/api/auth/change-password', 'POST', input.data);
      if (runtime.native) await runtime.clearToken();
      await refresh();
      notify(
        'Password changed. All sessions ended; sign in again with your new password.',
        'success',
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="password-change">
      <summary>Change your password</summary>
      <p className="small muted">
        Verify your current password to choose a new one. This signs out every session on every
        device.
      </p>
      <FormError message={error} />
      <form
        onSubmit={(event) => {
          void change(event);
        }}
      >
        <label className="field-label">
          Current password
          <input
            aria-label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
          />
        </label>
        <div className="form-two-columns">
          <label className="field-label">
            New password
            <input
              aria-label="New password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <label className="field-label">
            Confirm new password
            <input
              aria-label="Confirm new password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
            />
          </label>
        </div>
        <Button busy={busy} type="submit">
          <KeyRound size={15} />
          Change password & sign out
        </Button>
      </form>
    </details>
  );
}
function GeneralSettings() {
  const { user, api, notify, session, signOut } = useApp();
  const [businessName, setBusinessName] = useState('MediMart');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRead = user && hasPermission(user.permissions, 'settings.view');
  const canEdit = user && hasPermission(user.permissions, 'settings.manage');
  useEffect(() => {
    let alive = true;
    if (canRead)
      void api
        .request<{ businessName: string }>('/api/settings')
        .then((value) => {
          if (alive) setBusinessName(value.businessName);
        })
        .catch((caught) => {
          if (alive) setError(errorMessage(caught));
        });
    return () => {
      alive = false;
    };
  }, [api, canRead]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const input = businessSettingsSchema.safeParse({ businessName });
    if (!input.success) {
      setError(input.error.issues[0]!.message);
      return;
    }
    setBusy(true);
    try {
      await api.request('/api/settings', 'PUT', input.data);
      notify('Business name saved.', 'success');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile green">
            <Settings2 size={20} />
          </div>
          <div>
            <h2>Business details</h2>
            <p>A familiar name for your central workspace.</p>
          </div>
        </div>
        {canRead ? (
          <form
            onSubmit={(event) => {
              void save(event);
            }}
          >
            <FormError message={error} />
            <label className="field-label">
              Business name
              <input
                name="businessName"
                value={businessName}
                onChange={(event) => setBusinessName(event.target.value)}
                minLength={2}
                maxLength={120}
                required
                disabled={!canEdit}
              />
            </label>
            <div className="settings-form-footer">
              <span>Stored in your central SQLite database.</span>
              {canEdit && (
                <Button type="submit" busy={busy}>
                  <Save size={15} />
                  Save changes
                </Button>
              )}
            </div>
          </form>
        ) : (
          <SignInPrompt />
        )}
      </section>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile blue">
            <Globe2 size={20} />
          </div>
          <div>
            <h2>Regional foundation</h2>
            <p>Consistent defaults for a business in Nigeria.</p>
          </div>
        </div>
        <div className="regional-grid">
          <div>
            <span>Currency</span>
            <strong>NGN · Nigerian naira</strong>
          </div>
          <div>
            <span>Money storage</span>
            <strong>Integer kobo</strong>
          </div>
          <div>
            <span>Database timestamps</span>
            <strong>UTC · ISO 8601</strong>
          </div>
        </div>
        <p className="small muted">
          No financial calculations or transactions are implemented in this phase.
        </p>
      </section>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile purple">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h2>Account & security</h2>
            <p>Access is individual, time-limited, and revocable.</p>
          </div>
        </div>
        {user && session ? (
          <>
            <div className="session-detail">
              <div>
                <strong>{user.fullName}</strong>
                <span>{user.email}</span>
              </div>
              <div className="role-badges">
                {user.roles.map((role) => (
                  <Badge key={role} tone="green">
                    {roleLabels[role]}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="session-expiry">
              <LockKeyhole size={15} />
              Session expires{' '}
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(session.expiresAt),
              )}
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                void signOut(true).catch((caught) => notify(errorMessage(caught), 'error'));
              }}
            >
              Sign out of all sessions
            </Button>
            <PasswordChangeForm />
          </>
        ) : (
          <p className="muted">
            You are viewing a read-only preview. No protected records are exposed.
          </p>
        )}
      </section>
    </>
  );
}
function ConnectionSettings() {
  const { runtime, connection, saveServer, refresh, api, notify } = useApp();
  const [address, setAddress] = useState(runtime.serverUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    status: string;
    pairingCode: string | null;
    expiresAt: string | null;
  } | null>(null);
  const [deviceName, setDeviceName] = useState('MediMart Android phone');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveServer(address);
      setAddress(runtime.serverUrl);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function registerDevice() {
    setBusy(true);
    setError(null);
    try {
      const proof = await runtime.deviceProof(true);
      if (!proof) throw new Error('Save a central server address first.');
      const result = await api.request<{
        status: 'pending' | 'approved';
        pairingCode: string | null;
        expiresAt: string | null;
      }>('/api/devices/register', 'POST', { ...proof, name: deviceName, platform: 'android' });
      setPairing(result);
      await runtime.recordPairingStatus(result.status);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function checkPairing() {
    setBusy(true);
    setError(null);
    try {
      const proof = await runtime.deviceProof();
      if (!proof) throw new Error('Request a pairing code first.');
      const result = await api.request<{ status: 'pending' | 'approved' | 'revoked' }>(
        '/api/devices/status',
        'POST',
        proof,
      );
      await runtime.recordPairingStatus(result.status);
      setPairing((previous) => ({
        status: result.status,
        pairingCode: result.status === 'pending' ? (previous?.pairingCode ?? null) : null,
        expiresAt: previous?.expiresAt ?? null,
      }));
      notify(
        result.status === 'approved'
          ? 'Device approved. You can sign in now.'
          : `Device status: ${result.status}.`,
        result.status === 'approved' ? 'success' : 'info',
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile green">
            <Server size={20} />
          </div>
          <div>
            <h2>Central server</h2>
            <p>
              {runtime.native
                ? 'Connect to the computer on your local network.'
                : 'This browser communicates through its current host.'}
            </p>
          </div>
          <Badge tone={connection === 'online' ? 'green' : 'amber'}>
            {connection === 'online' ? <Wifi size={12} /> : <WifiOff size={12} />}
            {connection === 'online' ? 'Connected' : 'Not connected'}
          </Badge>
        </div>
        <FormError message={error} />
        {runtime.native ? (
          <form
            onSubmit={(event) => {
              void save(event);
            }}
          >
            <label className="field-label">
              Server address
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                type="url"
                placeholder="https://medimart.local:3001"
                required
              />
              <small>
                HTTPS with a trusted certificate is required for release builds. No address is
                hardcoded.
              </small>
            </label>
            <div className="settings-form-footer">
              <span>Saved only in this device’s SQLite database.</span>
              <Button type="submit" busy={busy}>
                <Save size={15} />
                Save address
              </Button>
            </div>
          </form>
        ) : (
          <>
            <label className="field-label">
              Workspace origin
              <input value={window.location.origin} readOnly />
            </label>
            <div className="info-box">
              <Server size={20} />
              <p>
                The browser uses relative <code>/api</code> requests. In development, configure{' '}
                <code>API_PROXY_TARGET</code> in the server’s <code>.env</code>. Android phones have
                their own configurable address.
              </p>
            </div>
          </>
        )}
        <Button
          variant="secondary"
          busy={busy}
          onClick={() => {
            setBusy(true);
            void refresh().finally(() => setBusy(false));
          }}
        >
          <RefreshCw size={15} />
          Test connection
        </Button>
      </section>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile blue">
            <Database size={20} />
          </div>
          <div>
            <h2>{runtime.native ? 'Your local database' : 'Database architecture'}</h2>
            <p>Real SQLite storage. No localStorage database.</p>
          </div>
        </div>
        <div className="regional-grid">
          <div>
            <span>This client</span>
            <strong>{runtime.native ? 'Encrypted native SQLite' : 'Central API client'}</strong>
          </div>
          <div>
            <span>Central database</span>
            <strong>SQLite · WAL mode</strong>
          </div>
          <div>
            <span>Synchronization</span>
            <strong>Not implemented yet</strong>
          </div>
        </div>
        <div className="info-box">
          <ShieldCheck size={20} />
          <p>
            {runtime.native
              ? 'Application assets and database migrations are bundled in this installation. A failed database initialization blocks startup rather than falling back to unsafe storage.'
              : 'Your computer hosts the authoritative database. Each Android installation initializes a separate SQLite database.'}{' '}
            Queue, receipt, and conflict records are prepared; no business records are synchronized
            in Phase 1.
          </p>
        </div>
      </section>
      {runtime.native && (
        <section className="card settings-card">
          <div className="settings-card-title">
            <div className="icon-tile purple">
              <Smartphone size={20} />
            </div>
            <div>
              <h2>Pair this device</h2>
              <p>Approve this installation before it can hold a server session.</p>
            </div>
          </div>
          <div className="device-id">
            <span>Installation ID</span>
            <code>{runtime.deviceId}</code>
            <button
              className="icon-button"
              aria-label="Copy installation ID"
              onClick={() => {
                void navigator.clipboard
                  .writeText(runtime.deviceId!)
                  .then(() => notify('Installation ID copied.', 'success'))
                  .catch(() =>
                    notify('Clipboard unavailable. Copy the displayed ID manually.', 'error'),
                  );
              }}
            >
              <Copy size={15} />
            </button>
          </div>
          <label className="field-label">
            Device name
            <input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              minLength={2}
              maxLength={120}
            />
          </label>
          {pairing && (
            <div className="pairing-code-panel">
              <Badge tone={pairing.status === 'approved' ? 'green' : 'amber'}>
                {pairing.status}
              </Badge>
              {pairing.pairingCode && (
                <>
                  <strong className="pairing-code">{pairing.pairingCode}</strong>
                  <p>Enter this code on the central server under Settings → Device pairing.</p>
                  <small>Expires {new Date(pairing.expiresAt!).toLocaleTimeString()}</small>
                </>
              )}
              {pairing.status === 'approved' && (
                <Link className="button button-primary" to="/login">
                  Sign in on this device
                  <ArrowRight size={15} />
                </Link>
              )}
            </div>
          )}
          <div className="button-row">
            <Button
              busy={busy}
              disabled={!runtime.serverUrl || deviceName.trim().length < 2}
              onClick={() => {
                void registerDevice();
              }}
            >
              <KeyRound size={15} />
              Request pairing code
            </Button>
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => {
                void checkPairing();
              }}
            >
              <RefreshCw size={15} />
              Check approval
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
function TeamSettings() {
  const { user, api, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user || !hasPermission(user.permissions, 'staff.manage'))
    return (
      <section className="card settings-card">
        <SignInPrompt capability="staff.manage" />
      </section>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = staffRegistrationSchema.safeParse({
      fullName: data.get('fullName'),
      email: data.get('email'),
      password: data.get('password'),
      roles: [data.get('role')],
    });
    if (!input.success) {
      setError(input.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setBusy(true);
    try {
      await api.request('/api/staff', 'POST', input.data);
      form.reset();
      notify('Individual staff account created.', 'success');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const roles: RoleCode[] = roleCodes.filter(
    (role) => role !== 'owner' && (role !== 'administrator' || user.roles.includes('owner')),
  );
  return (
    <section className="card settings-card">
      <div className="settings-card-title">
        <div className="icon-tile green">
          <UserPlus size={20} />
        </div>
        <div>
          <h2>Create a staff account</h2>
          <p>Give each person a role that fits their work.</p>
        </div>
        <Badge>FOUNDATION</Badge>
      </div>
      <div className="info-box">
        <ShieldCheck size={20} />
        <p>
          This is initial account registration, not the full Staff module. Permissions are enforced
          by the API. Only an owner can create administrators; the owner role cannot be assigned
          here.
        </p>
      </div>
      <FormError message={error} />
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="settings-form"
      >
        <div className="form-two-columns">
          <label className="field-label">
            Full name
            <input
              name="fullName"
              autoComplete="off"
              minLength={2}
              maxLength={120}
              required
              placeholder="Staff member’s name"
            />
          </label>
          <label className="field-label">
            Email address
            <input
              name="email"
              type="email"
              autoComplete="off"
              maxLength={254}
              required
              placeholder="staff@yourbusiness.com"
            />
          </label>
        </div>
        <label className="field-label">
          Role
          <select aria-label="Role" name="role" defaultValue="cashier">
            {roles.map((role) => (
              <option key={role} value={role}>
                {roleLabels[role]}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Initial password
          <input
            aria-label="Initial password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            placeholder="A unique passphrase of at least 12 characters"
          />
          <small>Share privately with this staff member. Never reuse a shared team password.</small>
        </label>
        <div className="settings-form-footer">
          <span>Full staff management is a later-phase module.</span>
          <Button type="submit" busy={busy}>
            <UserPlus size={16} />
            Create staff account
          </Button>
        </div>
      </form>
    </section>
  );
}
function DeviceSettings() {
  const { user, api, notify } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'devices.manage'));
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeviceSummary | null>(null);
  const [code, setCode] = useState('');
  const [action, setAction] = useState<'approve' | 'revoke'>('approve');
  const load = useCallback(async () => {
    if (!allowed) return;
    setBusy(true);
    setError(null);
    try {
      setDevices((await api.request<{ devices: DeviceSummary[] }>('/api/devices')).devices);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [allowed, api]);
  useEffect(() => {
    let alive = true;
    if (allowed)
      void api
        .request<{ devices: DeviceSummary[] }>('/api/devices')
        .then((result) => {
          if (alive) setDevices(result.devices);
        })
        .catch((caught) => {
          if (alive) setError(errorMessage(caught));
        });
    return () => {
      alive = false;
    };
  }, [allowed, api]);
  if (!allowed)
    return (
      <section className="card settings-card">
        <SignInPrompt capability="devices.manage" />
      </section>
    );
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.request(
        `/api/devices/${selected.id}/${action}`,
        'POST',
        action === 'approve' ? { pairingCode: code } : {},
      );
      setSelected(null);
      setCode('');
      await load();
      notify(
        action === 'approve'
          ? 'Device approved for sign-in.'
          : 'Device revoked and its server sessions ended.',
        'success',
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card settings-card">
        <div className="settings-card-title">
          <div className="icon-tile green">
            <Smartphone size={20} />
          </div>
          <div>
            <h2>Registered devices</h2>
            <p>Verify the physical device before approving its code.</p>
          </div>
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => {
              void load();
            }}
          >
            <RefreshCw size={15} />
            Refresh
          </Button>
        </div>
        {!selected && <FormError message={error} />}
        {devices.length ? (
          <div className="device-list">
            {devices.map((device) => (
              <div className="device-row" key={device.id}>
                <span className="icon-tile blue">
                  <Smartphone size={20} />
                </span>
                <div className="device-row-detail">
                  <strong>{device.name}</strong>
                  <code>{device.id}</code>
                  <small>
                    {device.platform} · {new Date(device.created_at).toLocaleDateString()}
                  </small>
                </div>
                <Badge
                  tone={
                    device.status === 'approved'
                      ? 'green'
                      : device.status === 'pending'
                        ? 'amber'
                        : 'neutral'
                  }
                >
                  {device.status}
                </Badge>
                <div className="device-actions">
                  {device.status === 'pending' && (
                    <Button
                      onClick={() => {
                        setSelected(device);
                        setAction('approve');
                        setCode('');
                        setError(null);
                      }}
                    >
                      Approve
                    </Button>
                  )}
                  {device.status !== 'revoked' && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setSelected(device);
                        setAction('revoke');
                        setError(null);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <div className="empty-icon">
              <Smartphone size={29} />
            </div>
            <h3>Your team’s devices will live here</h3>
            <p>
              On an Android phone, open Settings → Connection & storage, add this server’s address,
              and request a pairing code.
            </p>
            <Badge>No devices registered</Badge>
          </div>
        )}
        <div className="info-box">
          <ShieldCheck size={20} />
          <p>
            Pairing codes expire after 10 minutes. Five incorrect approval attempts lock the
            request. Revoked devices cannot re-enroll themselves. Pairing does not start
            synchronization.
          </p>
        </div>
      </section>
      <Modal
        open={Boolean(selected)}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        title={action === 'approve' ? 'Approve this device' : 'Revoke this device'}
      >
        <form
          onSubmit={(event) => {
            void confirm(event);
          }}
          className="settings-form"
        >
          <p>{selected?.name}</p>
          <FormError message={error} />
          {action === 'approve' ? (
            <label className="field-label">
              Eight-digit pairing code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{8}"
                minLength={8}
                maxLength={8}
                required
                placeholder="00000000"
              />
              <small>Read this code directly from the phone you intend to approve.</small>
            </label>
          ) : (
            <div className="info-box warning">
              <LockKeyhole size={20} />
              <p>
                All server sessions on this device will end immediately. Its local records are not
                deleted. Re-enrollment of revoked devices is not available in Phase 1.
              </p>
            </div>
          )}
          <div className="button-row">
            <Button variant={action === 'approve' ? 'primary' : 'danger'} type="submit" busy={busy}>
              {action === 'approve' ? <CheckCircle2 size={16} /> : <LockKeyhole size={16} />}
              {action === 'approve' ? 'Approve device' : 'Revoke access'}
            </Button>
            <Button
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('tab') || 'general';
  const tab = tabs.some((item) => item.id === selected) ? selected : 'general';
  return (
    <>
      <PageHeading
        title="Workspace settings"
        description="A few thoughtful details. A workspace that feels like yours."
        action={
          <Badge tone="green">
            <ShieldCheck size={12} />
            SECURE BY DESIGN
          </Badge>
        }
      />
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            id={`tab-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => {
              const index = tabs.findIndex((value) => value.id === item.id);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                const nextTab = tabs[next]!;
                setParams({ tab: nextTab.id });
                document.getElementById(`tab-${nextTab.id}`)?.focus();
              }
            }}
            onClick={() => setParams({ tab: item.id })}
            className={tab === item.id ? 'selected' : ''}
          >
            <item.icon size={17} />
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="settings-content"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'general' ? (
          <GeneralSettings />
        ) : tab === 'connection' ? (
          <ConnectionSettings />
        ) : tab === 'team' ? (
          <TeamSettings />
        ) : (
          <DeviceSettings />
        )}
      </div>
    </>
  );
}
