import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import type { CashRegisterSummary } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { PageHeading } from '../../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock } from '../inventory/shared';
import { FinanceMetric } from './components';
import {
  buildQuery,
  formatDate,
  formatMoney,
  paymentMethodLabels,
  rangeFor,
  useAsync,
} from './lib';

export function CashRegisterPage() {
  const { api, user } = useApp();
  const initial = rangeFor('today');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const allowed = Boolean(user && user.permissions.includes('cash_register.view'));
  const register = useAsync(
    () =>
      allowed
        ? api.request<CashRegisterSummary>(`/api/cash-register${buildQuery({ from, to })}`)
        : Promise.resolve(null),
    [allowed, from, to],
  );
  const data = register.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Finance"
        title="Cash register"
        description="Sales-side money movement for the register. Credit sales are not cash, and this is movement rather than an opening-balance reconciliation."
        action={
          <Link className="button button-secondary" to="/reports/financial">
            Financial reports
          </Link>
        }
      />
      {!allowed ? (
        <ErrorBlock message="You do not have permission to view the cash register." />
      ) : (
        <>
          <section className="card inventory-card">
            <div className="inventory-filters">
              <label className="inline-date">
                <span className="small muted">From</span>
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label className="inline-date">
                <span className="small muted">To</span>
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
            </div>
            {register.loading && !data ? (
              <LoadingBlock label="Loading cash register…" />
            ) : register.error ? (
              <ErrorBlock message={register.error} onRetry={register.reload} />
            ) : data ? (
              <>
                <div className="inventory-metrics">
                  <FinanceMetric
                    label="Cash received"
                    value={formatMoney(data.inflowKobo)}
                    tone="green"
                  />
                  <FinanceMetric
                    label="Cash paid out"
                    value={formatMoney(data.outflowKobo)}
                    tone="red"
                  />
                  <FinanceMetric
                    label="Net movement"
                    value={formatMoney(data.netKobo)}
                    tone={data.netKobo >= 0 ? 'green' : 'red'}
                  />
                  <FinanceMetric
                    label="Drawer cash movement"
                    value={formatMoney(data.cashNetKobo)}
                    caption="Cash and change only"
                    tone="amber"
                  />
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>In</th>
                        <th>Out</th>
                        <th>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byMethod.map((row) => (
                        <tr key={row.method}>
                          <td>{paymentMethodLabels[row.method]}</td>
                          <td>{formatMoney(row.inflowKobo)}</td>
                          <td>{formatMoney(row.outflowKobo)}</td>
                          <td>{formatMoney(row.netKobo)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="inventory-note small">{data.note}</p>
              </>
            ) : null}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Movement history</h2>
                <p>Sale payments, refunds paid and debt repayments.</p>
              </div>
            </div>
            {data && data.rows.length === 0 ? (
              <EmptyState
                icon={<Wallet size={27} />}
                title="No cash movement"
                message="No sales-side money movement was recorded in this date range."
              />
            ) : data ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Method</th>
                      <th>Direction</th>
                      <th>Amount</th>
                      <th>Reference</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{formatDate(row.date)}</td>
                        <td>{row.type.replaceAll('_', ' ')}</td>
                        <td>{paymentMethodLabels[row.method]}</td>
                        <td className={row.direction === 'in' ? 'text-green' : 'text-red'}>
                          {row.direction === 'in' ? 'In' : 'Out'}
                        </td>
                        <td>{formatMoney(row.amountKobo)}</td>
                        <td>{row.reference ?? row.entityReference}</td>
                        <td>{row.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
