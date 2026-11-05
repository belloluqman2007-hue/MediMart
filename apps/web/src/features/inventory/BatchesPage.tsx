import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, Layers3, Save } from 'lucide-react';
import {
  hasPermission,
  type BatchSummary,
  type Paginated,
  type ProductSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, PageHeading } from '../../components/ui';
import { buildQuery, formatDate, formatMoney, useAsync } from './lib';
import {
  BatchStatus,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Pagination,
  SearchField,
} from './shared';

const filters = [
  { id: 'all', label: 'All batches' },
  { id: 'expiring', label: 'Near expiry' },
  { id: 'expired', label: 'Expired' },
  { id: 'depleted', label: 'Depleted' },
] as const;

export function BatchesPage() {
  const { api, user, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<(typeof filters)[number]['id']>(
    (params.get('filter') as 'all' | 'expiring' | 'expired' | 'depleted') || 'all',
  );
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [productId, setProductId] = useState(params.get('productId') ?? '');
  const [page, setPage] = useState(1);
  const [days, setDays] = useState('');
  const [saving, setSaving] = useState(false);
  const canConfigure = Boolean(
    user && hasPermission(user.permissions, 'inventory.settings.manage'),
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (productId) next.set('productId', productId);
        else next.delete('productId');
        if (filter !== 'all') next.set('filter', filter);
        else next.delete('filter');
        return next;
      },
      { replace: true },
    );
  }, [filter, productId, setParams]);

  const settings = useAsync(
    () => api.request<{ expiryAlertDays: number }>('/api/inventory/settings'),
    [],
  );
  const products = useAsync(
    () => api.request<Paginated<ProductSummary>>('/api/products?pageSize=100'),
    [],
  );
  const batches = useAsync(
    () =>
      api.request<Paginated<BatchSummary>>(
        `/api/batches${buildQuery({ filter, search: debounced, productId, page, pageSize: 25 })}`,
      ),
    [filter, debounced, productId, page],
  );
  const alertDays = settings.data?.expiryAlertDays ?? 90;

  async function saveDays(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 365) {
      notify('Enter a whole number of days between 1 and 365.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.request('/api/inventory/settings', 'PUT', { expiryAlertDays: value });
      notify('Expiry alert window saved.', 'success');
      setDays('');
      settings.reload();
      batches.reload();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Batches and expiry"
        description={`Each batch keeps its own quantity and expiry. Alerts start ${alertDays} days before expiry.`}
        action={
          <Link to="/inventory/receive" className="button button-primary">
            Receive a batch
          </Link>
        }
      />
      <section className="card inventory-card">
        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search batch number or product…"
            label="Search batches"
          />
          <select
            aria-label="Filter by product"
            value={productId}
            onChange={(event) => {
              setProductId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All products</option>
            {(products.data?.items ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
          <div className="filter-chips" role="group" aria-label="Batch status filter">
            {filters.map((option) => (
              <button
                key={option.id}
                className={`filter-chip ${filter === option.id ? 'active' : ''}`}
                onClick={() => {
                  setFilter(option.id);
                  setPage(1);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {batches.loading && !batches.data ? (
          <LoadingBlock label="Loading batches…" />
        ) : batches.error ? (
          <ErrorBlock message={batches.error} onRetry={batches.reload} />
        ) : batches.data && batches.data.items.length === 0 ? (
          <EmptyState
            icon={<Layers3 size={27} />}
            title={filter === 'all' ? 'No batches yet' : 'Nothing in this view'}
            message={
              filter === 'expired'
                ? 'No expired stock is on hand. Good news for your shelves.'
                : 'Receiving stock creates batches with their own quantities and expiry dates.'
            }
          />
        ) : batches.data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Product</th>
                    <th>Manufactured</th>
                    <th>Expiry</th>
                    <th className="numeric">Received</th>
                    <th className="numeric">Remaining</th>
                    <th>Cost</th>
                    <th>Supplier</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.data.items.map((batch) => (
                    <tr key={batch.id}>
                      <td>{batch.batchNumber}</td>
                      <td>
                        <Link to={`/inventory/products/${batch.productId}`}>
                          {batch.productName}
                        </Link>
                      </td>
                      <td>{formatDate(batch.manufacturingDate)}</td>
                      <td>{formatDate(batch.expiryDate)}</td>
                      <td className="numeric">{batch.quantityReceived}</td>
                      <td className="numeric">{batch.quantityRemaining}</td>
                      <td>{formatMoney(batch.purchaseCostKobo)}</td>
                      <td className="muted">{batch.supplierName || '—'}</td>
                      <td>
                        <BatchStatus status={batch.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={batches.data.page}
              totalPages={batches.data.totalPages}
              total={batches.data.total}
              onChange={setPage}
            />
          </>
        ) : null}
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Expiry alert window</h2>
            <p>Near-expiry batches are flagged in the dashboard and alerts.</p>
          </div>
          <span className="badge badge-amber">
            <CalendarClock size={12} /> {alertDays} days
          </span>
        </div>
        {canConfigure ? (
          <form className="inventory-inline-form" onSubmit={(event) => void saveDays(event)}>
            <Field label="Days before expiry">
              <input
                type="number"
                min={1}
                max={365}
                placeholder={String(alertDays)}
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </Field>
            <Button type="submit" busy={saving}>
              <Save size={15} /> Save
            </Button>
          </form>
        ) : (
          <p className="empty-small">
            Only owners, administrators, and managers can change the expiry alert window.
          </p>
        )}
      </section>
    </>
  );
}
