import { Component, type ErrorInfo, type ReactNode } from 'react';
import { HashRouter, Link, Route, Routes } from 'react-router-dom';
import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';
import type { Runtime } from './platform/types';
import { AppProvider } from './components/AppProvider';
import { AppShell } from './components/AppShell';
import { Brand, Button } from './components/ui';
import { Dashboard } from './features/Dashboard';
import { AuthPage } from './features/AuthPage';
import { PlaceholderPage } from './features/PlaceholderPage';
import { SettingsPage } from './features/SettingsPage';
import { InventoryLayout } from './features/inventory/InventoryLayout';
import { InventoryDashboard } from './features/inventory/InventoryDashboard';
import { ProductsPage } from './features/inventory/ProductsPage';
import { ProductFormPage } from './features/inventory/ProductFormPage';
import { ProductDetailPage } from './features/inventory/ProductDetailPage';
import { CategoriesPage } from './features/inventory/CategoriesPage';
import { BatchesPage } from './features/inventory/BatchesPage';
import { StockReceivePage } from './features/inventory/StockReceivePage';
import { AdjustmentsPage } from './features/inventory/AdjustmentsPage';
import { MovementsPage } from './features/inventory/MovementsPage';
import { UnitsPage } from './features/inventory/UnitsPage';
import { SuppliersPage } from './features/inventory/SuppliersPage';
import { ReconciliationPage } from './features/inventory/ReconciliationPage';
import { navigation } from './lib/navigation';
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not log component state or future patient/business data. */
  }
  render() {
    return this.state.failed ? <StartupFailure /> : this.props.children;
  }
}
export function StartupFailure({ storage = false }: { storage?: boolean }) {
  return (
    <div className="startup-failure">
      <div className="empty-icon">
        <AlertCircle size={32} />
      </div>
      <h1>{storage ? 'Local storage needs attention' : 'Let’s get you back to work'}</h1>
      <p>
        {storage
          ? 'MediMart could not initialize its secure database. To protect your data, it has not fallen back to temporary storage. Do not clear app data or uninstall the app as a workaround.'
          : 'The workspace could not be displayed. Reload the application to try again.'}
      </p>
      <Button onClick={() => window.location.reload()}>
        <RefreshCw size={16} />
        Try again
      </Button>
      {storage && (
        <p className="small muted">
          If this continues, contact your administrator. An Android runtime or migration check may
          be required.
        </p>
      )}
    </div>
  );
}
function NotFound() {
  return (
    <div className="empty-state">
      <Brand />
      <h1>This space hasn’t been built.</h1>
      <p>The page you’re looking for isn’t part of this workspace.</p>
      <Link className="button button-primary" to="/">
        <ArrowLeft size={16} />
        Back to dashboard
      </Link>
    </div>
  );
}
export function App({ runtime }: { runtime: Runtime }) {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AppProvider runtime={runtime}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route path="/register" element={<AuthPage register />} />
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="inventory" element={<InventoryLayout />}>
                <Route index element={<InventoryDashboard />} />
                <Route path="products" element={<ProductsPage />} />
                <Route path="products/new" element={<ProductFormPage />} />
                <Route path="products/:id" element={<ProductDetailPage />} />
                <Route path="products/:id/edit" element={<ProductFormPage />} />
                <Route path="categories" element={<CategoriesPage />} />
                <Route path="batches" element={<BatchesPage />} />
                <Route path="receive" element={<StockReceivePage />} />
                <Route path="adjustments" element={<AdjustmentsPage />} />
                <Route path="movements" element={<MovementsPage />} />
                <Route path="units" element={<UnitsPage />} />
                <Route path="suppliers" element={<SuppliersPage />} />
                <Route path="reconciliation" element={<ReconciliationPage />} />
              </Route>
              <Route path="suppliers" element={<SuppliersPage />} />
              {navigation
                .filter(
                  (item) => !['/', '/settings', '/inventory', '/suppliers'].includes(item.path),
                )
                .map((item) => (
                  <Route
                    key={item.path}
                    path={item.path}
                    element={<PlaceholderPage item={item} />}
                  />
                ))}
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AppProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
