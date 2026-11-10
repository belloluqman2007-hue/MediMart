import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, History, Printer, RefreshCw, ShoppingBag } from 'lucide-react';
import {
  hasPermission,
  paymentMethodLabels,
  paymentMethods,
  salePaymentStatuses,
  salePaymentStatusLabels,
  saleStatuses,
  saleStatusLabels,
  type PaginatedSales,
  type PaymentMethod,
  type SalePaymentStatus,
  type SaleStatus,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { buildQuery, formatDateTime, formatMoney, useAsync } from '../inventory/lib';
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  SearchField,
  StatusBadge,
} from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

export function SalesHistoryPage() {
  const { api, user } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const canCreate = Boolean(user && hasPermission(user.permissions, 'sales.create'));

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [paymentStatus, setPaymentStatus] = useState<SalePaymentStatus | ''>('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const sales = useAsync(
    () =>
      allowed
        ? api.request<PaginatedSales>(
            `/api/sales${buildQuery({
              search: debounced || undefined,
              status: status || undefined,
              paymentStatus: paymentStatus || undefined,
              method: method || undefined,
              from: from || undefined,
              to: to || undefined,
              page,
              pageSize: 20,
            })}`,
          )
        : Promise.resolve(null),
    [allowed, debounced, status, paymentStatus, method, from, to, page],
  );

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Sales"
        title="Sales history"
        description="Search completed receipts, payment breakdowns, voids, and refunds."
        permission="sales.view"
      />
    );
  }

  const data = sales.data;

  return (
    <>
      <PageHeading
        eyebrow="Sales management"
        title="Sales history"
        description="Completed sales are permanent audit records. Voids and refunds are recorded as explicit reversals."
        action={
          <>
            <Button variant="secondary" onClick={sales.reload} busy={sales.loading}>
              <RefreshCw size={15} /> Refresh
            </Button>
            {canCreate && (
              <Link to="/pos" className="button button-primary">
                <ShoppingBag size={15} /> New POS sale
              </Link>
            )}
          </>
        }
      />

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Receipts &amp; transactions</h2>
            <p>Filter by receipt number, customer, date range, payment method, or status.</p>
          </div>
        </div>

        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Receipt # (MM-...), customer name, or phone…"
            label="Search sales history"
          />
          <select
            aria-label="Filter by sale status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as SaleStatus | '');
              setPage(1);
            }}
          >
            <option value="">All sale statuses</option>
            {saleStatuses.map((s) => (
              <option key={s} value={s}>
                {saleStatusLabels[s]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by payment status"
            value={paymentStatus}
            onChange={(event) => {
              setPaymentStatus(event.target.value as SalePaymentStatus | '');
              setPage(1);
            }}
          >
            <option value="">All payment statuses</option>
            {salePaymentStatuses.map((ps) => (
              <option key={ps} value={ps}>
                {salePaymentStatusLabels[ps]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by payment method"
            value={method}
            onChange={(event) => {
              setMethod(event.target.value as PaymentMethod | '');
              setPage(1);
            }}
          >
            <option value="">All payment methods</option>
            {paymentMethods.map((pm) => (
              <option key={pm} value={pm}>
                {paymentMethodLabels[pm]}
              </option>
            ))}
          </select>
          <input
            type="date"
            aria-label="From date"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
          <input
            type="date"
            aria-label="To date"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {sales.loading && !data ? (
          <LoadingBlock label="Loading sales history…" />
        ) : sales.error ? (
          <ErrorBlock message={sales.error} onRetry={sales.reload} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<History size={24} />}
            title="No sales recorded yet"
            message="Sales completed at the POS terminal will appear here with permanent receipt numbers."
            action={
              canCreate ? (
                <Link to="/pos" className="button button-primary">
                  Open POS terminal
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Receipt #</th>
                    <th>Date &amp; time</th>
                    <th>Customer</th>
                    <th className="num">Items</th>
                    <th className="num">Sale total</th>
                    <th className="num">Paid</th>
                    <th className="num">Credit owed</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((sale) => (
                    <tr key={sale.id}>
                      <td>
                        <Link to={`/pos/sales/${sale.id}`} className="row-link">
                          <strong>{sale.receiptNumber}</strong>
                        </Link>
                      </td>
                      <td>{formatDateTime(sale.createdAt)}</td>
                      <td>
                        {sale.customerId ? (
                          <Link to={`/customers/${sale.customerId}`} className="row-link">
                            {sale.customerName}
                          </Link>
                        ) : (
                          sale.customerName
                        )}
                      </td>
                      <td className="num">{sale.itemCount}</td>
                      <td className="num">
                        <strong>{formatMoney(sale.totalKobo)}</strong>
                      </td>
                      <td className="num">{formatMoney(sale.amountPaidKobo)}</td>
                      <td className="num">
                        {sale.currentOutstandingKobo > 0
                          ? formatMoney(sale.currentOutstandingKobo)
                          : '—'}
                      </td>
                      <td>
                        <StatusBadge
                          tone={
                            sale.paymentStatus === 'paid'
                              ? 'green'
                              : sale.paymentStatus === 'partial' || sale.paymentStatus === 'credit'
                                ? 'amber'
                                : 'neutral'
                          }
                        >
                          {salePaymentStatusLabels[sale.paymentStatus]}
                        </StatusBadge>
                      </td>
                      <td>
                        <StatusBadge
                          tone={
                            sale.status === 'completed'
                              ? 'green'
                              : sale.status === 'partially_refunded'
                                ? 'amber'
                                : 'red'
                          }
                        >
                          {saleStatusLabels[sale.status]}
                        </StatusBadge>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Link
                            to={`/pos/sales/${sale.id}`}
                            className="icon-button"
                            aria-label={`View sale ${sale.receiptNumber}`}
                            title="Sale details"
                          >
                            <Eye size={15} />
                          </Link>
                          <Link
                            to={`/pos/receipts/${sale.id}`}
                            className="icon-button"
                            aria-label={`Print receipt ${sale.receiptNumber}`}
                            title="View & print receipt"
                          >
                            <Printer size={15} />
                          </Link>
                        </div>
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
          </>
        )}
      </section>
    </>
  );
}
