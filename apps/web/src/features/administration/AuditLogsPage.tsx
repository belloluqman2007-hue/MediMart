import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ScrollText, ShieldAlert } from 'lucide-react';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, SearchField } from '../inventory/shared';
import { formatDateTime, useAsync } from '../inventory/lib';
import { useDebounced } from './useDebounced';

type AuditEntry = {
  id: string;
  actor_user_id: string | null;
  device_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  request_id: string;
  metadata_json: string | null;
  created_at: string;
};

type StaffRow = { id: string; fullName: string };

const PAGE_SIZE = 100;

/**
 * Audit entries are grouped by their action family so a long ledger can be scanned by area:
 * a pharmacist reviewing clinical corrections looks under `prescription.*`, an owner reviewing
 * security looks under `staff.*` and `permission.*`.
 */
const families = [
  { key: 'all', label: 'All activity' },
  { key: 'sales', label: 'Sales' },
  { key: 'inventory', label: 'Stock' },
  { key: 'clinical', label: 'Clinical' },
  { key: 'staff', label: 'Staff & access' },
  { key: 'money', label: 'Money' },
];

function familyOf(action: string) {
  if (/^(sale|pos|payment|debt|receipt)/.test(action)) return 'sales';
  if (/^(product|batch|stock|purchase|goods|supplier|inventory)/.test(action)) return 'inventory';
  if (/^(patient|consultation|prescription|dispens|addendum|clinical)/.test(action))
    return 'clinical';
  if (/^(staff|permission|role|user|auth|session|device)/.test(action)) return 'staff';
  if (/^(expense|finance|report)/.test(action)) return 'money';
  return 'other';
}

export function AuditLogsPage() {
  const { api } = useApp();
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const debounced = useDebounced(search, 200);

  const ledger = useAsync(
    () => api.request<{ entries: AuditEntry[] }>(`/api/audit-logs?limit=${PAGE_SIZE}`),
    [],
  );
  const entries = ledger.data?.entries ?? null;
  /**
   * Names are resolved once so the ledger reads "Amina Sule" rather than a UUID. A user without
   * `staff.view` simply sees "System account"; the ledger is still readable.
   */
  const staff = useAsync(() => api.request<{ users: StaffRow[] }>('/api/staff'), []);
  const people = useMemo(
    () => new Map((staff.data?.users ?? []).map((row) => [row.id, row.fullName])),
    [staff.data],
  );

  const filtered = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    return (entries ?? []).filter((entry) => {
      if (family !== 'all' && familyOf(entry.action) !== family) return false;
      if (!needle) return true;
      const actor = entry.actor_user_id ? (people.get(entry.actor_user_id) ?? '') : '';
      return (
        entry.action.toLowerCase().includes(needle) ||
        (entry.entity_type ?? '').toLowerCase().includes(needle) ||
        actor.toLowerCase().includes(needle)
      );
    });
  }, [entries, debounced, family, people]);

  return (
    <>
      <PageHeading
        title="Audit logs"
        description="An append-only record of every consequential action: who did it, when, from which device, and what changed."
        action={<span className="muted small">Showing the {PAGE_SIZE} most recent entries</span>}
      />
      <div className="audit-toolbar">
        <div className="chip-row" role="tablist" aria-label="Filter by area">
          {families.map((item) => (
            <button
              key={item.key}
              role="tab"
              aria-selected={family === item.key}
              className={`chip ${family === item.key ? 'is-active' : ''}`}
              onClick={() => setFamily(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search action, person or record…"
          label="Search audit logs"
        />
      </div>
      <section className="card">
        {ledger.error ? (
          <ErrorBlock message={ledger.error} onRetry={ledger.reload} />
        ) : !entries ? (
          <LoadingBlock label="Reading the ledger…" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={22} />}
            title={
              entries.length === 0 ? 'No activity recorded yet' : 'Nothing matches this filter'
            }
            message={
              entries.length === 0
                ? 'As soon as your team sells, dispenses or changes stock, the action will appear here.'
                : 'Try another area, or clear the search box.'
            }
          />
        ) : (
          <ul className="audit-list">
            {filtered.map((entry) => {
              const isOpen = expanded === entry.id;
              const actor = entry.actor_user_id
                ? (people.get(entry.actor_user_id) ?? 'System account')
                : 'System';
              const metadata = safeJson(entry.metadata_json);
              return (
                <li key={entry.id} className={isOpen ? 'is-open' : ''}>
                  <button
                    className="audit-row"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                  >
                    <span
                      className={`audit-badge family-${familyOf(entry.action)}`}
                      aria-hidden="true"
                    >
                      <ShieldAlert size={14} />
                    </span>
                    <span className="audit-main">
                      <span className="audit-action">{humaniseAction(entry.action)}</span>
                      <span className="audit-meta">
                        {actor}
                        {entry.entity_type && <> · {humaniseAction(entry.entity_type)}</>} ·{' '}
                        {formatDateTime(entry.created_at)}
                      </span>
                    </span>
                    <code className="audit-code">{entry.action}</code>
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  {isOpen && (
                    <div className="audit-detail">
                      <dl>
                        <div>
                          <dt>Record</dt>
                          <dd>{entry.entity_type ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>Record ID</dt>
                          <dd>
                            <code>{entry.entity_id ?? '—'}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Device</dt>
                          <dd>
                            <code>{entry.device_id ?? 'central server'}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Request</dt>
                          <dd>
                            <code>{entry.request_id}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Exact time</dt>
                          <dd>{formatDateTime(entry.created_at)}</dd>
                        </div>
                      </dl>
                      {metadata && (
                        <pre className="audit-metadata">{JSON.stringify(metadata, null, 2)}</pre>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function safeJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `stock.received` → "Stock received"; `prescription.dispensed` → "Prescription dispensed". */
function humaniseAction(action: string) {
  const words = action.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
