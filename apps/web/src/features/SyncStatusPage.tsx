import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission } from '@medimart/shared';
import { readSyncStatus } from '@medimart/database';
import { Button, FormError, PageHeading } from '../components/ui';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/api';

type Counts = Awaited<ReturnType<typeof readSyncStatus>>;

/** Diagnostics only: this page does not send or alter operations. */
export function SyncStatusPage() {
  const { user, runtime, connection, api, refresh } = useApp();
  const allowed = !!user && hasPermission(user.permissions, 'sync.view');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!allowed) return;
    setError(null);
    try {
      const result =
        runtime.native && runtime.database && runtime.deviceId
          ? await readSyncStatus(runtime.database, runtime.deviceId)
          : await api.request<Counts>('/api/sync/status');
      setCounts(result);
    } catch (caught) {
      setCounts(null);
      setError(errorMessage(caught));
    }
  }, [allowed, api, runtime]);
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    // Avoid a late query displaying counts after the session has been revoked or expired.
    void (async () => {
      try {
        const result =
          runtime.native && runtime.database && runtime.deviceId
            ? await readSyncStatus(runtime.database, runtime.deviceId)
            : await api.request<Counts>('/api/sync/status');
        if (active) {
          setCounts(result);
          setError(null);
        }
      } catch (caught) {
        if (active) {
          setCounts(null);
          setError(errorMessage(caught));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [allowed, api, runtime]);
  return (
    <>
      <PageHeading
        eyebrow="Administration"
        title="Backup and Sync"
        description="Connection and queue diagnostics"
      />
      <section className="card settings-card">
        <h2>Synchronization is not available</h2>
        <p>
          Offline business operations, synchronization and backup or restoration are not
          implemented. A connection to the central computer is required for business operations.
        </p>
        <p>
          Do not clear app data or uninstall the Android app. Contact an administrator before
          attempting recovery.
        </p>
        <div className="regional-grid">
          <div>
            <span>Connection</span>
            <strong>
              {connection === 'online'
                ? 'Central server reachable'
                : connection === 'checking'
                  ? 'Checking'
                  : connection === 'unconfigured'
                    ? 'Server not configured'
                    : 'Server unavailable'}
            </strong>
          </div>
          <div>
            <span>Server</span>
            <strong>
              {runtime.native ? runtime.serverUrl || 'Not configured' : window.location.origin}
            </strong>
          </div>
          <div>
            <span>Device identity</span>
            <strong>{runtime.native ? runtime.deviceId : 'Browser client'}</strong>
          </div>
          <div>
            <span>Last successful synchronization</span>
            <strong>Not available</strong>
          </div>
        </div>
        <p>
          Reachability is not confirmation that data has synchronized. Check Wi-Fi and the server
          address if the computer is unavailable.
        </p>
        <Link className="button button-secondary" to="/settings?tab=connection">
          Connection &amp; pairing settings
        </Link>
      </section>
      <section className="card settings-card">
        <h2>Queue diagnostics</h2>
        {!allowed ? (
          <p>
            {user
              ? 'Your account needs sync.view to inspect queue counts.'
              : 'Sign in while connected to view queue counts. Offline authorization is not available.'}
          </p>
        ) : (
          <>
            <p>
              {runtime.native ? 'This Android installation' : 'Central database'} · Counts only; no
              transaction details are shown.
            </p>
            <FormError message={error} />
            {counts && (
              <div className="regional-grid">
                <div>
                  <span>Pending</span>
                  <strong>{counts.pending}</strong>
                </div>
                <div>
                  <span>In flight</span>
                  <strong>{counts.inFlight}</strong>
                </div>
                <div>
                  <span>Acknowledged</span>
                  <strong>{counts.acknowledged}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{counts.failed}</strong>
                </div>
                <div>
                  <span>Conflicted operations</span>
                  <strong>{counts.conflicted}</strong>
                </div>
                <div>
                  <span>Open conflict records</span>
                  <strong>{counts.openConflicts}</strong>
                </div>
              </div>
            )}
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  await refresh();
                  await load();
                })().finally(() => setBusy(false));
              }}
            >
              Refresh diagnostics
            </Button>
          </>
        )}
        <p>
          Refresh checks status only; it does not send, retry, resolve or delete operations. A Sync
          Now action is unavailable until a verified sync engine exists.
        </p>
      </section>
    </>
  );
}
