import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  ClipboardPlus,
  Package,
  Pill,
  Plus,
  Search,
  ShoppingBag,
  Stethoscope,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import {
  hasPermission,
  type InventoryDashboard,
  type Paginated,
  type ProductSummary,
  type SalesDashboardSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { formatMoney, useAsync } from '../inventory/lib';

/**
 * The pharmacy workspace. It is not a second product list: it answers the four questions a
 * pharmacist asks at the start of a shift — what is running out, what is about to expire, what am I
 * dispensing today, and what did we take. Each panel links into the module that owns the record, so
 * there is exactly one place to act.
 */
export function PharmacyPage() {
  const { user, api } = useApp();
  const canSeeStock = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const canSeeSales = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const canDispense = Boolean(user && hasPermission(user.permissions, 'prescriptions.dispense'));
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
  const medicineState = useAsync<Paginated<ProductSummary> | null>(
    () =>
      canSeeStock
        ? api.request<Paginated<ProductSummary>>(
            '/api/products?type=medicine&status=active&sort=name&pageSize=6',
          )
        : Promise.resolve(null),
    [canSeeStock],
  );
  const stock = stockState.data;
  const sales = salesState.data;
  const medicines = medicineState.data;
  const error = stockState.error ?? salesState.error;

  const expiryPressure = useMemo(() => {
    if (!stock) return null;
    return stock.expiredBatchCount > 0 || stock.nearExpiryBatchCount > 0;
  }, [stock]);

  return (
    <>
      <PageHeading
        title="Pharmacy"
        description="Dispensing, medicine stock and expiry in one operational view. Everything here reads from the same stock ledger as the rest of MediMart."
        action={
          <div className="heading-buttons">
            {user && hasPermission(user.permissions, 'products.create') && (
              <Link className="button button-primary" to="/inventory/products/new">
                <Plus size={16} /> Register medicine
              </Link>
            )}
            {canDispense && (
              <Link className="button button-secondary" to="/dispensing">
                <ClipboardPlus size={16} /> Dispense
              </Link>
            )}
          </div>
        }
      />
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}

      <section className="stat-grid">
        <Link className="stat-card" to="/inventory/products?type=medicine">
          <div className="stat-top">
            <span className="stat-icon green">
              <Pill size={18} />
            </span>
            <span className="stat-label">Medicines on file</span>
          </div>
          <strong className="stat-value">{stock ? stock.totalActiveProducts : '—'}</strong>
          <span className="stat-caption">Active products across the whole catalogue</span>
        </Link>
        <Link className="stat-card" to="/inventory/batches?status=expiring">
          <div className="stat-top">
            <span className="stat-icon amber">
              <CalendarClock size={18} />
            </span>
            <span className="stat-label">Near expiry</span>
          </div>
          <strong className="stat-value">{stock ? stock.nearExpiryBatchCount : '—'}</strong>
          <span className="stat-caption">
            {stock
              ? `${stock.nearExpiryUnits} units inside ${stock.expiryAlertDays} days`
              : 'Needs inventory access'}
          </span>
        </Link>
        <Link className="stat-card" to="/inventory/batches?status=expired">
          <div className="stat-top">
            <span className="stat-icon amber">
              <TriangleAlert size={18} />
            </span>
            <span className="stat-label">Expired batches</span>
          </div>
          <strong className="stat-value">{stock ? stock.expiredBatchCount : '—'}</strong>
          <span className="stat-caption">
            {expiryPressure ? 'Blocked from sale automatically' : 'Nothing expired on the shelf'}
          </span>
        </Link>
        <Link className="stat-card" to="/inventory/products?stock=low">
          <div className="stat-top">
            <span className="stat-icon teal">
              <TriangleAlert size={18} />
            </span>
            <span className="stat-label">Low or out of stock</span>
          </div>
          <strong className="stat-value">
            {stock ? stock.lowStockCount + stock.outOfStockCount : '—'}
          </strong>
          <span className="stat-caption">
            {stock ? `${stock.outOfStockCount} with no sellable units` : 'Needs inventory access'}
          </span>
        </Link>
      </section>

      <div className="dashboard-columns">
        <div className="dashboard-main">
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Medicines</h2>
                <p>The active medicines in your catalogue, ready to sell or dispense.</p>
              </div>
              <Link className="text-link" to="/inventory/products?type=medicine">
                All products <ArrowRight size={14} />
              </Link>
            </div>
            {!canSeeStock ? (
              <p className="card-empty muted">Inventory access is needed to list medicines.</p>
            ) : !medicines ? (
              <p className="card-empty muted">Loading medicines…</p>
            ) : medicines.items.length === 0 ? (
              <div className="chart-empty">
                <span className="empty-icon">
                  <Pill size={20} />
                </span>
                <h3>No medicines registered yet</h3>
                <p>Register your first medicine, or import your supplier catalogue in bulk.</p>
                <div className="heading-buttons">
                  <Link className="button button-primary" to="/inventory/products/new">
                    Register a medicine
                  </Link>
                  <Link className="button button-secondary" to="/inventory/products/import">
                    Import a spreadsheet
                  </Link>
                </div>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th scope="col">Medicine</th>
                      <th scope="col">Form &amp; strength</th>
                      <th scope="col" className="numeric">
                        In stock
                      </th>
                      <th scope="col" className="numeric">
                        Price
                      </th>
                      <th scope="col">Nearest expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {medicines.items.map((medicine) => (
                      <tr key={medicine.id}>
                        <td>
                          <Link className="table-link" to={`/inventory/products/${medicine.id}`}>
                            {medicine.name}
                          </Link>
                          {medicine.genericName && (
                            <div>
                              <small className="muted">{medicine.genericName}</small>
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="muted small">
                            {[medicine.dosageForm, medicine.strength].filter(Boolean).join(' · ') ||
                              '—'}
                          </span>
                        </td>
                        <td className="numeric">
                          {medicine.stockQuantity} {medicine.baseUnitSymbol}
                        </td>
                        <td className="numeric">{formatMoney(medicine.sellingPriceKobo)}</td>
                        <td>
                          <span className="muted small">
                            {medicine.nearestExpiryDate ?? 'Not tracked'}
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
                <p>Receipts into the pharmacy and deductions from dispensing.</p>
              </div>
              <Link className="text-link" to="/inventory/movements">
                Ledger <ArrowRight size={14} />
              </Link>
            </div>
            {!stock || stock.recentMovements.length === 0 ? (
              <p className="card-empty muted">No pharmacy stock has moved yet.</p>
            ) : (
              <ul className="movement-list">
                {stock.recentMovements.slice(0, 5).map((movement) => (
                  <li key={movement.id}>
                    <span className={`movement-icon ${movement.quantity > 0 ? 'is-in' : 'is-out'}`}>
                      {movement.quantity > 0 ? <ArrowUpRight size={15} /> : <Boxes size={15} />}
                    </span>
                    <div className="movement-text">
                      <strong>{movement.productName}</strong>
                      <small>
                        {movement.movementType.replace(/_/g, ' ')} · {movement.userName ?? 'System'}
                      </small>
                    </div>
                    <div className="movement-numbers">
                      <span className={movement.quantity > 0 ? 'qty-in' : 'qty-out'}>
                        {movement.quantity > 0 ? '+' : ''}
                        {movement.quantity}
                      </span>
                      <small className="muted">
                        {movement.previousBalance} → {movement.newBalance}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="dashboard-side">
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Today</h2>
                <p>Pharmacy takings and prescriptions.</p>
              </div>
            </div>
            <dl className="mini-stats">
              <div>
                <dt>Sales revenue</dt>
                <dd>{sales ? formatMoney(sales.todayFinancials.salesRevenueKobo) : '—'}</dd>
              </div>
              <div>
                <dt>Transactions</dt>
                <dd>{sales ? sales.todayTransactionsCount : '—'}</dd>
              </div>
              <div>
                <dt>Gross profit</dt>
                <dd>{sales ? formatMoney(sales.todayFinancials.grossProfitKobo) : '—'}</dd>
              </div>
              <div>
                <dt>Stock value (cost)</dt>
                <dd>{stock ? formatMoney(stock.stockValueCostKobo) : '—'}</dd>
              </div>
            </dl>
          </section>
          <section className="card quick-actions">
            <div className="card-heading">
              <div>
                <h2>Pharmacy workflow</h2>
                <p>From consultation to a dispensed prescription.</p>
              </div>
            </div>
            <div className="workflow-list">
              {hasPermission(user?.permissions ?? [], 'patients.register') && (
                <Link to="/patients/new">
                  <Stethoscope size={17} /> Register a patient
                </Link>
              )}
              {hasPermission(user?.permissions ?? [], 'prescriptions.create') && (
                <Link to="/prescriptions/new">
                  <ClipboardPlus size={17} /> Write a prescription
                </Link>
              )}
              {canDispense && (
                <Link to="/dispensing">
                  <Pill size={17} /> Dispense authorised items
                </Link>
              )}
              {hasPermission(user?.permissions ?? [], 'stock.receive') && (
                <Link to="/inventory/receive">
                  <Package size={17} /> Receive a delivery
                </Link>
              )}
              {hasPermission(user?.permissions ?? [], 'pos.access') && (
                <Link to="/pos">
                  <ShoppingBag size={17} /> Take a pharmacy sale
                </Link>
              )}
              {hasPermission(user?.permissions ?? [], 'reports.view') && (
                <Link to="/reports">
                  <TrendingUp size={17} /> Pharmacy report
                </Link>
              )}
            </div>
          </section>
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Search the catalogue</h2>
                <p>Find a medicine by name, brand, SKU or barcode.</p>
              </div>
            </div>
            <form
              className="inline-search"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get('q');
                window.location.hash = `#/inventory/products?search=${encodeURIComponent(String(value ?? ''))}`;
              }}
            >
              <Search size={16} />
              <input name="q" placeholder="e.g. amoxicillin 500" aria-label="Search medicines" />
              <button type="submit" className="button button-secondary">
                Search
              </button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
