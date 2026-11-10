import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote } from 'lucide-react';
import type { Paginated, SupplierPaymentKind, SupplierPaymentSummary } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, Pagination, StatusBadge } from '../inventory/shared';
import { buildQuery, formatDate, formatMoney, paymentMethodLabels, useAsync } from './lib';

export function SupplierPaymentsPage() {
  const { api } = useApp();
  const [kind, setKind] = useState<SupplierPaymentKind | ''>('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const payments = useAsync(
    () =>
      api.request<Paginated<SupplierPaymentSummary>>(
        `/api/supplier-payments${buildQuery({ kind, method, from, to, page, pageSize: 20 })}`,
      ),
    [kind, method, from, to, page],
  );
  const data = payments.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Purchasing"
        title="Supplier payments"
        description="Money actually paid to suppliers, allocated to received goods. Reversals appear as separate records."
        action={
          <Link className="button button-secondary" to="/supplier-balances">
            Supplier balances
          </Link>
        }
      />
      <div className="inventory-tabs">
        <Link className="inventory-tab" to="/purchases">
          Purchase orders
        </Link>
        <Link className="inventory-tab" to="/purchases/receipts">
          Goods received
        </Link>
        <Link className="inventory-tab active" to="/supplier-payments">
          Supplier payments
        </Link>
        <Link className="inventory-tab" to="/supplier-balances">
          Supplier balances
        </Link>
      </div>
      <section className="card inventory-card">
        <div className="inventory-filters">
          <select
            aria-label="Payment kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as SupplierPaymentKind | '');
              setPage(1);
            }}
          >
            <option value="">Payments and reversals</option>
            <option value="payment">Payments</option>
            <option value="reversal">Reversals</option>
          </select>
          <select
            aria-label="Payment method"
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any method</option>
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="pos_terminal">POS</option>
          </select>
          <label className="inline-date">
            <span className="small muted">From</span>
            <input
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
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        {payments.loading && !data ? (
          <LoadingBlock label="Loading supplier payments…" />
        ) : payments.error ? (
          <ErrorBlock message={payments.error} onRetry={payments.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<Banknote size={27} />}
            title="No supplier payments"
            message="Open a supplier account and record a payment against an outstanding invoice."
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Supplier</th>
                    <th>Kind</th>
                    <th>Method</th>
                    <th>Paid</th>
                    <th>Amount</th>
                    <th>Reference</th>
                    <th>Invoices</th>
                    <th>Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((payment) => (
                    <tr key={payment.id}>
                      <td>
                        <span className="table-primary">{payment.paymentNumber}</span>
                      </td>
                      <td>
                        <Link className="text-link" to={`/suppliers/${payment.supplierId}/account`}>
                          {payment.supplierName}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge tone={payment.paymentKind === 'reversal' ? 'red' : 'green'}>
                          {payment.paymentKind}
                        </StatusBadge>
                      </td>
                      <td>{paymentMethodLabels[payment.method]}</td>
                      <td>{formatDate(payment.paidAt)}</td>
                      <td>{formatMoney(payment.amountKobo)}</td>
                      <td>{payment.reference ?? '—'}</td>
                      <td>{payment.allocations.length}</td>
                      <td>{payment.recordedByName ?? '—'}</td>
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
        ) : null}
      </section>
    </div>
  );
}
