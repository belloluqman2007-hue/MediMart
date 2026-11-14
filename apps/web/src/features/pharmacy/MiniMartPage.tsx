import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Package,
  Plus,
  ShoppingBag,
  ShoppingCart,
  Store,
  TrendingUp,
} from 'lucide-react';
import {
  hasPermission,
  productTypeLabels,
  type InventoryDashboard,
  type Paginated,
  type ProductSummary,
  type ProductType,
  type SalesDashboardSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { formatMoney, useAsync } from '../inventory/lib';

/**
 * Retail workspace. It reads the same product table as inventory but filters to the retail types, so
 * a shopkeeper sees foodstuff, drinks and general goods without the pharmacy catalogue in the way.
 */
export function MiniMartPage() {
  const { user, api } = useApp();
  const canSeeStock = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const canSeeSales = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const retailTypes: ProductType[] = ['foodstuff', 'drinks', 'snacks', 'general'];
  const stockState = useAsync<InventoryDashboard | null>(
    () =>
      canSeeStock
        ? api.request<InventoryDashboard>('/api/inventory/dashboard')
        : Promise.resolve(null),
    [canSeeStock],
  );
  const salesState = useAsync<SalesDashboardSummary | null>(
    () =>
      canSeeSales
        ? api.request<SalesDashboardSummary>('/api/sales/summary')
        : Promise.resolve(null),
    [canSeeSales],
  );
  const groupsState = useAsync(() => {
    if (!canSeeStock) return Promise.resolve([]);
    return Promise.all(
      retailTypes.map(async (type) => ({
        type,
        page: await api.request<Paginated<ProductSummary>>(
          `/api/products?type=${type}&status=active&sort=name&pageSize=4`,
        ),
      })),
    ).then((result) => result.filter((group) => group.page.total > 0));
  }, [canSeeStock]);
  const stock = stockState.data;
  const sales = salesState.data;
  const groups = useMemo(() => groupsState.data ?? [], [groupsState.data]);
  const loading = groupsState.loading;

  return (
    <>
      <PageHeading
        title="Mini-Mart"
        description="Everyday retail that shares one stock ledger, one till and one set of reports with the pharmacy."
        action={
          <div className="heading-buttons">
            {user && hasPermission(user.permissions, 'products.create') && (
              <Link className="button button-primary" to="/inventory/products/new">
                <Plus size={16} /> Add item
              </Link>
            )}
            {user && hasPermission(user.permissions, 'pos.access') && (
              <Link className="button button-secondary" to="/pos">
                <ShoppingBag size={16} /> Open POS
              </Link>
            )}
          </div>
        }
      />
      <section className="stat-grid">
        <Link className="stat-card" to="/inventory/products">
          <div className="stat-top">
            <span className="stat-icon teal">
              <Store size={18} />
            </span>
            <span className="stat-label">Retail items</span>
          </div>
          <strong className="stat-value">
            {groups.reduce((sum, group) => sum + group.page.total, 0)}
          </strong>
          <span className="stat-caption">Foodstuff, drinks, snacks and general goods</span>
        </Link>
        <Link className="stat-card" to="/inventory/products?stock=low">
          <div className="stat-top">
            <span className="stat-icon amber">
              <Package size={18} />
            </span>
            <span className="stat-label">Below reorder level</span>
          </div>
          <strong className="stat-value">{stock ? stock.lowStockCount : '—'}</strong>
          <span className="stat-caption">Restock before the shelf empties</span>
        </Link>
        <Link className="stat-card" to="/inventory/products?stock=out">
          <div className="stat-top">
            <span className="stat-icon amber">
              <Boxes size={18} />
            </span>
            <span className="stat-label">Out of stock</span>
          </div>
          <strong className="stat-value">{stock ? stock.outOfStockCount : '—'}</strong>
          <span className="stat-caption">No sellable units right now</span>
        </Link>
        <Link className="stat-card" to="/pos/sales">
          <div className="stat-top">
            <span className="stat-icon green">
              <TrendingUp size={18} />
            </span>
            <span className="stat-label">Sales today</span>
          </div>
          <strong className="stat-value">
            {sales ? formatMoney(sales.todayFinancials.salesRevenueKobo) : '—'}
          </strong>
          <span className="stat-caption">
            {sales
              ? `${sales.todayTransactionsCount} transaction${sales.todayTransactionsCount === 1 ? '' : 's'} across the shop`
              : 'Needs sales access'}
          </span>
        </Link>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Retail categories</h2>
            <p>A quick look at what is on the shelves, by type.</p>
          </div>
          <Link className="text-link" to="/inventory/products">
            Manage catalogue <ArrowRight size={14} />
          </Link>
        </div>
        {!canSeeStock ? (
          <p className="card-empty muted">Inventory access is needed to list retail items.</p>
        ) : loading ? (
          <p className="card-empty muted">Loading retail items…</p>
        ) : groups.length === 0 ? (
          <div className="chart-empty">
            <span className="empty-icon">
              <Store size={20} />
            </span>
            <h3>No retail items yet</h3>
            <p>
              Add drinks, snacks or household goods to your catalogue and they will appear here,
              priced and stocked like everything else.
            </p>
            {user && hasPermission(user.permissions, 'products.create') && (
              <Link className="button button-primary" to="/inventory/products/new">
                Add the first item
              </Link>
            )}
          </div>
        ) : (
          <div className="retail-groups">
            {groups.map((group) => (
              <div key={group.type} className="retail-group">
                <h3>
                  {productTypeLabels[group.type]}
                  <span className="muted small">{group.page.total} items</span>
                </h3>
                <ul>
                  {group.page.items.map((item) => (
                    <li key={item.id}>
                      <Link to={`/inventory/products/${item.id}`}>
                        <span className="retail-name">{item.name}</span>
                        <span className="retail-meta">
                          {item.stockQuantity} {item.baseUnitSymbol} ·{' '}
                          {formatMoney(item.sellingPriceKobo)}
                        </span>
                        <ArrowUpRight size={14} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Purchasing &amp; receiving</h2>
            <p>Restocking is the same workflow whether the goods are medicine or groceries.</p>
          </div>
        </div>
        <div className="workflow-list horizontal">
          {hasPermission(user?.permissions ?? [], 'purchases.create') && (
            <Link to="/purchases/new">
              <ShoppingCart size={17} /> Create a purchase order
            </Link>
          )}
          {hasPermission(user?.permissions ?? [], 'purchases.receive') && (
            <Link to="/inventory/purchases/receipts">
              <Package size={17} /> Receive goods
            </Link>
          )}
          {hasPermission(user?.permissions ?? [], 'suppliers.manage') && (
            <Link to="/suppliers">
              <Store size={17} /> Manage suppliers
            </Link>
          )}
          {hasPermission(user?.permissions ?? [], 'reports.view') && (
            <Link to="/reports/financial">
              <TrendingUp size={17} /> Financial report
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
