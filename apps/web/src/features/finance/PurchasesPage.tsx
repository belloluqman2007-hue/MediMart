import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Eye, Plus, RefreshCw, ShoppingCart } from 'lucide-react';
import {
  hasPermission,
  purchaseStatusLabels,
  purchaseStatuses,
  type Paginated,
  type PurchaseOrderSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, Pagination, SearchField } from '../inventory/shared';
import { PurchaseStatusBadge } from './components';
import { buildQuery, formatDate, formatMoney, useAsync } from './lib';

export function PurchasesPage() {
  const { api, user } = useApp();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const canCreate = Boolean(user && hasPermission(user.permissions, 'purchases.create'));

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const purchases = useAsync(
    () =>
      api.request<Paginated<PurchaseOrderSummary>>(
        `/api/purchases${buildQuery({
          search: debounced,
          status,
          from,
          to,
          page,
          pageSize: 20,
        })}`,
      ),
    [debounced, status, from, to, page],
  );

  const data = purchases.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Purchasing"
        title="Purchase orders"
        description="Order stock from your existing suppliers. An order is not a delivery: stock and payables only move when goods are received."
        action={
          canCreate ? (
            <Link to="/purchases/new" className="button button-primary">
              <Plus size={16} /> New purchase
            </Link>
          ) : undefined
        }
      />
      <div className="inventory-tabs">
        <Link className="inventory-tab active" to="/purchases">
          <ShoppingCart size={15} /> Purchase orders
        </Link>
        <Link className="inventory-tab" to="/purchases/receipts">
          <ClipboardList size={15} /> Goods received
        </Link>
        <Link className="inventory-tab" to="/supplier-payments">
          <span aria-hidden>₦</span> Supplier payments
        </Link>
        <Link className="inventory-tab" to="/supplier-balances">
          <span aria-hidden>Σ</span> Supplier balances
        </Link>
      </div>
      <section className="card inventory-card">
        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search reference, supplier or notes…"
            label="Search purchase orders"
          />
          <select
            aria-label="Filter by purchase status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {purchaseStatuses.map((value) => (
              <option key={value} value={value}>
                {purchaseStatusLabels[value]}
              </option>
            ))}
          </select>
          <label className="inline-date">
            <span className="small muted">From</span>
            <input
              aria-label="Purchases from date"
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-date">
            <span className="small muted">To</span>
            <input
              aria-label="Purchases to date"
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <Button variant="secondary" onClick={purchases.reload} busy={purchases.loading}>
            <RefreshCw size={15} /> Refresh
          </Button>
        </div>
        {purchases.loading && !data ? (
          <LoadingBlock label="Loading purchase orders…" />
        ) : purchases.error ? (
          <ErrorBlock message={purchases.error} onRetry={purchases.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart size={27} />}
            title={debounced || status || from || to ? 'No orders match' : 'No purchases yet'}
            message={
              debounced || status || from || to
                ? 'Try a different search, status or date range.'
                : 'Create your first purchase order to begin restocking.'
            }
            action={
              canCreate ? (
                <Link className="button button-primary" to="/purchases/new">
                  <Plus size={16} /> New purchase
                </Link>
              ) : undefined
            }
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Order date</th>
                    <th>Supplier</th>
                    <th>Status</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th>Received</th>
                    <th>Outstanding</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((purchase) => (
                    <tr key={purchase.id}>
                      <td>
                        <Link className="table-primary" to={`/purchases/${purchase.id}`}>
                          {purchase.referenceNumber}
                        </Link>
                        {purchase.expectedDeliveryDate && (
                          <small className="muted">
                            Expected {formatDate(purchase.expectedDeliveryDate)}
                          </small>
                        )}
                      </td>
                      <td>{formatDate(purchase.createdAt)}</td>
                      <td>{purchase.supplierName}</td>
                      <td>
                        <PurchaseStatusBadge status={purchase.status} />
                      </td>
                      <td>{purchase.itemCount}</td>
                      <td>{formatMoney(purchase.totalKobo)}</td>
                      <td>{formatMoney(purchase.receivedValueKobo)}</td>
                      <td className={purchase.outstandingKobo > 0 ? 'text-amber' : ''}>
                        {formatMoney(purchase.outstandingKobo)}
                      </td>
                      <td className="row-actions">
                        <Link
                          className="icon-button"
                          to={`/purchases/${purchase.id}`}
                          aria-label={`View ${purchase.referenceNumber}`}
                          title={`View ${purchase.referenceNumber}`}
                        >
                          <Eye size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              onChange={setPage}
            />
            <p className="inventory-note small">
              Ordered value is not money paid. Payables only arise from goods actually received, and
              only recorded supplier payments count as cash out.
            </p>
          </>
        ) : null}
      </section>
      <div className="button-row">
        <Link className="button button-secondary" to="/suppliers">
          Supplier accounts
        </Link>
      </div>
    </div>
  );
}
