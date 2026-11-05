import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LockKeyhole } from 'lucide-react';
import {
  AlarmClock,
  ArrowRight,
  Boxes,
  CalendarClock,
  Coins,
  Layers3,
  PackagePlus,
  PackageX,
  RefreshCw,
  Save,
  TriangleAlert,
} from 'lucide-react';
import {
  hasPermission,
  stockMovementLabels,
  type InventoryDashboard as DashboardData,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Badge, Button, PageHeading } from '../../components/ui';
import { formatDateTime, formatMoney, useAsync } from './lib';
import { EmptyState, ErrorBlock, Field, LoadingBlock } from './shared';

export function InventoryDashboard() {
  const { api, user, notify } = useApp();
  const [savingDays, setSavingDays] = useState(false);
  const [days, setDays] = useState('');
  const allowed = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const dashboard = useAsync(
    () =>
      allowed ? api.request<DashboardData>('/api/inventory/dashboard') : Promise.resolve(null),
    [allowed],
  );
  const data = dashboard.data;
  const canConfigure = Boolean(
    user && hasPermission(user.permissions, 'inventory.settings.manage'),
  );
  const canReceive = Boolean(user && hasPermission(user.permissions, 'stock.receive'));
  const canSeeReports = Boolean(user && hasPermission(user.permissions, 'inventory.reports.view'));

  async function saveAlertDays() {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 365) {
      notify('Enter a whole number of days between 1 and 365.', 'error');
      return;
    }
    setSavingDays(true);
    try {
      await api.request('/api/inventory/settings', 'PUT', { expiryAlertDays: value });
      notify('Expiry alert window saved.', 'success');
      setDays('');
      dashboard.reload();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setSavingDays(false);
    }
  }

  if (!allowed)
    return (
      <>
        <PageHeading
          eyebrow="Inventory"
          title="Inventory"
          description="Stock, batches, and expiry across your business."
        />
        <section className="card inventory-card">
          <div className="inventory-empty">
            <span className="empty-icon">
              <LockKeyhole size={26} />
            </span>
            <h3>{user ? 'This space needs a different permission' : 'Sign in to manage stock'}</h3>
            <p>
              {user
                ? 'Your account needs inventory.view. Ask your owner or administrator about access — the API enforces this independently of this screen.'
                : 'Inventory records belong to your business. Sign in with your own account to continue.'}
            </p>
            <Link className="button button-secondary" to={user ? '/' : '/login'}>
              {user ? 'Back to dashboard' : 'Sign in'}
            </Link>
          </div>
        </section>
      </>
    );

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Stock at a glance"
        description="Products, batches, and stock value across your pharmacy and mini-mart."
        action={
          <>
            <Button variant="secondary" onClick={dashboard.reload} busy={dashboard.loading}>
              <RefreshCw size={15} /> Refresh
            </Button>
            {canReceive && (
              <Link to="/inventory/receive" className="button button-primary">
                <PackagePlus size={16} /> Receive stock
              </Link>
            )}
          </>
        }
      />
      {dashboard.loading && !data ? (
        <LoadingBlock label="Loading your inventory overview…" />
      ) : dashboard.error ? (
        <ErrorBlock message={dashboard.error} onRetry={dashboard.reload} />
      ) : data ? (
        <>
          <section className="inventory-metrics" aria-label="Inventory metrics">
            <MetricCard
              icon={<Boxes size={19} />}
              tone="green"
              label="Active products"
              value={String(data.totalActiveProducts)}
              caption={`${data.totalInactiveProducts} inactive`}
              to="/inventory/products"
            />
            <MetricCard
              icon={<Coins size={19} />}
              tone="blue"
              label="Stock value at cost"
              value={formatMoney(data.stockValueCostKobo)}
              caption={`${data.totalStockQuantity.toLocaleString()} base units on hand`}
              to="/inventory/products"
            />
            <MetricCard
              icon={<Layers3 size={19} />}
              tone="amber"
              label="Below reorder level"
              value={String(data.lowStockCount)}
              caption="Restock soon"
              to="/inventory/products?stock=low"
            />
            <MetricCard
              icon={<PackageX size={19} />}
              tone="red"
              label="Out of stock"
              value={String(data.outOfStockCount)}
              caption="No units available"
              to="/inventory/products?stock=out"
            />
            <MetricCard
              icon={<TriangleAlert size={19} />}
              tone="red"
              label="Expired batches"
              value={String(data.expiredBatchCount)}
              caption={`${data.expiredUnits.toLocaleString()} units blocked from sale`}
              to="/inventory/batches?filter=expired"
            />
            <MetricCard
              icon={<CalendarClock size={19} />}
              tone="amber"
              label={`Expiring in ${data.expiryAlertDays} days`}
              value={String(data.nearExpiryBatchCount)}
              caption={`${data.nearExpiryUnits.toLocaleString()} units to review`}
              to="/inventory/batches?filter=expiring"
            />
          </section>

          <p className="inventory-note">
            Stock value is calculated at recorded purchase cost, not retail selling price. The
            retail value of the same stock would be {formatMoney(data.retailValueKobo)}.
          </p>

          <div className="dashboard-middle">
            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Low stock watchlist</h2>
                  <p>Active products at or below their reorder level.</p>
                </div>
                <Badge tone={data.lowStockProducts.length ? 'amber' : 'green'}>
                  {data.lowStockProducts.length} to review
                </Badge>
              </div>
              {data.lowStockProducts.length ? (
                <ul className="inventory-list">
                  {data.lowStockProducts.map((product) => (
                    <li key={product.id}>
                      <Link to={`/inventory/products/${product.id}`}>
                        <span>
                          <strong>{product.name}</strong>
                          <small>
                            Reorder at {product.reorderLevel} {product.baseUnitSymbol}
                          </small>
                        </span>
                        <span
                          className={`status-pill ${
                            product.stockQuantity === 0 ? 'status-red' : 'status-amber'
                          }`}
                        >
                          {product.stockQuantity} {product.baseUnitSymbol}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-small">Nothing is below its reorder level right now.</div>
              )}
            </section>

            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Recently added products</h2>
                  <p>The newest items in your catalogue.</p>
                </div>
                <Link className="text-link" to="/inventory/products">
                  All products <ArrowRight size={14} />
                </Link>
              </div>
              {data.recentlyAddedProducts.length ? (
                <ul className="inventory-list">
                  {data.recentlyAddedProducts.map((product) => (
                    <li key={product.id}>
                      <Link to={`/inventory/products/${product.id}`}>
                        <span>
                          <strong>{product.name}</strong>
                          <small>
                            {product.categoryName || 'Uncategorised'} ·{' '}
                            {formatMoney(product.sellingPriceKobo)}
                          </small>
                        </span>
                        <span className="muted small">{product.stockQuantity} on hand</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={<Boxes size={26} />}
                  title="No products yet"
                  message="Add your first product to start tracking stock and expiry."
                  action={
                    <Link className="button button-primary" to="/inventory/products/new">
                      Add a product
                    </Link>
                  }
                />
              )}
            </section>
          </div>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Recent stock movements</h2>
                <p>Every change is recorded in the stock ledger.</p>
              </div>
              <Link className="text-link" to="/inventory/movements">
                Full history <ArrowRight size={14} />
              </Link>
            </div>
            {data.recentMovements.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Product</th>
                      <th>Movement</th>
                      <th className="numeric">Change</th>
                      <th className="numeric">Balance</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentMovements.map((movement) => (
                      <tr key={movement.id}>
                        <td className="muted">{formatDateTime(movement.createdAt)}</td>
                        <td>
                          <Link to={`/inventory/products/${movement.productId}`}>
                            {movement.productName}
                          </Link>
                          {movement.batchNumber && (
                            <small className="block muted">Batch {movement.batchNumber}</small>
                          )}
                        </td>
                        <td>{stockMovementLabels[movement.movementType]}</td>
                        <td
                          className={`numeric ${movement.quantity > 0 ? 'text-green' : 'text-red'}`}
                        >
                          {movement.quantity > 0 ? '+' : ''}
                          {movement.quantity}
                        </td>
                        <td className="numeric">{movement.newBalance}</td>
                        <td className="muted">{movement.userName || 'System'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-small">No stock movements recorded yet.</div>
            )}
          </section>

          <div className="dashboard-middle">
            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Expiry alerts</h2>
                  <p>Near-expiry and expired batches are flagged automatically.</p>
                </div>
                <Badge tone="amber">
                  <AlarmClock size={12} /> {data.expiryAlertDays} days
                </Badge>
              </div>
              {canConfigure ? (
                <div className="inventory-inline-form">
                  <Field label="Warn me this many days before expiry">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      placeholder={String(data.expiryAlertDays)}
                      value={days}
                      onChange={(event) => setDays(event.target.value)}
                    />
                  </Field>
                  <Button onClick={() => void saveAlertDays()} busy={savingDays}>
                    <Save size={15} /> Save
                  </Button>
                </div>
              ) : (
                <p className="empty-small">
                  Expiring products are highlighted {data.expiryAlertDays} days before their expiry
                  date. Ask an owner or manager to change this window.
                </p>
              )}
            </section>
            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Record health</h2>
                  <p>Cached balances are reconciled against the movement ledger.</p>
                </div>
              </div>
              <p className="empty-small">
                {data.totalCategories} categories · {data.totalSuppliers} active suppliers
              </p>
              {canSeeReports ? (
                <Link className="text-link" to="/inventory/reconciliation">
                  Open reconciliation report <ArrowRight size={14} />
                </Link>
              ) : (
                <p className="muted small">
                  Reconciliation reports require the inventory reports permission.
                </p>
              )}
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}

function MetricCard({
  icon,
  label,
  value,
  caption,
  to,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  caption: string;
  to: string;
  tone: 'green' | 'blue' | 'amber' | 'red';
}) {
  return (
    <Link to={to} className="metric-card inventory-metric">
      <div className="metric-top">
        <span className={`icon-tile ${tone}`}>{icon}</span>
      </div>
      <h3>{label}</h3>
      <div className="metric-value">{value}</div>
      <div className="metric-caption">{caption}</div>
    </Link>
  );
}
