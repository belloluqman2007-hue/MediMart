import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { hasPermission, productTypeLabels, type SalesReport } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Badge, Button, PageHeading } from '../../components/ui';
import { buildQuery, formatDate, formatMoney, useAsync } from '../inventory/lib';
import { ErrorBlock, LoadingBlock } from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { api, user } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'reports.view'));

  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => isoDaysAgo(6));
  const [to, setTo] = useState(today);

  const report = useAsync(
    () =>
      allowed
        ? api.request<SalesReport>(
            `/api/reports/sales${buildQuery({
              from: from || undefined,
              to: to || undefined,
            })}`,
          )
        : Promise.resolve(null),
    [allowed, from, to],
  );

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Finance"
        title="Financial &amp; sales reports"
        description="Sales revenue, cash collected, credit balances, COGS, and gross profit."
        permission="reports.view"
      />
    );
  }

  const data = report.data;
  const f = data?.financials;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Finance"
        title="Sales &amp; financial reports"
        description="Sales revenue, cash actually received, unpaid credit, cost of goods sold, gross profit, and expenses are kept strictly separate."
        action={
          <div className="row-actions">
            <Link className="button button-primary" to="/reports/financial">
              Financial reports
            </Link>
            <Button variant="secondary" onClick={report.reload} busy={report.loading}>
              <RefreshCw size={15} /> Refresh
            </Button>
          </div>
        }
      />

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Reporting window</h2>
            <p>Select a preset or custom date range (UTC).</p>
          </div>
          <div className="pos-quick-cash">
            <button
              type="button"
              className="pos-unit-chip"
              onClick={() => {
                setFrom(today);
                setTo(today);
              }}
            >
              Today
            </button>
            <button
              type="button"
              className="pos-unit-chip"
              onClick={() => {
                setFrom(isoDaysAgo(6));
                setTo(today);
              }}
            >
              Last 7 days
            </button>
            <button
              type="button"
              className="pos-unit-chip"
              onClick={() => {
                setFrom(isoDaysAgo(29));
                setTo(today);
              }}
            >
              Last 30 days
            </button>
          </div>
        </div>
        <div className="inventory-filters">
          <label className="field-label" style={{ margin: 0 }}>
            From
            <input
              type="date"
              aria-label="Report start date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="field-label" style={{ margin: 0 }}>
            To
            <input
              type="date"
              aria-label="Report end date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
      </section>

      {report.loading && !data ? (
        <LoadingBlock label="Computing integer-kobo financial report…" />
      ) : report.error ? (
        <ErrorBlock message={report.error} onRetry={report.reload} />
      ) : data && f ? (
        <>
          {/* 6-concept strict financial separation */}
          <section
            className="financial-separation-grid"
            aria-label="Separated financial statements"
          >
            <article className="card financial-pillar">
              <span className="eyebrow">1 · Sales Revenue</span>
              <h3>{formatMoney(f.salesRevenueKobo)}</h3>
              <p>
                Net completed sales (includes paid and credit sales; never presented as profit).
              </p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Gross sales</dt>
                  <dd>{formatMoney(f.grossSalesKobo)}</dd>
                </div>
                <div>
                  <dt>Discounts given</dt>
                  <dd>−{formatMoney(f.discountsGivenKobo)}</dd>
                </div>
                <div>
                  <dt>Refunds deducted</dt>
                  <dd>−{formatMoney(f.refundsKobo)}</dd>
                </div>
                <div>
                  <dt>Voided sales (excluded)</dt>
                  <dd>{formatMoney(f.voidedSalesKobo)}</dd>
                </div>
              </dl>
            </article>

            <article className="card financial-pillar">
              <span className="eyebrow">2 · Money Actually Received</span>
              <h3>{formatMoney(f.cashActuallyReceivedKobo)}</h3>
              <p>
                Actual payments collected (checkout + debt repayments − cash refunds). Excludes
                unpaid credit.
              </p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Cash received</dt>
                  <dd>{formatMoney(f.cashMethodReceivedKobo)}</dd>
                </div>
                <div>
                  <dt>Bank transfers received</dt>
                  <dd>{formatMoney(f.bankTransferReceivedKobo)}</dd>
                </div>
                <div>
                  <dt>POS terminal received</dt>
                  <dd>{formatMoney(f.posReceivedKobo)}</dd>
                </div>
                <div>
                  <dt>Of which debt repayments</dt>
                  <dd>{formatMoney(f.debtRepaymentsReceivedKobo)}</dd>
                </div>
              </dl>
            </article>

            <article className="card financial-pillar">
              <span className="eyebrow">3 · Outstanding Credit &amp; Debts</span>
              <h3>{formatMoney(f.outstandingCreditKobo)}</h3>
              <p>Live unpaid customer balances. Never counted as cash received until repaid.</p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Credit issued in period</dt>
                  <dd>{formatMoney(f.periodCreditSalesKobo)}</dd>
                </div>
                <div>
                  <dt>Open debt records</dt>
                  <dd>{data.debtSummary.openDebtCount}</dd>
                </div>
                <div>
                  <dt>Overdue debt amount</dt>
                  <dd>{formatMoney(data.debtSummary.overdueAmountKobo)}</dd>
                </div>
              </dl>
            </article>

            <article className="card financial-pillar">
              <span className="eyebrow">4 · Cost of Goods Sold (COGS)</span>
              <h3>{formatMoney(f.costOfGoodsSoldKobo)}</h3>
              <p>Batch-level unit cost of items sold, net of restocked voids and returns.</p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Completed transactions</dt>
                  <dd>{data.completedTransactionsCount}</dd>
                </div>
                <div>
                  <dt>Voided transactions</dt>
                  <dd>{data.voidedTransactionsCount}</dd>
                </div>
                <div>
                  <dt>Refund operations</dt>
                  <dd>{data.refundCount}</dd>
                </div>
              </dl>
            </article>

            <article className="card financial-pillar">
              <span className="eyebrow">5 · Gross Profit</span>
              <h3>{formatMoney(f.grossProfitKobo)}</h3>
              <p>Net sales revenue minus cost of goods sold (before operating expenses).</p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Net sales revenue</dt>
                  <dd>{formatMoney(f.salesRevenueKobo)}</dd>
                </div>
                <div>
                  <dt>Less COGS</dt>
                  <dd>−{formatMoney(f.costOfGoodsSoldKobo)}</dd>
                </div>
              </dl>
            </article>

            <article className="card financial-pillar">
              <span className="eyebrow">6 · Operating Expenses</span>
              <h3>Not yet tracked</h3>
              <p>
                Expenses are intentionally kept separate from gross profit and will be recorded in
                the dedicated Expenses module (Phase 4).
              </p>
              <dl className="mini-breakdown">
                <div>
                  <dt>Module status</dt>
                  <dd>Phase 4 · Separate ledger</dd>
                </div>
              </dl>
            </article>
          </section>

          {/* Daily Sales Trends */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Daily sales &amp; collection trend</h2>
                <p>
                  {formatDate(data.from)} to {formatDate(data.to)}
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Transactions</th>
                    <th className="num">Net sales revenue</th>
                    <th className="num">Money received</th>
                    <th className="num">Credit issued</th>
                    <th className="num">COGS</th>
                    <th className="num">Gross profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trends.map((point) => (
                    <tr key={point.date}>
                      <td>{formatDate(point.date)}</td>
                      <td className="num">{point.transactionsCount}</td>
                      <td className="num">
                        <strong>{formatMoney(point.netSalesRevenueKobo)}</strong>
                      </td>
                      <td className="num">{formatMoney(point.moneyReceivedKobo)}</td>
                      <td className="num">{formatMoney(point.creditSalesKobo)}</td>
                      <td className="num">{formatMoney(point.cogsKobo)}</td>
                      <td className="num">{formatMoney(point.grossProfitKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Top Products */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Top products by net sales revenue</h2>
                <p>Revenue, batch COGS, and gross profit per product.</p>
              </div>
            </div>
            {data.topProducts.length === 0 ? (
              <p className="empty-small">No completed product sales in this date range.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Type</th>
                      <th className="num">Net base qty</th>
                      <th className="num">Net revenue</th>
                      <th className="num">COGS</th>
                      <th className="num">Gross profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topProducts.map((item) => (
                      <tr key={item.productId}>
                        <td>
                          <strong>{item.productName}</strong>
                        </td>
                        <td>
                          <Badge tone={item.productType === 'medicine' ? 'green' : 'neutral'}>
                            {productTypeLabels[item.productType]}
                          </Badge>
                        </td>
                        <td className="num">
                          {item.baseQuantitySold} {item.baseUnitSymbol}
                        </td>
                        <td className="num">{formatMoney(item.revenueKobo)}</td>
                        <td className="num">{formatMoney(item.cogsKobo)}</td>
                        <td className="num">
                          <strong>{formatMoney(item.grossProfitKobo)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
