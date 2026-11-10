import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  CircleCheck,
  Database,
  HeartPulse,
  Layers3,
  Package,
  Pill,
  Plus,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Store,
  Users,
  Wallet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  hasPermission,
  type FinancialDashboardSummary,
  type InventoryDashboard,
  type SalesDashboardSummary,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { Badge, Button, PageHeading, TextLink } from '../components/ui';
import { formatMoney } from './inventory/lib';
const metrics = [
  {
    key: 'sales',
    label: 'Today’s sales',
    icon: ShoppingBag,
    caption: 'A fresh start for your business',
    tone: 'green',
    path: '/pos',
  },
  {
    key: 'products',
    label: 'Active products',
    icon: Package,
    caption: 'Open the inventory workspace',
    tone: 'blue',
    path: '/inventory',
  },
  {
    key: 'lowstock',
    label: 'Below reorder level',
    icon: Layers3,
    caption: 'Stay a step ahead of restocking',
    tone: 'amber',
    path: '/inventory/products?stock=low',
  },
  {
    key: 'patients',
    label: 'Registered patients',
    icon: HeartPulse,
    caption: 'Care starts with a connection',
    tone: 'purple',
    path: '/patients',
  },
];
const modules = [
  {
    title: 'Pharmacy',
    text: 'Thoughtful tools for better care.',
    icon: Pill,
    path: '/pharmacy',
    tone: 'green',
    tag: 'HEALTH & WELLNESS',
  },
  {
    title: 'Mini-Mart',
    text: 'Everyday retail. All in one place.',
    icon: Store,
    path: '/mini-mart',
    tone: 'blue',
    tag: 'RETAIL & COMMERCE',
  },
  {
    title: 'Patient care',
    text: 'Put people at the heart of it all.',
    icon: HeartPulse,
    path: '/patients',
    tone: 'purple',
    tag: 'PEOPLE & CARE',
  },
];
export function Dashboard() {
  const { user, connection, runtime, bootstrap, refresh, api } = useApp();
  const userId = user?.id;
  const canSeeInventory = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const canSeeSales = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const canSeeFinance = Boolean(user && hasPermission(user.permissions, 'reports.view'));
  const [loaded, setLoaded] = useState<{ userId: string; data: InventoryDashboard | null } | null>(
    null,
  );
  const [salesLoaded, setSalesLoaded] = useState<{
    userId: string;
    data: SalesDashboardSummary | null;
  } | null>(null);
  const [financeLoaded, setFinanceLoaded] = useState<{
    userId: string;
    data: FinancialDashboardSummary | null;
  } | null>(null);
  // Only the signed-in owner of the fetched figures may see them; stale results are ignored.
  const inventory = canSeeInventory && loaded && loaded.userId === userId ? loaded.data : null;
  const sales =
    canSeeSales && salesLoaded && salesLoaded.userId === userId ? salesLoaded.data : null;
  const finance =
    canSeeFinance && financeLoaded && financeLoaded.userId === userId ? financeLoaded.data : null;
  useEffect(() => {
    if (!canSeeInventory || !userId) return;
    let active = true;
    void api
      .request<InventoryDashboard>('/api/inventory/dashboard')
      .then((data) => {
        if (active) setLoaded({ userId, data });
      })
      .catch(() => {
        if (active) setLoaded({ userId, data: null });
      });
    return () => {
      active = false;
    };
  }, [api, canSeeInventory, userId]);
  useEffect(() => {
    if (!canSeeFinance || !userId) return;
    let active = true;
    const now = new Date();
    const from = `${now.toISOString().slice(0, 7)}-01`;
    const to = now.toISOString().slice(0, 10);
    void api
      .request<FinancialDashboardSummary>(`/api/finance/dashboard?from=${from}&to=${to}`)
      .then((data) => {
        if (active) setFinanceLoaded({ userId, data });
      })
      .catch(() => {
        if (active) setFinanceLoaded({ userId, data: null });
      });
    return () => {
      active = false;
    };
  }, [api, canSeeFinance, userId]);
  useEffect(() => {
    if (!canSeeSales || !userId) return;
    let active = true;
    void api
      .request<SalesDashboardSummary>('/api/sales/summary')
      .then((data) => {
        if (active) setSalesLoaded({ userId, data });
      })
      .catch(() => {
        if (active) setSalesLoaded({ userId, data: null });
      });
    return () => {
      active = false;
    };
  }, [api, canSeeSales, userId]);
  const liveMetric = (key: string) => {
    if (key === 'sales' && sales) {
      return {
        value: formatMoney(sales.todayFinancials.salesRevenueKobo),
        caption: `${sales.todayTransactionsCount} transaction${sales.todayTransactionsCount === 1 ? '' : 's'} today`,
      };
    }
    if (!inventory) return null;
    if (key === 'products')
      return { value: String(inventory.totalActiveProducts), caption: 'Inventory workspace' };
    if (key === 'lowstock')
      return {
        value: String(inventory.lowStockCount),
        caption: `${inventory.outOfStockCount} out of stock`,
      };
    return null;
  };
  const online = connection === 'online';
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());
  const ready = Boolean(user);
  const setupCount = 1 + Number(online) + Number(ready);
  return (
    <>
      <PageHeading
        title="Dashboard"
        description={`Welcome${user ? `, ${user.fullName.split(' ')[0]}` : ' to MediMart'}. Here’s where a healthier business begins.`}
        action={
          <>
            <span className="date-label">
              <CalendarDays size={16} />
              {date}
            </span>
            <Link to="/settings" className="button button-secondary">
              <Settings2 size={16} />
              Customize workspace
            </Link>
          </>
        }
      />
      <section className="welcome-banner">
        <div className="welcome-copy">
          <span className="welcome-kicker">
            <span />
            YOUR BUSINESS. IN GOOD HANDS.
          </span>
          <h2>
            A connected workspace.
            <br />A healthier business.
          </h2>
          <p>
            Pharmacy, retail, and patient care — together in one
            <br className="desktop-break" /> secure workspace, built to grow with you.
          </p>
          <Link
            className="button button-primary"
            to={ready ? '/settings' : bootstrap?.required ? '/register' : '/login'}
          >
            {ready ? 'Manage your workspace' : 'Set up your workspace'}
            <ArrowRight size={16} />
          </Link>
          <span className="banner-footnote">
            <ShieldCheck size={13} />
            Local-first. Secure by design.
          </span>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-dot dot-one" />
          <div className="art-dot dot-two" />
          <div className="art-main-tile">
            <span className="art-plus">
              <span />
              <span />
            </span>
            <div className="art-main-line" />
            <div className="art-main-line short" />
          </div>
          <div className="art-floating art-pill">
            <Pill size={27} strokeWidth={1.5} />
            <span>Pharmacy</span>
            <span className="art-tick">
              <Check size={12} />
            </span>
          </div>
          <div className="art-floating art-store">
            <Store size={26} strokeWidth={1.5} />
            <span>Mini-Mart</span>
          </div>
          <div className="art-floating art-heart">
            <HeartPulse size={25} strokeWidth={1.5} />
          </div>
          <div className="art-protected">
            <ShieldCheck size={14} />
            <span>Built around your business</span>
          </div>
        </div>
        <div className="banner-phase">
          PHASE 05 <span>PURCHASING &amp; FINANCE</span>
        </div>
      </section>
      <div className="section-title">
        <h2>Business overview</h2>
        <span className="subtle-label">
          <span className="hollow-dot" />
          {sales || inventory ? 'Sales & inventory are live' : 'Ready for your first records'}
        </span>
      </div>
      <section className="metric-grid" aria-label="Business metrics overview">
        {metrics.map((metric) => {
          const live = liveMetric(metric.key);
          return (
            <Link key={metric.label} to={metric.path} className="metric-card">
              <div className="metric-top">
                <span className={`icon-tile ${metric.tone}`}>
                  <metric.icon size={20} strokeWidth={1.7} />
                </span>
                <span className="metric-period">{live ? 'LIVE' : 'COMING SOON'}</span>
              </div>
              <h3>{metric.label}</h3>
              <div className="metric-value">
                {live ? live.value : '—'}
                {!live && <span>Not available yet</span>}
              </div>
              <div className="metric-caption">
                {live ? live.caption : metric.caption}
                <ArrowUpRight size={14} />
              </div>
            </Link>
          );
        })}
      </section>
      {sales && (
        <section
          className="card inventory-card dashboard-sales-strip"
          aria-label="Today's collections and credit separation"
        >
          <div className="card-heading">
            <div>
              <h2>Today’s sales, collections &amp; credit separation</h2>
              <p>
                Sales revenue, money actually received, unpaid credit, COGS, and gross profit are
                reported separately.
              </p>
            </div>
            <div className="row-actions">
              <Link to="/pos" className="button button-primary">
                Open POS
              </Link>
              {hasPermission(user!.permissions, 'reports.view') && (
                <Link to="/reports" className="button button-secondary">
                  Full report
                </Link>
              )}
            </div>
          </div>
          <div className="inventory-metrics" style={{ margin: '0 21px' }}>
            <div className="inventory-metric">
              <span className="muted small">Net sales revenue</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.salesRevenueKobo)}
              </div>
              <small className="muted">
                {sales.todayTransactionsCount} completed · {sales.todayVoidedCount} voided
              </small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Cash received</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.cashMethodReceivedKobo)}
              </div>
              <small className="muted">Physical cash retained</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Bank transfers received</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.bankTransferReceivedKobo)}
              </div>
              <small className="muted">Confirmed bank transfers</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">POS terminal received</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.posReceivedKobo)}
              </div>
              <small className="muted">Card terminal collections</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Today’s credit sales</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.periodCreditSalesKobo)}
              </div>
              <small className="muted">Unpaid at checkout (not cash)</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Outstanding debts</span>
              <div className="metric-value">
                {formatMoney(sales.todayFinancials.outstandingCreditKobo)}
              </div>
              <small className="muted">
                {sales.openDebtCount} open across {sales.customersWithDebtCount} customer
                {sales.customersWithDebtCount === 1 ? '' : 's'}
              </small>
            </div>
            {sales.todayFinancials.grossProfitKobo !== null && (
              <>
                <div className="inventory-metric">
                  <span className="muted small">Cost of goods sold</span>
                  <div className="metric-value">
                    {formatMoney(sales.todayFinancials.costOfGoodsSoldKobo)}
                  </div>
                  <small className="muted">Batch-allocated unit cost</small>
                </div>
                <div className="inventory-metric">
                  <span className="muted small">Gross profit (pre-expense)</span>
                  <div className="metric-value">
                    {formatMoney(sales.todayFinancials.grossProfitKobo)}
                  </div>
                  <small className="muted">Revenue minus COGS</small>
                </div>
              </>
            )}
          </div>
        </section>
      )}
      {finance && (
        <section className="card inventory-card" aria-label="Financial overview for this month">
          <div className="card-heading">
            <div>
              <h2>Financial overview · this month</h2>
              <p>
                Sales, collections, purchases, supplier debt, expenses and operating profit stay
                separate. Profit accounts for stock cost, not purchase totals.
              </p>
            </div>
            <div className="row-actions">
              <Link to="/purchases" className="button button-secondary">
                <ShoppingCart size={15} /> Purchases
              </Link>
              <Link to="/reports/financial" className="button button-primary">
                Financial reports
              </Link>
            </div>
          </div>
          <div className="inventory-metrics" style={{ margin: '0 21px' }}>
            <div className="inventory-metric green">
              <span className="muted small">Net sales revenue</span>
              <div className="metric-value">{formatMoney(finance.sales.netSalesRevenueKobo)}</div>
              <small className="muted">{finance.sales.transactionsCount} sales this month</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Money collected</span>
              <div className="metric-value">
                {formatMoney(finance.collections.totalReceivedKobo)}
              </div>
              <small className="muted">Cash, transfer, POS and debt repayments</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Goods received</span>
              <div className="metric-value">{formatMoney(finance.purchases.goodsReceivedKobo)}</div>
              <small className="muted">
                {formatMoney(finance.purchases.totalOrderedKobo)} ordered
              </small>
            </div>
            <div className="inventory-metric amber">
              <span className="muted small">Owed to suppliers</span>
              <div className="metric-value">
                {formatMoney(finance.purchases.outstandingSupplierBalanceKobo)}
              </div>
              <small className="muted">
                {finance.purchases.outstandingInvoiceCount} open invoices
              </small>
            </div>
            <div className="inventory-metric red">
              <span className="muted small">Operating expenses</span>
              <div className="metric-value">{formatMoney(finance.expenses.netKobo)}</div>
              <small className="muted">Excludes drafts and reversed expenses</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Operating profit</span>
              <div className="metric-value">
                {formatMoney(finance.profitability.operatingProfitKobo)}
              </div>
              <small className="muted">Net sales − COGS − operating expenses</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Stock at cost</span>
              <div className="metric-value">
                {formatMoney(finance.inventory.stockValueCostKobo)}
              </div>
              <small className="muted">
                <Wallet size={12} /> {finance.inventory.stockUnits} units on hand
              </small>
            </div>
          </div>
        </section>
      )}
      <div className="dashboard-middle">
        <section className="card setup-card">
          <div className="card-heading">
            <div>
              <div className="inline-heading">
                <span className="mini-icon">
                  <Sparkles size={17} />
                </span>
                <h2>Let’s make it yours</h2>
              </div>
              <p>A few simple steps to a well-organized workspace.</p>
            </div>
            <Badge tone="green">{setupCount} of 3 ready</Badge>
          </div>
          <div
            className="setup-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={3}
            aria-valuenow={setupCount}
            aria-label={`${setupCount} of 3 foundation checks complete`}
          >
            <span style={{ width: `${(setupCount / 3) * 100}%` }} />
          </div>
          <div className="setup-steps">
            <Link
              to={ready ? '/settings' : bootstrap?.required ? '/register' : '/login'}
              className="setup-step"
            >
              <span className={`step-number ${ready ? 'complete' : ''}`}>
                {ready ? <Check size={16} /> : '01'}
              </span>
              <span>
                <strong>
                  {ready
                    ? 'Your account is ready'
                    : bootstrap?.required
                      ? 'Create your owner account'
                      : 'Sign in to your workspace'}
                </strong>
                <small>
                  {ready
                    ? 'Individual access, protected by role-based permissions.'
                    : 'Start with a secure account that belongs to you.'}
                </small>
              </span>
              {ready ? <CircleCheck className="step-done" size={18} /> : <ArrowRight size={17} />}
            </Link>
            <Link to="/settings?tab=connection" className="setup-step">
              <span className={`step-number ${online ? 'complete' : ''}`}>
                {online ? <Check size={16} /> : '02'}
              </span>
              <span>
                <strong>
                  {online ? 'Your central server is connected' : 'Connect your central server'}
                </strong>
                <small>
                  {online
                    ? 'The local API and SQLite database are responding.'
                    : 'Bring your devices together on your local network.'}
                </small>
              </span>
              {online ? <CircleCheck className="step-done" size={18} /> : <ArrowRight size={17} />}
            </Link>
            <Link to="/settings?tab=team" className="setup-step">
              <span className="step-number complete">
                <Check size={16} />
              </span>
              <span>
                <strong>Secure access is built in</strong>
                <small>Seven purpose-specific roles, ready for your team.</small>
              </span>
              <CircleCheck className="step-done" size={18} />
            </Link>
          </div>
          <div className="setup-card-footer">
            <Users size={15} />
            <span>A good foundation makes room for everyone.</span>
            <TextLink to="/settings?tab=team">Set up your team</TextLink>
          </div>
        </section>
        <section className="card connection-card">
          <div className="card-heading">
            <h2>Connection & storage</h2>
            <span className={`connection-icon ${online ? 'green' : 'amber'}`}>
              {online ? <Wifi size={18} /> : <WifiOff size={18} />}
            </span>
          </div>
          <div className="connection-status">
            <span className={`status-dot ${online ? '' : 'dot-muted'}`} />
            <strong>
              {online
                ? 'You’re locally connected'
                : connection === 'unconfigured'
                  ? 'Ready to get connected'
                  : connection === 'checking'
                    ? 'Checking your connection'
                    : 'Your server is offline'}
            </strong>
            <p>
              {online
                ? 'A healthy connection to your central workspace.'
                : 'The workspace shell remains available. Protected actions need a verified server session.'}
            </p>
          </div>
          <div className="connection-details">
            <div>
              <span>
                <Database size={15} />
                {runtime.native ? 'Device database' : 'Central database'}
              </span>
              <Badge tone={runtime.native || online ? 'green' : 'neutral'}>
                {runtime.native || online ? 'SQLite · Ready' : 'Unreachable'}
              </Badge>
            </div>
            <div>
              <span>
                <Smartphone size={15} />
                This device
              </span>
              <strong>{runtime.native ? 'Android · Local SQLite' : 'Browser workspace'}</strong>
            </div>
            <div>
              <span>
                <CheckCheck size={15} />
                Synchronization
              </span>
              <span className="muted">Not active in Phase 1</span>
            </div>
          </div>
          <Button
            variant="ghost"
            className="connection-action"
            onClick={() => {
              void refresh();
            }}
          >
            <span>Check connection</span>
            <ArrowRight size={15} />
          </Button>
        </section>
      </div>
      <div className="section-title workspace-section-title">
        <div>
          <h2>A place for every part of your business</h2>
          <p>Purpose-built spaces. One connected MediMart.</p>
        </div>
        <Badge>YOUR WORKSPACE</Badge>
      </div>
      <section className="module-grid">
        {modules.map((module) => (
          <Link key={module.title} className="module-card" to={module.path}>
            <div className="module-top">
              <span className={`module-icon ${module.tone}`}>
                <module.icon size={27} strokeWidth={1.6} />
              </span>
              <ArrowUpRight size={19} />
            </div>
            <span className="module-tag">{module.tag}</span>
            <h3>{module.title}</h3>
            <p>{module.text}</p>
            <div className="module-footer">
              <span>
                <Circle size={7} fill="currentColor" />
                Planned module
              </span>
              <ChevronRight size={15} />
            </div>
          </Link>
        ))}
      </section>
      <div className="foundation-strip">
        <span className="foundation-strip-icon">
          <ArrowDownToLine size={21} />
        </span>
        <div>
          <strong>Made to work where you work.</strong>
          <p>
            Android assets are bundled locally. Internet-independent operations are the design goal,
            not a cloud subscription.
          </p>
        </div>
        <Link to="/backup-sync">
          Offline-first foundation
          <ArrowRight size={15} />
        </Link>
      </div>
      {!user && (
        <p className="preview-disclaimer">
          <Plus size={12} /> Inventory, Point of Sale, receipts, customers, and debts are live. Sign
          in to access your business records.
        </p>
      )}
    </>
  );
}
