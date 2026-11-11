import { HealthcarePage } from './features/Healthcare';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { HashRouter, Link, Route, Routes } from 'react-router-dom';
import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';
import type { Runtime } from './platform/types';
import type { StartupFailureInfo } from './platform/diagnostics';
import { AppProvider } from './components/AppProvider';
import { AppShell } from './components/AppShell';
import { Brand, Button } from './components/ui';
import { Dashboard } from './features/Dashboard';
import { AuthPage } from './features/AuthPage';
import { PlaceholderPage } from './features/PlaceholderPage';
import { BackupSyncPage } from './features/BackupSyncPage';
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
import { PosLayout } from './features/sales/PosLayout';
import { PosTerminalPage } from './features/sales/PosTerminalPage';
import { SalesHistoryPage } from './features/sales/SalesHistoryPage';
import { SaleDetailPage } from './features/sales/SaleDetailPage';
import { ReceiptPage } from './features/sales/ReceiptView';
import { CustomersPage } from './features/sales/CustomersPage';
import { CustomerDetailPage } from './features/sales/CustomerDetailPage';
import { DebtsPage } from './features/sales/DebtsPage';
import { ReportsPage } from './features/sales/ReportsPage';
import { PurchasesPage } from './features/finance/PurchasesPage';
import { PurchaseFormPage } from './features/finance/PurchaseFormPage';
import { PurchaseDetailPage } from './features/finance/PurchaseDetailPage';
import { ReceiveGoodsPage } from './features/finance/ReceiveGoodsPage';
import { GoodsReceiptsPage } from './features/finance/GoodsReceiptsPage';
import { SupplierAccountPage } from './features/finance/SupplierAccountPage';
import { SupplierPaymentsPage } from './features/finance/SupplierPaymentsPage';
import { SupplierBalancesPage } from './features/finance/SupplierBalancesPage';
import { ExpensesPage } from './features/finance/ExpensesPage';
import { CashRegisterPage } from './features/finance/CashRegisterPage';
import { FinancialReportsPage } from './features/finance/FinancialReportsPage';
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
/**
 * First screen when startup cannot continue.
 *
 * `storage` failures come from the platform layer and carry a stable diagnostic code (for example
 * `database:keystore-key-unusable`). The code is shown because a shop owner reporting "the database
 * failed" cannot be helped, while the code names the cause without exposing any key or data. Nothing
 * here offers to delete, reset or re-create anything: the database and its key are the only copy.
 */
export function StartupFailure({
  storage = false,
  info,
}: {
  storage?: boolean;
  info?: StartupFailureInfo;
}) {
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
      {storage && info && (
        <p className="small muted">
          Diagnostic code: <code>{info.code}</code>
        </p>
      )}
      {storage && (
        <p className="small muted">
          If this continues, contact your administrator and give them the diagnostic code above. The
          application has not deleted, reset or replaced your database, and it has not stored
          anything unencrypted.
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
                <Route path="suppliers/:id/account" element={<SupplierAccountPage />} />
                <Route path="purchases" element={<PurchasesPage />} />
                <Route path="purchases/new" element={<PurchaseFormPage />} />
                <Route path="purchases/receipts" element={<GoodsReceiptsPage />} />
                <Route path="purchases/:id" element={<PurchaseDetailPage />} />
                <Route path="purchases/:id/edit" element={<PurchaseFormPage />} />
                <Route path="purchases/:id/receive" element={<ReceiveGoodsPage />} />
                <Route path="supplier-payments" element={<SupplierPaymentsPage />} />
                <Route path="supplier-balances" element={<SupplierBalancesPage />} />
                <Route path="expenses" element={<ExpensesPage />} />
                <Route path="cash-register" element={<CashRegisterPage />} />
                <Route path="reports/financial" element={<FinancialReportsPage />} />
                <Route path="reconciliation" element={<ReconciliationPage />} />
              </Route>
              <Route path="suppliers" element={<SuppliersPage />} />
              <Route path="suppliers/:id/account" element={<SupplierAccountPage />} />
              <Route path="purchases" element={<PurchasesPage />} />
              <Route path="purchases/new" element={<PurchaseFormPage />} />
              <Route path="purchases/receipts" element={<GoodsReceiptsPage />} />
              <Route path="purchases/:id" element={<PurchaseDetailPage />} />
              <Route path="purchases/:id/edit" element={<PurchaseFormPage />} />
              <Route path="purchases/:id/receive" element={<ReceiveGoodsPage />} />
              <Route path="supplier-payments" element={<SupplierPaymentsPage />} />
              <Route path="supplier-balances" element={<SupplierBalancesPage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="cash-register" element={<CashRegisterPage />} />
              <Route path="reports/financial" element={<FinancialReportsPage />} />
              <Route path="pos" element={<PosLayout />}>
                <Route index element={<PosTerminalPage />} />
                <Route path="sales" element={<SalesHistoryPage />} />
                <Route path="sales/:id" element={<SaleDetailPage />} />
                <Route path="receipts/:id" element={<ReceiptPage />} />
              </Route>
              <Route path="customers" element={<CustomersPage />} />
              <Route path="customers/:id" element={<CustomerDetailPage />} />
              <Route path="debts" element={<DebtsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="backup-sync" element={<BackupSyncPage />} />
              {[
                'patients',
                'patients/new',
                'patients/:id',
                'patients/:id/edit',
                'consultations',
                'consultations/new',
                'prescriptions',
                'prescriptions/new',
                'prescriptions/:id',
                'dispensing',
                'patient-reports',
              ].map((path) => (
                <Route key={path} path={path} element={<HealthcarePage key={path} />} />
              ))}
              {navigation
                .filter(
                  (item) =>
                    ![
                      '/',
                      '/settings',
                      '/backup-sync',
                      '/inventory',
                      '/suppliers',
                      '/pos',
                      '/customers',
                      '/debts',
                      '/reports',
                      '/purchases',
                      '/expenses',
                      '/cash-register',
                      '/patients',
                      '/consultations',
                      '/prescriptions',
                      '/dispensing',
                      '/patient-reports',
                      '/backup-sync',
                    ].includes(item.path),
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
