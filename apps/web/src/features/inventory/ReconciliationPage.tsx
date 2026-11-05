import { Link } from 'react-router-dom';
import { CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { ReconciliationReport } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { formatDateTime, useAsync } from './lib';
import { ErrorBlock, LoadingBlock, StatusBadge } from './shared';

export function ReconciliationPage() {
  const { api } = useApp();
  const report = useAsync(
    () => api.request<ReconciliationReport>('/api/inventory/reconciliation'),
    [],
  );
  const data = report.data;
  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Stock reconciliation"
        description="Compares the cached stock balance with the movement ledger and batch quantities."
        action={
          <Button variant="secondary" onClick={report.reload} busy={report.loading}>
            <RefreshCw size={15} /> Recheck
          </Button>
        }
      />
      {report.loading && !data ? (
        <LoadingBlock label="Checking stock balances…" />
      ) : report.error ? (
        <ErrorBlock message={report.error} onRetry={report.reload} />
      ) : data ? (
        <>
          <div className="reconciliation-summary">
            <section className="card inventory-card">
              <span className="empty-icon">
                <CheckCircle2 size={24} />
              </span>
              <h3>{data.productsChecked} products checked</h3>
              <p className="muted small">Last checked {formatDateTime(data.checkedAt)}</p>
            </section>
            <section
              className={`card inventory-card ${data.inconsistentCount ? 'is-warning' : ''}`}
            >
              <span className="empty-icon">
                <ShieldAlert size={24} />
              </span>
              <h3>
                {data.inconsistentCount === 0
                  ? 'Every balance is consistent'
                  : `${data.inconsistentCount} balance${
                      data.inconsistentCount === 1 ? '' : 's'
                    } need review`}
              </h3>
              <p className="muted small">
                A mismatch means the cached balance no longer matches the append-only ledger.
              </p>
            </section>
          </div>
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Product balances</h2>
                <p>
                  Ledger total is the sum of every movement; batch total covers batch-tracked stock.
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="numeric">Cached balance</th>
                    <th className="numeric">Ledger total</th>
                    <th className="numeric">Batch total</th>
                    <th>Batch tracked</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.productId}>
                      <td>
                        <Link to={`/inventory/products/${row.productId}`}>{row.productName}</Link>
                      </td>
                      <td className="numeric">{row.balanceQuantity}</td>
                      <td className="numeric">{row.ledgerQuantity}</td>
                      <td className="numeric">{row.batchQuantity}</td>
                      <td>{row.batchTracked ? 'Yes' : 'No'}</td>
                      <td>
                        {row.consistent ? (
                          <StatusBadge tone="green">Consistent</StatusBadge>
                        ) : (
                          <StatusBadge tone="red">Needs review</StatusBadge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="inventory-note">
              Reconciliation is read-only. Nothing is silently rewritten — investigate the ledger
              history or record a documented correction through the adjust-stock screen.
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
