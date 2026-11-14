import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  Layers3,
  Package,
  Pill,
  Plus,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import {
  hasPermission,
  type FinancialDashboardSummary,
  type InventoryDashboard,
  type SalesDashboardSummary,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { PageHeading } from '../components/ui';
import { formatMoney, formatDateTime } from './inventory/lib';

type Loaded<T> = { userId: string; data: T | null } | null;

export function Dashboard() {
  const { user, api } = useApp();
  const userId = user?.id;
  const canSeeInventory = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const canSeeSales = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const canSeeFinance = Boolean(user && hasPermission(user.permissions, 'reports.view'));

  const [inventory, setInventory] = useState<Loaded<InventoryDashboard>>(null);
  const [sales, setSales] = useState<Loaded<SalesDashboardSummary>>(null);
  const [finance, setFinance] = useState<Loaded<FinancialDashboardSummary>>(null);

  // Only the signed-in user may see the figures they fetched; a previous user's data is discarded.
  const inventoryData =
    canSeeInventory && inventory && inventory.userId === userId ? inventory.data : null;
  const salesData = canSeeSales && sales && sales.userId === userId ? sales.data : null;
  const financeData = canSeeFinance && finance && finance.userId === userId ? finance.data : null;

  useEffect(() => {
    if (!canSeeInventory || !userId) return;
    let active = true;
    void api
      .request<InventoryDashboard>('/api/inventory/dashboard')
      .then((data) => active && setInventory({ userId, data }))
      .catch(() => active && setInventory({ userId, data: null }));
    return () => {
      active = false;
    };
  }, [api, canSeeInventory, userId]);

  useEffect(() => {
    if (!canSeeSales || !userId) return;
    let active = true;
    void api
      .request<SalesDashboardSummary>('/api/sales/summary')
      .then((data) => active && setSales({ userId, data }))
      .catch(() => active && setSales({ userId, data: null }));
    return () => {
      active = false;
    };
  }, [api, canSeeSales, userId]);

  useEffect(() => {
    if (!canSeeFinance || !userId) return;
    let active = true;
    const now = new Date();
    const from = `${now.toISOString().slice(0, 7)}-01`;
    const to = now.toISOString().slice(0, 10);
    void api
      .request<FinancialDashboardSummary>(`/api/finance/dashboard?from=${from}&to=${to}`)
      .then((data) => active && setFinance({ userId, data }))
      .catch(() => active && setFinance({ userId, data: null }));
    return () => {
      active = false;
    };
  }, [api, canSeeFinance, userId]);

  const today = salesData?.todayFinancials;
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const alerts = useMemo(() => {
    const list: { tone: 'warn' | 'danger' | 'info'; title: string; detail: string; to: string }[] =
      [];
    if (inventoryData) {
      if (inventoryData.expiredBatchCount > 0)
        list.push({
          tone: 'danger',
          title: `${inventoryData.expiredBatchCount} expired batch${inventoryData.expiredBatchCount === 1 ? '' : 'es'}`,
          detail: `${inventoryData.expiredUnits} units cannot be sold. Quarantine and write them off.`,
          to: '/inventory/batches?status=expired',
        });
      if (inventoryData.nearExpiryBatchCount > 0)
        list.push({
          tone: 'warn',
          title: `${inventoryData.nearExpiryBatchCount} batch${inventoryData.nearExpiryBatchCount === 1 ? '' : 'es'} expiring within ${inventoryData.expiryAlertDays} days`,
          detail: `${inventoryData.nearExpiryUnits} units to prioritise or return to the supplier.`,
          to: '/inventory/batches?status=expiring',
        });
      if (inventoryData.lowStockCount > 0)
        list.push({
          tone: 'warn',
          title: `${inventoryData.lowStockCount} product${inventoryData.lowStockCount === 1 ? '' : 's'} below reorder level`,
          detail: 'Reorder before the shelf runs out.',
          to: '/inventory/products?stock=low',
        });
      if (inventoryData.outOfStockCount > 0)
        list.push({
          tone: 'info',
          title: `${inventoryData.outOfStockCount} product${inventoryData.outOfStockCount === 1 ? '' : 's'} out of stock`,
          detail: 'No sellable units available today.',
          to: '/inventory/products?stock=out',
        });
    }
    if (salesData && salesData.openDebtCount > 0)
      list.push({
        tone: 'info',
        title: `${salesData.openDebtCount} open customer debt${salesData.openDebtCount === 1 ? '' : 's'}`,
        detail: `${formatMoney(salesData.todayFinancials.outstandingCreditKobo)} owed by ${salesData.customersWithDebtCount} customer${salesData.customersWithDebtCount === 1 ? '' : 's'}.`,
        to: '/debts',
      });
    return list;
  }, [inventoryData, salesData]);

  const trend = salesData?.trends ?? [];
  const trendMax = Math.max(1, ...trend.map((point) => point.netSalesRevenueKobo));

  return (
    <>
      <PageHeading
        title={`${greeting}${user ? `, ${user.fullName.split(' ')[0]}` : ''}`}
        description={`${date} · Everything below is read live from your own records.`}
        action={
          <div className="heading-buttons">
            {user && hasPermission(user.permissions, 'pos.access') && (
              <Link className="button button-primary" to="/pos">
                <ShoppingBag size={16} /> Open POS
              </Link>
            )}
            {user && hasPermission(user.permissions, 'products.create') && (
              <Link className="button button-secondary" to="/inventory/products/new">
                <Plus size={16} /> Add product
              </Link>
            )}
          </div>
        }
      />

      {!salesData && !inventoryData && (
        <div className="dashboard-skeleton" aria-live="polite">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skeleton-card" />
          ))}
        </div>
      )}

      {/* Headline numbers, each traceable to a report. */}
      <section className="stat-grid" aria-label="Today at a glance">
        <StatCard
          icon={<ShoppingBag size={18} />}
          tone="green"
          label="Sales today"
          value={today ? formatMoney(today.salesRevenueKobo) : '—'}
          caption={
            salesData
              ? `${salesData.todayTransactionsCount} transaction${salesData.todayTransactionsCount === 1 ? '' : 's'}${salesData.todayVoidedCount ? ` · ${salesData.todayVoidedCount} voided` : ''}`
              : 'Needs sales access'
          }
          to="/pos/sales"
          visible={canSeeSales}
        />
        <StatCard
          icon={<Wallet size={18} />}
          tone="teal"
          label="Money collected today"
          value={today ? formatMoney(today.cashActuallyReceivedKobo) : '—'}
          caption={
            today
              ? `Cash ${formatMoney(today.cashMethodReceivedKobo)} · Transfer ${formatMoney(today.bankTransferReceivedKobo)}`
              : 'Needs sales access'
          }
          to="/cash-register"
          visible={canSeeSales}
        />
        <StatCard
          icon={<TrendingUp size={18} />}
          tone="green"
          label="Gross profit today"
          value={today ? formatMoney(today.grossProfitKobo) : '—'}
          caption={
            today ? `Revenue minus ${formatMoney(today.costOfGoodsSoldKobo)} cost of goods` : '—'
          }
          to="/reports/financial"
          visible={canSeeSales}
        />
        <StatCard
          icon={<Receipt size={18} />}
          tone="amber"
          label="Outstanding debts"
          value={salesData ? formatMoney(today?.outstandingCreditKobo ?? 0) : '—'}
          caption={
            salesData
              ? `${salesData.openDebtCount} open across ${salesData.customersWithDebtCount} customer${salesData.customersWithDebtCount === 1 ? '' : 's'}`
              : 'Needs sales access'
          }
          to="/debts"
          visible={canSeeSales}
        />
      </section>

      <div className="dashboard-columns">
        <div className="dashboard-main">
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Last 7 days</h2>
                <p>Net sales revenue per day, from your completed sales.</p>
              </div>
              {hasPermission(user?.permissions ?? [], 'reports.view') && (
                <Link className="text-link" to="/reports">
                  Full reports <ArrowRight size={14} />
                </Link>
              )}
            </div>
            {salesData ? (
              trend.every((point) => point.netSalesRevenueKobo === 0) ? (
                <div className="chart-empty">
                  <span className="empty-icon">
                    <TrendingUp size={20} />
                  </span>
                  <h3>No sales in the last seven days</h3>
                  <p>The chart fills in as soon as you take your first sale.</p>
                  {user && hasPermission(user.permissions, 'pos.access') && (
                    <Link className="button button-secondary" to="/pos">
                      Take a sale
                    </Link>
                  )}
                </div>
              ) : (
                <div
                  className="bar-chart"
                  role="img"
                  aria-label="Net sales revenue for the last seven days"
                >
                  {trend.map((point) => {
                    const height = Math.max(
                      3,
                      Math.round((point.netSalesRevenueKobo / trendMax) * 100),
                    );
                    return (
                      <div key={point.date} className="bar-column">
                        <span className="bar-value">{formatMoney(point.netSalesRevenueKobo)}</span>
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ height: `${height}%` }}
                            title={`${point.date}: ${formatMoney(point.netSalesRevenueKobo)}`}
                          />
                        </div>
                        <span className="bar-label">
                          {new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(
                            new Date(`${point.date}T12:00:00`),
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="chart-empty">
                <p className="muted">Sales access is needed to display this chart.</p>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Recent sales</h2>
                <p>The last transactions taken at the counter.</p>
              </div>
              <Link className="text-link" to="/pos/sales">
                All sales <ArrowRight size={14} />
              </Link>
            </div>
            {!salesData ? (
              <p className="card-empty muted">Sales access is needed to display recent sales.</p>
            ) : salesData.recentSales.length === 0 ? (
              <p className="card-empty muted">
                No sales recorded yet. The first one will appear here with its receipt number.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th scope="col">Receipt</th>
                      <th scope="col">Customer</th>
                      <th scope="col">When</th>
                      <th scope="col" className="numeric">
                        Total
                      </th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesData.recentSales.slice(0, 6).map((sale) => (
                      <tr key={sale.id}>
                        <td>
                          <Link className="table-link" to={`/pos/sales/${sale.id}`}>
                            {sale.receiptNumber}
                          </Link>
                        </td>
                        <td>{sale.customerName ?? 'Walk-in'}</td>
                        <td className="muted small">{formatDateTime(sale.createdAt)}</td>
                        <td className="numeric">{formatMoney(sale.totalKobo)}</td>
                        <td>
                          <span
                            className={`status-pill status-${sale.status === 'completed' ? 'green' : 'neutral'}`}
                          >
                            {sale.status === 'completed' ? 'Completed' : capitalise(sale.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Recent stock movements</h2>
                <p>Every change to a balance, straight from the immutable ledger.</p>
              </div>
              <Link className="text-link" to="/inventory/movements">
                Full ledger <ArrowRight size={14} />
              </Link>
            </div>
            {!inventoryData ? (
              <p className="card-empty muted">Inventory access is needed to display the ledger.</p>
            ) : inventoryData.recentMovements.length === 0 ? (
              <p className="card-empty muted">No stock has moved yet.</p>
            ) : (
              <ul className="movement-list">
                {inventoryData.recentMovements.slice(0, 6).map((movement) => {
                  const positive = movement.quantity > 0;
                  return (
                    <li key={movement.id}>
                      <span className={`movement-icon ${positive ? 'is-in' : 'is-out'}`}>
                        {movement.movementType === 'stock_received' || positive ? (
                          <ArrowUpRight size={15} />
                        ) : (
                          <Layers3 size={15} />
                        )}
                      </span>
                      <div className="movement-text">
                        <strong>{movement.productName}</strong>
                        <small>
                          {humanise(movement.movementType)} · {movement.userName ?? 'System'}
                          {movement.batchNumber ? ` · batch ${movement.batchNumber}` : ''}
                        </small>
                      </div>
                      <div className="movement-numbers">
                        <span className={positive ? 'qty-in' : 'qty-out'}>
                          {positive ? '+' : ''}
                          {movement.quantity}
                        </span>
                        <small className="muted">
                          {movement.previousBalance} → {movement.newBalance}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="dashboard-side">
          <section className="card attention-card">
            <div className="card-heading">
              <div>
                <h2>Needs attention</h2>
                <p>Generated from your stock and customer records.</p>
              </div>
            </div>
            {alerts.length === 0 ? (
              <div className="all-clear">
                <CheckCircle2 size={20} />
                <div>
                  <strong>Nothing needs attention</strong>
                  <p>No expired stock, no low stock, no open balances.</p>
                </div>
              </div>
            ) : (
              <ul className="alert-list">
                {alerts.map((alert) => (
                  <li key={alert.title} className={`alert-${alert.tone}`}>
                    <Link to={alert.to}>
                      <span className="alert-icon">
                        {alert.tone === 'danger' ? (
                          <AlertTriangle size={15} />
                        ) : alert.tone === 'warn' ? (
                          <Clock size={15} />
                        ) : (
                          <Package size={15} />
                        )}
                      </span>
                      <span className="alert-body">
                        <strong>{alert.title}</strong>
                        <small>{alert.detail}</small>
                      </span>
                      <ArrowRight size={14} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Inventory value</h2>
                <p>What is on the shelf right now.</p>
              </div>
            </div>
            {inventoryData ? (
              <dl className="mini-stats">
                <div>
                  <dt>At cost</dt>
                  <dd>{formatMoney(inventoryData.stockValueCostKobo)}</dd>
                </div>
                <div>
                  <dt>At retail</dt>
                  <dd>{formatMoney(inventoryData.retailValueKobo)}</dd>
                </div>
                <div>
                  <dt>Units on hand</dt>
                  <dd>{inventoryData.totalStockQuantity.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Active products</dt>
                  <dd>{inventoryData.totalActiveProducts.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Suppliers</dt>
                  <dd>{inventoryData.totalSuppliers.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Categories</dt>
                  <dd>{inventoryData.totalCategories.toLocaleString()}</dd>
                </div>
              </dl>
            ) : (
              <p className="card-empty muted">Inventory access is needed to display stock value.</p>
            )}
          </section>

          {financeData && (
            <section className="card">
              <div className="card-heading">
                <div>
                  <h2>This month</h2>
                  <p>Cash-in, cost and profit kept separate.</p>
                </div>
                <Link className="text-link" to="/reports/financial">
                  Report <ArrowRight size={14} />
                </Link>
              </div>
              <dl className="mini-stats">
                <div>
                  <dt>Revenue</dt>
                  <dd>{formatMoney(financeData.sales.netSalesRevenueKobo)}</dd>
                </div>
                <div>
                  <dt>Collected</dt>
                  <dd>{formatMoney(financeData.collections.totalReceivedKobo)}</dd>
                </div>
                <div>
                  <dt>Operating expenses</dt>
                  <dd>{formatMoney(financeData.expenses.netKobo)}</dd>
                </div>
                <div>
                  <dt>Operating profit</dt>
                  <dd>{formatMoney(financeData.profitability.operatingProfitKobo)}</dd>
                </div>
              </dl>
            </section>
          )}

          <section className="card quick-actions">
            <div className="card-heading">
              <div>
                <h2>Quick actions</h2>
                <p>The things you do most, one click away.</p>
              </div>
            </div>
            <div className="quick-grid">
              {user && hasPermission(user.permissions, 'pos.access') && (
                <Link to="/pos">
                  <ShoppingBag size={17} /> Sell
                </Link>
              )}
              {user && hasPermission(user.permissions, 'stock.receive') && (
                <Link to="/inventory/receive">
                  <Package size={17} /> Receive stock
                </Link>
              )}
              {user && hasPermission(user.permissions, 'products.create') && (
                <Link to="/inventory/products/new">
                  <Plus size={17} /> New product
                </Link>
              )}
              {user && hasPermission(user.permissions, 'prescriptions.dispense') && (
                <Link to="/dispensing">
                  <Pill size={17} /> Dispense
                </Link>
              )}
              {user && hasPermission(user.permissions, 'patients.register') && (
                <Link to="/patients/new">
                  <Users size={17} /> New patient
                </Link>
              )}
              {user && hasPermission(user.permissions, 'purchases.create') && (
                <Link to="/purchases/new">
                  <ShoppingCart size={17} /> New purchase
                </Link>
              )}
              {user && hasPermission(user.permissions, 'expenses.create') && (
                <Link to="/inventory/expenses">
                  <Receipt size={17} /> Record expense
                </Link>
              )}
              <Link to="/inventory/batches">
                <CalendarDays size={17} /> Expiry watch
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function StatCard({
  icon,
  label,
  value,
  caption,
  to,
  tone,
  visible,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  caption: string;
  to: string;
  tone: 'green' | 'teal' | 'amber';
  visible: boolean;
}) {
  const body = (
    <>
      <div className="stat-top">
        <span className={`stat-icon ${tone}`}>{icon}</span>
        <span className="stat-label">{label}</span>
      </div>
      <strong className="stat-value">{visible ? value : '—'}</strong>
      <span className="stat-caption">{visible ? caption : 'You do not have access to this'}</span>
    </>
  );
  return visible ? (
    <Link className="stat-card" to={to}>
      {body}
    </Link>
  ) : (
    <div className="stat-card is-locked">{body}</div>
  );
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

function humanise(value: string) {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
