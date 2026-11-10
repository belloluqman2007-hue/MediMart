import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  DownloadCloud,
  FolderOpen,
  HardDriveDownload,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  UploadCloud,
} from 'lucide-react';
import {
  offlineRecordTypeLabels,
  offlineStatusLabels,
  type BackupSummary,
  type OfflineSummary,
  type Paginated,
  type SyncStatusResponse,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/api';
import { Badge, Button, FormError, Modal, PageHeading } from '../components/ui';
import { formatDateTime, useAsync } from '../features/inventory/lib';
import { ErrorBlock, Field, LoadingBlock, StatusBadge } from '../features/inventory/shared';
import {
  listLocalOfflineRecords,
  localOfflineSummary,
  offlineAvailable,
  pushOfflineRecords,
  type PushOutcome,
} from '../platform/offline';

type BackupSettings = {
  directory: string;
  automaticEnabled: boolean;
  intervalHours: number;
  retentionCount: number;
  lastRunAt: string | null;
};

type BackupList = {
  directory: string;
  defaultDirectory: string;
  settings: BackupSettings;
  items: BackupSummary[];
};

type RecordSummary = {
  operationId: string;
  recordType: keyof typeof offlineRecordTypeLabels;
  deviceId: string;
  clientDate: string;
  status: 'pending' | 'applied' | 'rejected' | 'conflict';
  reference: string | null;
  receiptNumber: string | null;
  message: string | null;
  attempts: number;
  createdAt: string;
  appliedAt: string | null;
};

const recordStatusLabel = (status: RecordSummary['status']) =>
  offlineStatusLabels[
    status === 'applied' ? 'synced' : (status as keyof typeof offlineStatusLabels)
  ];

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function BackupSyncPage() {
  const { api, runtime, user, notify, refresh } = useApp();
  const native = offlineAvailable(runtime);

  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  /**
   * Deployment data is read with `useAsync`, which keeps request state derived from the request
   * key instead of assigning it inside an effect. Partial failures are tolerated: a browser that
   * cannot reach the server still shows backup history when that request succeeds.
   */
  const state = useAsync(async () => {
    const results = await Promise.allSettled([
      api.request<SyncStatusResponse>('/api/sync/status'),
      api.request<OfflineSummary>('/api/sync/summary'),
      api.request<Paginated<RecordSummary>>('/api/sync/records?pageSize=25'),
      api.request<BackupList>('/api/backups'),
      native ? listLocalOfflineRecords(runtime, 25) : Promise.resolve([]),
      native ? localOfflineSummary(runtime) : Promise.resolve(null),
    ]);
    return {
      status: results[0].status === 'fulfilled' ? results[0].value : null,
      summary: results[1].status === 'fulfilled' ? results[1].value : null,
      records: results[2].status === 'fulfilled' ? results[2].value.items : [],
      backups: results[3].status === 'fulfilled' ? results[3].value : null,
      local: results[4].status === 'fulfilled' ? results[4].value : [],
      localSummary: results[5].status === 'fulfilled' ? results[5].value : null,
      failure: results.find((result) => result.status === 'rejected') as
        PromiseRejectedResult | undefined,
    };
  }, [nonce, native, runtime, api]);
  const status = state.data?.status ?? null;
  const summary = state.data?.summary ?? null;
  const records = state.data?.records ?? [];
  const backups = state.data?.backups ?? null;
  const local = state.data?.local ?? [];
  const localSummary = state.data?.localSummary ?? null;
  const load = async () => reload();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PushOutcome | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [verifyResult, setVerifyResult] = useState<{
    fileName: string;
    ok: boolean;
    detail: string;
  } | null>(null);

  async function synchronize() {
    setBusy('sync');
    setOutcome(null);
    try {
      const result = await pushOfflineRecords(runtime, api);
      setOutcome(result);
      await load();
      notify(
        result.sent === 0
          ? 'Nothing is waiting to synchronize.'
          : `${result.applied + result.duplicates} record(s) confirmed by the shop computer.`,
        'success',
      );
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function createBackup() {
    setBusy('backup');
    try {
      const created = await api.request<BackupSummary>('/api/backups', 'POST', {});
      notify(
        created.verified
          ? `Backup ${created.fileName} written and verified.`
          : 'A backup was written but its verification reported a problem. Check the list.',
        created.verified ? 'success' : 'error',
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function verify(fileName: string) {
    setBusy(`verify-${fileName}`);
    try {
      const result = await api.request<{
        integrityOk: boolean;
        checksumOk: boolean;
        migrationVersion: number;
        tableCounts: Record<string, number>;
      }>(`/api/backups/${encodeURIComponent(fileName)}/verify`);
      const total = Object.values(result.tableCounts).reduce((sum, v) => sum + Math.max(0, v), 0);
      setVerifyResult({
        fileName,
        ok: result.integrityOk && result.checksumOk,
        detail: result.integrityOk
          ? `Integrity check passed · schema version ${result.migrationVersion} · ${total.toLocaleString()} records`
          : 'This file failed its integrity check. Do not use it to restore.',
      });
    } catch (caught) {
      setVerifyResult({ fileName, ok: false, detail: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    setBusy('restore');
    try {
      await api.request('/api/backups/restore', 'POST', { fileName: restoreTarget.fileName });
      notify(
        'Restore prepared. Close MediMart and start it again to complete the restore; a safety copy of the current database is kept.',
        'info',
      );
      setRestoreTarget(null);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const canManage = Boolean(user && user.permissions.includes('sync.manage'));

  const failureMessage = state.data?.failure ? errorMessage(state.data.failure.reason) : null;
  if (state.loading && !state.data)
    return <LoadingBlock label="Reading synchronization and backup status…" />;
  if (!state.data)
    return (
      <ErrorBlock message={state.error ?? 'MediMart could not read this page.'} onRetry={reload} />
    );

  return (
    <>
      <PageHeading
        eyebrow="Administration"
        title="Backup and Sync"
        description="Synchronize sales captured on phones, and keep verified copies of your business data."
        action={
          <Button variant="secondary" onClick={reload} disabled={busy !== null}>
            <RefreshCw size={15} /> Refresh
          </Button>
        }
      />
      <FormError message={error ?? failureMessage} />

      <div className="backup-sync-grid">
        <section className="card backup-sync-card">
          <header>
            <Smartphone size={20} />
            <div>
              <h2>Synchronization</h2>
              <p>Records kept on this device are checked by the shop computer before they count.</p>
            </div>
          </header>
          {!native && (
            <p className="small muted">
              Offline capture is available in the Android application. On this computer you can
              review and verify what the phones have sent.
            </p>
          )}
          <dl className="backup-stat-list">
            <div>
              <dt>Waiting on this device</dt>
              <dd>{(localSummary?.pending ?? status?.pending ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Needs attention</dt>
              <dd>{(localSummary?.rejected ?? status?.rejected ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Conflicts to review</dt>
              <dd>{(localSummary?.conflict ?? status?.conflict ?? 0).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Synchronized today</dt>
              <dd>{(summary?.syncedToday ?? 0).toLocaleString()}</dd>
            </div>
          </dl>
          {localSummary?.lastError && (
            <p className="small backup-warning">
              <AlertTriangle size={14} /> Latest problem: {localSummary.lastError}
            </p>
          )}
          {summary?.lastError && !localSummary?.lastError && (
            <p className="small backup-warning">
              <AlertTriangle size={14} /> Latest problem: {summary.lastError}
            </p>
          )}
          {native && (
            <div className="backup-actions">
              <Button
                onClick={() => void synchronize()}
                disabled={busy !== null || (localSummary?.pending ?? 0) === 0}
              >
                <UploadCloud size={15} /> Synchronize now
              </Button>
              <span className="small muted">
                Last successful synchronization:{' '}
                {summary?.lastSyncedAt ? formatDateTime(summary.lastSyncedAt) : 'not yet recorded'}
              </span>
            </div>
          )}
          {outcome && (
            <div className={outcome.offline ? 'backup-outcome warn' : 'backup-outcome'}>
              {outcome.offline ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <span>
                {outcome.offline
                  ? 'The shop computer is unreachable. Nothing was sent; records stay safely on this device.'
                  : `Sent ${outcome.sent}: ${outcome.applied} applied, ${outcome.duplicates} already known, ${outcome.rejected} rejected, ${outcome.conflicts} conflict(s).`}
              </span>
            </div>
          )}
        </section>

        <section className="card backup-sync-card">
          <header>
            <HardDriveDownload size={20} />
            <div>
              <h2>Backups</h2>
              <p>
                Each backup is a complete copy of your business database, verified after writing.
              </p>
            </div>
          </header>
          <dl className="backup-stat-list">
            <div>
              <dt>Backup folder</dt>
              <dd className="backup-path">
                {backups?.directory || backups?.defaultDirectory || '—'}
              </dd>
            </div>
            <div>
              <dt>Automatic backups</dt>
              <dd>
                {backups?.settings.automaticEnabled
                  ? `Every ${backups.settings.intervalHours} hours while MediMart is open`
                  : 'Off'}
              </dd>
            </div>
            <div>
              <dt>Copies kept</dt>
              <dd>{backups?.settings.retentionCount ?? 14}</dd>
            </div>
            <div>
              <dt>Last backup</dt>
              <dd>
                {backups?.settings.lastRunAt
                  ? formatDateTime(backups.settings.lastRunAt)
                  : 'No backup yet'}
              </dd>
            </div>
          </dl>
          {canManage && (
            <div className="backup-actions">
              <Button onClick={() => void createBackup()} disabled={busy !== null}>
                <Database size={15} /> Create backup now
              </Button>
              <span className="small muted">
                On the Windows application the folder defaults to your Documents.
              </span>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Backup history</h2>
            <p>Verify a copy before you rely on it. Restoring needs an explicit confirmation.</p>
          </div>
          <Badge tone="green">
            <ShieldCheck size={13} /> Verified on write
          </Badge>
        </div>
        {backups?.items.length ? (
          <div className="table-scroll">
            <table className="data-table backup-history">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Created</th>
                  <th scope="col">Size</th>
                  <th scope="col">Records</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.fileName}</code>
                      <div className="small muted">
                        {item.kind === 'manual' ? 'Manual' : 'Automatic'}
                      </div>
                    </td>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{bytes(item.sizeBytes)}</td>
                    <td>{item.countsTotal.toLocaleString()}</td>
                    <td>
                      {item.verified ? (
                        <StatusBadge tone="green">Verified</StatusBadge>
                      ) : (
                        <StatusBadge tone="amber">Check needed</StatusBadge>
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        <Button
                          variant="secondary"
                          onClick={() => void verify(item.fileName)}
                          disabled={busy !== null}
                        >
                          Verify
                        </Button>
                        {canManage && runtime.native === false && (
                          <Button
                            variant="secondary"
                            onClick={() => setRestoreTarget(item)}
                            disabled={busy !== null}
                          >
                            <RotateCcw size={14} /> Restore
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">
            No backup has been recorded yet. Create one before you start using MediMart for real
            business.
          </p>
        )}
        {verifyResult && (
          <div className={`backup-outcome ${verifyResult.ok ? '' : 'warn'}`}>
            {verifyResult.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>
              <strong>{verifyResult.fileName}</strong> — {verifyResult.detail}
            </span>
          </div>
        )}
      </section>

      <section className="card backup-records">
        <div className="card-heading">
          <div>
            <h2>Records from connected devices</h2>
            <p>
              Everything a phone captured is listed here, including anything it could not apply.
            </p>
          </div>
          <Badge>
            <DownloadCloud size={13} /> {records.length} shown
          </Badge>
        </div>
        {native && local.length > 0 && (
          <div className="table-scroll">
            <table className="data-table backup-history">
              <thead>
                <tr>
                  <th scope="col">On this device</th>
                  <th scope="col">Business date</th>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {local.map((item) => (
                  <tr key={item.operationId}>
                    <td>{offlineRecordTypeLabels[item.recordType]}</td>
                    <td>{item.clientDate}</td>
                    <td>
                      <code>{item.receiptNumber ?? item.reference ?? '—'}</code>
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          item.status === 'applied'
                            ? 'green'
                            : item.status === 'pending'
                              ? 'amber'
                              : 'red'
                        }
                      >
                        {recordStatusLabel(item.status)}
                      </StatusBadge>
                    </td>
                    <td className="small">{item.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {records.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table backup-history">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Business date</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Device</th>
                  <th scope="col">State</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {records.map((item) => (
                  <tr key={item.operationId}>
                    <td>{offlineRecordTypeLabels[item.recordType]}</td>
                    <td>{item.clientDate}</td>
                    <td>
                      <code>{item.receiptNumber ?? item.reference ?? '—'}</code>
                    </td>
                    <td>
                      <code className="small">{item.deviceId.slice(0, 8)}…</code>
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          item.status === 'applied'
                            ? 'green'
                            : item.status === 'pending'
                              ? 'amber'
                              : 'red'
                        }
                      >
                        {recordStatusLabel(item.status)}
                      </StatusBadge>
                    </td>
                    <td className="small">{item.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">
            No phone has synchronized any records yet. Pair a phone under Settings → Device pairing.
          </p>
        )}
      </section>

      <section className="card backup-help">
        <header>
          <FolderOpen size={20} />
          <div>
            <h2>What a backup contains</h2>
            <p>
              Products, stock movements, sales, customers, patient and prescription records,
              purchases, expenses, staff accounts and permission data are all in the same database
              file. Password hashes travel with it, so keep the folder private; patient information
              is only as protected as the folder you choose.
            </p>
          </div>
        </header>
        <p className="small muted">
          Recommended routine: keep automatic daily backups on, copy the backup folder to a USB
          drive at closing each week, and verify one backup each month. Never delete the folder
          while MediMart is open.
        </p>
      </section>

      <Modal
        open={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        title="Restore this backup?"
      >
        <div className="modal-form">
          <p>
            Restoring replaces all current business data with the contents of{' '}
            <strong>{restoreTarget?.fileName}</strong>, created{' '}
            {restoreTarget ? formatDateTime(restoreTarget.createdAt) : ''}.
          </p>
          <p className="small muted">
            Anything recorded after that backup will no longer be in MediMart. A safety copy of the
            current database is kept next to it, and the restore finishes only after MediMart is
            closed and started again.
          </p>
          <Field label="Type RESTORE to confirm">
            <RestoreConfirm
              disabled={busy !== null}
              onConfirm={() => void confirmRestore()}
              onCancel={() => setRestoreTarget(null)}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function RestoreConfirm({
  onConfirm,
  onCancel,
  disabled,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <>
      <input
        aria-label="Type RESTORE to confirm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
      />
      <div className="modal-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onConfirm} disabled={disabled || value !== 'RESTORE'}>
          Restore backup
        </Button>
      </div>
    </>
  );
}
