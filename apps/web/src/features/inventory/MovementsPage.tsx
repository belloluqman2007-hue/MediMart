import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import {
  stockMovementLabels,
  stockMovementTypes,
  type MovementSummary,
  type Paginated,
  type ProductSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { buildQuery, formatDateTime, useAsync } from './lib';
import { EmptyState, ErrorBlock, LoadingBlock, Pagination } from './shared';

export function MovementsPage() {
  const { api } = useApp();
  const [params, setParams] = useSearchParams();
  const [productId, setProductId] = useState(params.get('productId') ?? '');
  const [type, setType] = useState(params.get('type') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [page, setPage] = useState(Number(params.get('page') ?? 1));
  const products = useAsync(
    () => api.request<Paginated<ProductSummary>>('/api/products?pageSize=100'),
    [],
  );
  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        const values: Record<string, string> = { productId, type, from, to };
        for (const [key, value] of Object.entries(values)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (page > 1) next.set('page', String(page));
        else next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [productId, type, from, to, page, setParams]);
  const movements = useAsync(
    () =>
      api.request<Paginated<MovementSummary>>(
        `/api/stock/movements${buildQuery({ productId, type, from, to, page, pageSize: 25 })}`,
      ),
    [productId, type, from, to, page],
  );
  const data = movements.data;
  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Stock movement history"
        description="An append-only ledger: every receipt, adjustment, write-off, and correction."
        action={
          <Link to="/inventory/products" className="button button-secondary">
            Products
          </Link>
        }
      />
      <section className="card inventory-card">
        <div className="inventory-filters">
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
          <select
            aria-label="Filter by movement type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All movement types</option>
            {stockMovementTypes.map((value) => (
              <option key={value} value={value}>
                {stockMovementLabels[value]}
              </option>
            ))}
          </select>
          <label className="inline-date">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-date">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        {movements.loading && !data ? (
          <LoadingBlock label="Loading movement history…" />
        ) : movements.error ? (
          <ErrorBlock message={movements.error} onRetry={movements.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={27} />}
            title="No movements match"
            message="Stock receipts and adjustments will appear here as they happen."
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Product</th>
                    <th>Batch</th>
                    <th>Movement</th>
                    <th className="numeric">Change</th>
                    <th className="numeric">Before</th>
                    <th className="numeric">After</th>
                    <th>Reason</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((movement) => (
                    <tr key={movement.id}>
                      <td className="muted">{formatDateTime(movement.createdAt)}</td>
                      <td>
                        <Link to={`/inventory/products/${movement.productId}`}>
                          {movement.productName}
                        </Link>
                      </td>
                      <td>{movement.batchNumber || '—'}</td>
                      <td>{stockMovementLabels[movement.movementType]}</td>
                      <td
                        className={`numeric ${movement.quantity > 0 ? 'text-green' : 'text-red'}`}
                      >
                        {movement.quantity > 0 ? '+' : ''}
                        {movement.quantity}
                      </td>
                      <td className="numeric">{movement.previousBalance}</td>
                      <td className="numeric">{movement.newBalance}</td>
                      <td className="muted">
                        {movement.reason}
                        {movement.referenceId && (
                          <small className="block muted">Ref {movement.referenceId}</small>
                        )}
                      </td>
                      <td className="muted">
                        {movement.userName || 'System'}
                        {movement.deviceId && <small className="block muted">Paired device</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span className="muted small">
                Ledger entries are append-only: balances are reconciled against them, never
                overwritten.
              </span>
            </div>
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              onChange={setPage}
            />
          </>
        ) : null}
      </section>
    </>
  );
}
