import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, X, AlertCircle } from 'lucide-react';
import type { BootstrapStatus, HealthResponse, SessionResponse } from '@medimart/shared';
import type { Runtime } from '../platform/types';
import { ApiClient, ApiClientError } from '../lib/api';
import { AppContext, type AppContextValue, type ConnectionStatus } from '../lib/context';
type Snapshot = {
  connection: ConnectionStatus;
  bootstrap: BootstrapStatus | null;
  session: SessionResponse | null;
};
async function readWorkspace(api: ApiClient, runtime: Runtime): Promise<Snapshot> {
  if (runtime.native && !runtime.serverUrl)
    return { connection: 'unconfigured', bootstrap: null, session: null };
  try {
    const health = await api.request<HealthResponse>('/api/health');
    if (health.status !== 'ok' || health.database !== 'ready')
      throw new Error('Not a healthy MediMart API.');
    const bootstrap = await api.request<BootstrapStatus>('/api/auth/bootstrap-status');
    let session: SessionResponse | null = null;
    try {
      session = await api.request<SessionResponse>('/api/auth/session');
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 401)) throw error;
    }
    return { connection: 'online', bootstrap, session };
  } catch {
    return { connection: 'offline', bootstrap: null, session: null };
  }
}
export function AppProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  const api = useMemo(() => new ApiClient(runtime), [runtime]);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>(
    runtime.native && !runtime.serverUrl ? 'unconfigured' : 'checking',
  );
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    tone: 'success' | 'error' | 'info';
    /** Stable identity so re-showing the same message restarts its timer instead of being ignored. */
    id: number;
  } | null>(null);
  // Prevent a stale background session check from undoing a newer login/logout/server change.
  const epoch = useRef(0);
  const authBusy = useRef(false);
  const toastSeq = useRef(0);
  const notify = useCallback<AppContextValue['notify']>((message, tone = 'info') => {
    toastSeq.current += 1;
    setToast({ message, tone, id: toastSeq.current });
  }, []);
  const acceptSession = useCallback(
    (value: SessionResponse | null) => {
      api.setSession(value);
      // Native tokens have already been moved to Keystore; do not retain them in context.
      setSession(
        value ? { user: value.user, expiresAt: value.expiresAt, csrfToken: value.csrfToken } : null,
      );
    },
    [api],
  );
  const applySnapshot = useCallback(
    (value: Snapshot, requestEpoch: number) => {
      if (requestEpoch !== epoch.current || authBusy.current) return;
      setConnection(value.connection);
      setBootstrap(value.bootstrap);
      acceptSession(
        runtime.native && document.visibilityState !== 'visible' ? null : value.session,
      );
    },
    [acceptSession, runtime.native],
  );
  const refresh = useCallback(async () => {
    if (authBusy.current) return;
    const requestEpoch = ++epoch.current;
    applySnapshot(await readWorkspace(api, runtime), requestEpoch);
  }, [api, applySnapshot, runtime]);
  useEffect(() => {
    const requestEpoch = ++epoch.current;
    void readWorkspace(api, runtime).then((value) => applySnapshot(value, requestEpoch));
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const invalidate = () => {
      ++epoch.current;
    };
    const lock = () => {
      invalidate();
      acceptSession(null);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
      else if (runtime.native) lock();
    };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const removers: (() => Promise<void>)[] = [];
    let disposed = false;
    if (runtime.native) {
      void import('@capacitor/network').then(async ({ Network }) => {
        const handle = await Network.addListener('networkStatusChange', () => {
          void refresh();
        });
        if (disposed) await handle.remove();
        else removers.push(() => handle.remove());
      });
      void import('@capacitor/app').then(async ({ App }) => {
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void refresh();
          else lock();
        });
        if (disposed) await handle.remove();
        else removers.push(() => handle.remove());
      });
    }
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      disposed = true;
      for (const remove of removers) void remove();
    };
  }, [acceptSession, api, applySnapshot, refresh, runtime]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        ++epoch.current;
        acceptSession(null);
        notify('Your session has expired. Sign in again to continue.');
      },
      Math.max(0, new Date(session.expiresAt).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [acceptSession, notify, session]);
  useEffect(() => {
    if (!toast) return;
    /*
     * Dismiss on its own so a confirmation cannot sit on top of the page indefinitely. The timer is
     * keyed to the toast identity, not merely to the object, so a repeated message still expires.
     */
    const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 9000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  /**
   * Send parked offline records as soon as this device is signed in, native, and online.
   * The push is idempotent, so a reconnect storm cannot double-apply anything; a failure is
   * reported once and the records remain pending.
   */
  const syncing = useRef(false);
  useEffect(() => {
    if (!runtime.native || !session || connection !== 'online') return;
    if (syncing.current) return;
    let active = true;
    syncing.current = true;
    void import('../platform/offline')
      .then(async ({ localOfflineSummary, pushOfflineRecords }) => {
        const pending = await localOfflineSummary(runtime);
        if (!active || pending.pending === 0) return;
        const outcome = await pushOfflineRecords(runtime, api);
        if (!active || outcome.sent === 0) return;
        notify(
          `${outcome.applied + outcome.duplicates} offline record(s) synchronized${outcome.rejected ? `, ${outcome.rejected} need attention` : ''}.`,
          outcome.rejected ? 'info' : 'success',
        );
        await refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        syncing.current = false;
      });
    return () => {
      active = false;
    };
  }, [api, connection, notify, refresh, runtime, session]);
  const value: AppContextValue = {
    runtime,
    api,
    user: session?.user ?? null,
    session,
    connection,
    bootstrap,
    refresh,
    notify,
    async signIn(input) {
      ++epoch.current;
      authBusy.current = true;
      try {
        const proof = runtime.native ? await runtime.deviceProof() : null;
        if (runtime.native && !proof)
          throw new Error('Pair this device in Settings before signing in.');
        const result = await api.request<SessionResponse>('/api/auth/login', 'POST', {
          ...input,
          ...(proof ? { device: proof } : {}),
        });
        if (runtime.native && result.token) await runtime.saveToken(result.token);
        acceptSession(result);
        setConnection('online');
        notify(`Welcome back, ${result.user.fullName.split(' ')[0]}.`, 'success');
      } finally {
        ++epoch.current;
        authBusy.current = false;
      }
    },
    async registerOwner(input) {
      if (runtime.native)
        throw new Error(
          'Create the first owner account using the central server browser. Then pair this device.',
        );
      ++epoch.current;
      authBusy.current = true;
      try {
        const result = await api.request<SessionResponse>(
          '/api/auth/register-owner',
          'POST',
          input,
        );
        acceptSession(result);
        setBootstrap({ required: false, enabled: false });
        notify('Your owner account is ready. Welcome to MediMart.', 'success');
      } finally {
        ++epoch.current;
        authBusy.current = false;
      }
    },
    async signOut(all = false) {
      ++epoch.current;
      authBusy.current = true;
      try {
        try {
          await api.request(`/api/auth/${all ? 'logout-all' : 'logout'}`, 'POST');
        } catch (error) {
          if (runtime.native) {
            await runtime.clearToken();
            acceptSession(null);
            notify(
              'Signed out locally. The disconnected server could not revoke the session; it remains valid until expiry.',
              'error',
            );
            return;
          }
          throw error;
        }
        if (runtime.native) await runtime.clearToken();
        acceptSession(null);
        notify(all ? 'Signed out of all sessions.' : 'You have been signed out.', 'success');
      } finally {
        ++epoch.current;
        authBusy.current = false;
      }
    },
    async saveServer(url) {
      ++epoch.current;
      await runtime.setServerUrl(url);
      acceptSession(null);
      await refresh();
      notify('Server address saved on this device.', 'success');
    },
  };
  const ToastIcon =
    toast?.tone === 'success' ? CheckCircle2 : toast?.tone === 'error' ? AlertCircle : Info;
  return (
    <AppContext.Provider value={value}>
      {children}
      {toast && (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <ToastIcon size={20} />
          <span>{toast.message}</span>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
