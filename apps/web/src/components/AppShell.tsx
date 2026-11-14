import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Store,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  hasPermission,
  type InventoryDashboard,
  type SalesDashboardSummary,
} from '@medimart/shared';
import { useApp } from '../lib/context';
import { navigation, navigationGroups } from '../lib/navigation';
import { errorMessage } from '../lib/api';
import { Badge, Brand, Button, FoundationNote, Modal } from './ui';
export function AppShell() {
  const { user, connection, runtime, signOut, notify, api } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /**
   * Notifications are the same real signals the dashboard uses: expiry, low stock and debt. They are
   * fetched only for the permissions the signed-in user holds, so the bell can never be a way to read
   * figures the user's role excludes.
   */
  const [notifications, setNotifications] = useState<
    { tone: 'warn' | 'danger' | 'info'; text: string; to: string }[]
  >([]);
  const canReadStock = Boolean(user && hasPermission(user.permissions, 'inventory.view'));
  const canReadSales = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  useEffect(() => {
    let active = true;
    const load = async () => {
      const items: { tone: 'warn' | 'danger' | 'info'; text: string; to: string }[] = [];
      if (canReadStock) {
        try {
          const stock = await api.request<InventoryDashboard>('/api/inventory/dashboard');
          if (stock.expiredBatchCount > 0)
            items.push({
              tone: 'danger',
              text: `${stock.expiredBatchCount} expired batch${stock.expiredBatchCount === 1 ? '' : 'es'} must not be sold`,
              to: '/inventory/batches?status=expired',
            });
          if (stock.nearExpiryBatchCount > 0)
            items.push({
              tone: 'warn',
              text: `${stock.nearExpiryBatchCount} batch${stock.nearExpiryBatchCount === 1 ? '' : 'es'} expire within ${stock.expiryAlertDays} days`,
              to: '/inventory/batches?status=expiring',
            });
          if (stock.lowStockCount > 0)
            items.push({
              tone: 'warn',
              text: `${stock.lowStockCount} product${stock.lowStockCount === 1 ? '' : 's'} below reorder level`,
              to: '/inventory/products?stock=low',
            });
          if (stock.outOfStockCount > 0)
            items.push({
              tone: 'info',
              text: `${stock.outOfStockCount} product${stock.outOfStockCount === 1 ? '' : 's'} out of stock`,
              to: '/inventory/products?stock=out',
            });
        } catch {
          // A failed fetch leaves the bell empty rather than showing an invented alert.
        }
      }
      if (canReadSales) {
        try {
          const summary = await api.request<SalesDashboardSummary>('/api/sales/summary');
          if (summary.openDebtCount > 0)
            items.push({
              tone: 'info',
              text: `${summary.openDebtCount} open customer debt${summary.openDebtCount === 1 ? '' : 's'} to collect`,
              to: '/debts',
            });
        } catch {
          // Ignored: the dashboard reports the failure with a retry.
        }
      }
      if (active) setNotifications(user ? items : []);
    };
    void load();
    return () => {
      active = false;
    };
  }, [api, user, canReadStock, canReadSales]);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const current =
    navigation.find((item) => item.path === location.pathname) ??
    navigation
      .filter((item) => item.path !== '/' && location.pathname.startsWith(`${item.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  const online = connection === 'online';
  useEffect(() => {
    document.title = `${current?.label || 'Workspace'} · MediMart`;
    window.scrollTo(0, 0);
  }, [current?.label, location.pathname]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const trigger = menuButtonRef.current;
    const prior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sidebarRef.current?.querySelector<HTMLElement>('a,button');
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = sidebarRef.current?.querySelectorAll<HTMLElement>('a,button');
      if (!items?.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.body.style.overflow = prior;
      document.removeEventListener('keydown', trap);
      trigger?.focus();
    };
  }, [menuOpen]);
  const filtered = navigation.filter((item) =>
    `${item.label} ${item.group}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      {menuOpen && (
        <button
          tabIndex={-1}
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <Link to="/settings" className="workspace-switcher" onClick={() => setMenuOpen(false)}>
          <span className="workspace-icon">
            <Store size={18} />
          </span>
          <span>
            <strong>Main workspace</strong>
            <small>{user ? 'Your business workspace' : 'Foundation preview'}</small>
          </span>
          <ChevronDown size={15} />
        </Link>
        <nav className="sidebar-nav">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-group-label">{group}</div>
              {navigation
                .filter((item) => item.group === group)
                .map((item) => {
                  const locked = user && !hasPermission(user.permissions, item.permission);
                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      className={({ isActive }) =>
                        `nav-item ${isActive ? 'active' : ''} ${locked ? 'nav-locked' : ''}`
                      }
                      onClick={() => setMenuOpen(false)}
                    >
                      <item.icon size={18} strokeWidth={1.7} />
                      <span>{item.label}</span>
                      {locked ? (
                        <LockKeyhole className="nav-end" size={12} />
                      ) : item.path === '/pos' ? (
                        <span className="nav-shortcut">POS</span>
                      ) : null}
                    </NavLink>
                  );
                })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`sidebar-connection ${online ? '' : 'disconnected'}`}>
            <span className="status-dot" />
            <span>
              {online
                ? 'Central server connected'
                : connection === 'checking'
                  ? 'Checking connection'
                  : connection === 'unconfigured'
                    ? 'Server not configured'
                    : 'Central server offline'}
            </span>
            <ShieldCheck size={14} />
          </div>
          <button className="help-button" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={18} />
            <span>Help & getting started</span>
            <ArrowRight size={14} />
          </button>
          <div className="sidebar-version">
            LOCAL FIRST. ALWAYS.<span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={menuButtonRef}
              className="icon-button mobile-only"
              aria-label="Open navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-workspace">Workspace</span>
            <ChevronRight size={14} />
            <strong>{current?.label || 'Workspace'}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="search-trigger"
              aria-label="Search workspace"
              onClick={() => {
                setSearch('');
                setSearchOpen(true);
              }}
            >
              <Search size={16} />
              <span>Search workspace...</span>
              <kbd>
                <Command size={11} /> K
              </kbd>
            </button>
            <div
              className={`topbar-status ${online ? 'is-online' : ''}`}
              title="Based on a health check of your central server"
            >
              {online ? <Wifi size={15} /> : <WifiOff size={15} />}
              <span>
                {online ? 'Connected' : connection === 'checking' ? 'Connecting' : 'Offline'}
              </span>
            </div>
            <span className="topbar-divider" />
            <button
              className="icon-button notification-button"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen(true)}
            >
              <Bell size={19} />
              {notifications.length > 0 && (
                <span className="notification-count" aria-hidden="true">
                  {notifications.length}
                </span>
              )}
              <span className="visually-hidden">
                {notifications.length === 0
                  ? 'No notifications'
                  : `${notifications.length} notifications`}
              </span>
            </button>
            <button
              className="avatar"
              aria-label="Account menu"
              onClick={() => setAccountOpen(true)}
            >
              {user
                ? user.fullName
                    .split(' ')
                    .slice(0, 2)
                    .map((word) => word[0])
                    .join('')
                    .toUpperCase()
                : 'MM'}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="page-content">
          <Outlet />
          <FoundationNote />
        </main>
      </div>
      <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="Find your workspace">
        <div className="search-field">
          <Search size={20} />
          <input
            ref={searchRef}
            aria-label="Search modules"
            placeholder="Search modules, settings, and more..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="search-results">
          {filtered.length ? (
            filtered.map((item) => (
              <button
                key={item.path}
                onClick={() => {
                  navigate(item.path);
                  setSearchOpen(false);
                }}
              >
                <span className="search-result-icon">
                  <item.icon size={20} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.group}</small>
                </span>
                {user && !hasPermission(user.permissions, item.permission) ? (
                  <LockKeyhole size={15} />
                ) : (
                  <ArrowRight size={16} />
                )}
              </button>
            ))
          ) : (
            <div className="empty-small">
              No modules match “{search}”. Try “Inventory” or “Settings”.
            </div>
          )}
        </div>
        <p className="muted small search-hint">
          Jump to any module you have access to. Press <kbd>Ctrl</kbd>
          <kbd>K</kbd> from anywhere.
        </p>
      </Modal>
      <Modal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        title="Notifications"
      >
        {notifications.length === 0 ? (
          <div className="empty-state compact">
            <div className="empty-icon">
              <ShieldCheck size={28} />
            </div>
            <h3>Nothing needs your attention</h3>
            <p>
              Expiry, low stock and outstanding debt alerts appear here automatically. When there is
              nothing to act on, this stays quiet.
            </p>
          </div>
        ) : (
          <ul className="notification-list">
            {notifications.map((item) => (
              <li key={item.text} className={`notification-${item.tone}`}>
                <button
                  onClick={() => {
                    setNotificationsOpen(false);
                    navigate(item.to);
                  }}
                >
                  <span className="notification-dot" aria-hidden="true" />
                  <span>{item.text}</span>
                  <ArrowRight size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <Modal open={accountOpen} onClose={() => setAccountOpen(false)} title="Your account">
        <div className="account-panel">
          <div className="large-avatar">{user?.fullName[0] || 'M'}</div>
          <h3>{user?.fullName || 'Welcome to MediMart'}</h3>
          <p>{user?.email || 'You’re exploring a read-only workspace preview.'}</p>
          <Badge tone={user ? 'green' : 'neutral'}>
            {user ? user.roles.join(' · ').replaceAll('_', ' ') : 'Not signed in'}
          </Badge>
          <div className="account-actions">
            {user ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void signOut()
                    .then(() => setAccountOpen(false))
                    .catch((error) => notify(errorMessage(error), 'error'));
                }}
              >
                <LogOut size={16} />
                Sign out
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setAccountOpen(false);
                  navigate('/login');
                }}
              >
                <LogIn size={16} />
                Sign in to your workspace
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setAccountOpen(false);
                navigate('/settings');
              }}
            >
              <Settings2 size={16} />
              Workspace settings
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="A good place to start">
        <div className="help-content">
          <Badge tone="green">MediMart</Badge>
          <h3>One workspace. Built around your business.</h3>
          <ol>
            <li>
              <strong>Create your owner account.</strong>
              <p>
                Use the one-time setup token generated on your central server. There are no default
                passwords.
              </p>
            </li>
            <li>
              <strong>Connect your devices.</strong>
              <p>
                Set an HTTPS server address on each Android phone, then approve its pairing code
                from Settings.
              </p>
            </li>
            <li>
              <strong>Give your team individual access.</strong>
              <p>
                Owners and authorized administrators can create staff accounts with purpose-specific
                roles.
              </p>
            </li>
          </ol>
          <div className="info-box">
            <ShieldCheck size={20} />
            <p>
              {runtime.native
                ? 'This app opens from bundled assets and initializes its own SQLite database.'
                : 'This browser uses your local central server. No public website or paid cloud service is required.'}{' '}
              Full offline sign-in and synchronization are not implemented in this phase.
            </p>
          </div>
          <Button
            onClick={() => {
              setHelpOpen(false);
              navigate('/settings');
            }}
          >
            Open workspace settings
            <ArrowRight size={16} />
          </Button>
        </div>
      </Modal>
    </div>
  );
}
