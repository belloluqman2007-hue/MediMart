import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import type { Paginated, SupplierBalanceRow } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, Pagination, SearchField } from '../inventory/shared';
import { buildQuery, formatDate, formatMoney, useAsync } from './lib';

export function SupplierBalancesPage() {
  const { api } = useApp();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [outstandingOnly, setOutstandingOnly] = useState(true);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const balances = useAsync(
    () =>
      api.request<Paginated<SupplierBalanceRow>>(
        `/api/supplier-balances${buildQuery({
          search: debounced,
          outstandingOnly: outstandingOnly ? 'true' : undefined,
          page,
          pageSize: 20,
        })}`,
      ),
    [debounced, outstandingOnly, page],
  );
  const data = balances.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Purchasing"
        title="Supplier balances"
        description="What is still owed after goods received and recorded payments. Ordered but undelivered stock is never a payable."
        action={
          <Link className="button button-secondary" to="/supplier-payments">
            Supplier payments
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
        <Link className="inventory-tab" to="/supplier-payments">
          Supplier payments
        </Link>
        <Link className="inventory-tab active" to="/supplier-balances">
          Supplier balances
        </Link>
      </div>
      <section className="card inventory-card">
        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search supplier, contact or phone…"
            label="Search supplier balances"
          />
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={outstandingOnly}
              onChange={(event) => {
                setOutstandingOnly(event.target.checked);
                setPage(1);
              }}
            />
            Only suppliers with a balance
          </label>
        </div>
        {balances.loading && !data ? (
          <LoadingBlock label="Loading supplier balances…" />
        ) : balances.error ? (
          <ErrorBlock message={balances.error} onRetry={balances.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<Scale size={27} />}
            title="No outstanding supplier balances"
            message="Every received delivery has been paid, or nothing has been received yet."
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Contact</th>
                    <th>Goods received</th>
                    <th>Net paid</th>
                    <th>Outstanding</th>
                    <th>Open invoices</th>
                    <th>Last delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <tr key={row.supplierId}>
                      <td>
                        <Link className="table-primary" to={`/suppliers/${row.supplierId}/account`}>
                          {row.supplierName}
                        </Link>
                      </td>
                      <td>
                        {row.contactPerson ?? '—'}
                        {row.phone && <small className="muted">{row.phone}</small>}
                      </td>
                      <td>{formatMoney(row.totalGoodsReceivedKobo)}</td>
                      <td>{formatMoney(row.netPaidKobo)}</td>
                      <td className={row.outstandingBalanceKobo > 0 ? 'text-amber' : ''}>
                        {formatMoney(row.outstandingBalanceKobo)}
                      </td>
                      <td>{row.outstandingInvoiceCount}</td>
                      <td>{formatDate(row.lastReceiptDate)}</td>
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
