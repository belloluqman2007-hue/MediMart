import { useState } from 'react';
import { Download, Printer, RefreshCw } from 'lucide-react';
import {
  financialReportKinds,
  financialReportLabels,
  hasPermission,
  type FinancialExport,
  type FinancialReport,
  type FinancialReportKind,
  type FinancialReportPeriod,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, PageHeading } from '../../components/ui';
import { ErrorBlock, LoadingBlock, StatusBadge } from '../inventory/shared';
import { FinanceMetric } from './components';
import {
  buildQuery,
  downloadCsv,
  formatDate,
  formatMoney,
  paymentMethodLabels,
  rangeFor,
  useAsync,
  type RangePreset,
} from './lib';

const presets: Array<{ key: RangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'year', label: 'This year' },
];

export function FinancialReportsPage() {
  const { api, user, notify } = useApp();
  const initial = rangeFor('month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [period, setPeriod] = useState<FinancialReportPeriod>('daily');
  const [exportKind, setExportKind] = useState<FinancialReportKind>('sales');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canExport = Boolean(user && hasPermission(user.permissions, 'reports.export'));
  const report = useAsync(
    () => api.request<FinancialReport>(`/api/reports/finance${buildQuery({ from, to, period })}`),
    [from, to, period],
  );

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      const exported = await api.request<FinancialExport>(
        `/api/reports/finance/export${buildQuery({ report: exportKind, from, to, period })}`,
      );
      downloadCsv(exported.filename, exported.csv);
      notify(`Exported ${exported.rowCount} rows.`, 'success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The report could not be exported.');
    } finally {
      setBusy(false);
    }
  }

  const data = report.data;

  return (
    <div className="inventory-workspace financial-report">
      <PageHeading
        eyebrow="Finance"
        title="Financial reports"
        description="Sales, collections, purchases, payables, expenses, inventory value, COGS and profit are kept separate. Profit is not sales minus purchases."
        action={
          <div className="button-row">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer size={15} /> Print
            </Button>
            {canExport && (
              <Button onClick={() => void exportCsv()} busy={busy}>
                <Download size={15} /> Export CSV
              </Button>
            )}
            <Button variant="secondary" onClick={report.reload} busy={report.loading}>
              <RefreshCw size={15} /> Refresh
            </Button>
          </div>
        }
      />

      <section className="card inventory-card">
        <div className="filter-chips">
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="filter-chip"
              onClick={() => {
                const range = rangeFor(preset.key);
                setFrom(range.from);
                setTo(range.to);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="inventory-filters">
          <label className="inline-date">
            <span className="small muted">From</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="inline-date">
            <span className="small muted">To</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="inline-date">
            <span className="small muted">Group by</span>
            <select
              value={period}
              onChange={(event) => setPeriod(event.target.value as FinancialReportPeriod)}
            >
              <option value="daily">Day</option>
              <option value="weekly">Week</option>
              <option value="monthly">Month</option>
            </select>
          </label>
          {canExport && (
            <label className="inline-date">
              <span className="small muted">CSV report</span>
              <select
                value={exportKind}
                onChange={(event) => setExportKind(event.target.value as FinancialReportKind)}
              >
                {financialReportKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {financialReportLabels[kind]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <FormError message={error} />
      </section>

      {report.loading && !data ? (
        <LoadingBlock label="Building financial report…" />
      ) : report.error ? (
        <ErrorBlock message={report.error} onRetry={report.reload} />
      ) : data ? (
        <>
          <div className="report-meta">
            <span>
              {formatDate(data.from)} – {formatDate(data.to)}
            </span>
            <span className="muted small">
              Generated {new Date(data.generatedAt).toLocaleString('en-GB')}
            </span>
          </div>

          <section className="inventory-metrics">
            <FinanceMetric
              label="Net sales revenue"
              value={formatMoney(data.sales.netSalesRevenueKobo)}
              caption={`${data.sales.transactionsCount} sales · ${data.sales.refundCount} refunds`}
              tone="green"
            />
            <FinanceMetric
              label="Money collected"
              value={formatMoney(data.collections.totalReceivedKobo)}
              caption="Cash, transfer, POS and debt repayments"
              tone="blue"
            />
            <FinanceMetric
              label="Goods received"
              value={formatMoney(data.purchases.goodsReceivedKobo)}
              caption={`${formatMoney(data.purchases.totalOrderedKobo)} ordered`}
            />
            <FinanceMetric
              label="Supplier outstanding"
              value={formatMoney(data.purchases.outstandingSupplierBalanceKobo)}
              caption={`${data.purchases.outstandingInvoiceCount} open invoices`}
              tone="amber"
            />
            <FinanceMetric
              label="Operating expenses"
              value={formatMoney(data.expenses.netKobo)}
              caption={`${formatMoney(data.expenses.reversedKobo)} reversed`}
              tone="red"
            />
            <FinanceMetric
              label="Operating profit"
              value={formatMoney(data.profitability.operatingProfitKobo)}
              caption="Net sales − COGS − expenses"
              tone={data.profitability.operatingProfitKobo >= 0 ? 'green' : 'red'}
            />
          </section>

          <section className="card inventory-card financial-pillar">
            <div className="card-heading">
              <div>
                <h2>Profitability</h2>
                <p>COGS comes from inventory cost layers, not purchase totals.</p>
              </div>
            </div>
            <div className="detail-list">
              <div>
                <span>Net sales revenue</span>
                <strong>{formatMoney(data.profitability.netSalesRevenueKobo)}</strong>
              </div>
              <div>
                <span>Cost of goods sold</span>
                <strong>{formatMoney(data.profitability.costOfGoodsSoldKobo)}</strong>
              </div>
              <div className="grand-row">
                <span>Gross profit</span>
                <strong>{formatMoney(data.profitability.grossProfitKobo)}</strong>
              </div>
              <div>
                <span>Operating expenses</span>
                <strong>{formatMoney(data.profitability.operatingExpensesKobo)}</strong>
              </div>
              <div className="grand-row">
                <span>Operating profit</span>
                <strong>{formatMoney(data.profitability.operatingProfitKobo)}</strong>
              </div>
            </div>
          </section>

          <section className="financial-separation-grid">
            <div className="card inventory-card financial-pillar">
              <h2>Sales</h2>
              <div className="detail-list">
                <div>
                  <span>Gross sales</span>
                  <strong>{formatMoney(data.sales.grossSalesKobo)}</strong>
                </div>
                <div>
                  <span>Discounts</span>
                  <strong>{formatMoney(data.sales.discountsKobo)}</strong>
                </div>
                <div>
                  <span>Refunds</span>
                  <strong>{formatMoney(data.sales.refundsKobo)}</strong>
                </div>
                <div>
                  <span>Net revenue</span>
                  <strong>{formatMoney(data.sales.netSalesRevenueKobo)}</strong>
                </div>
                <div>
                  <span>Average sale</span>
                  <strong>{formatMoney(data.sales.averageSaleKobo)}</strong>
                </div>
              </div>
            </div>
            <div className="card inventory-card financial-pillar">
              <h2>Collections</h2>
              <div className="detail-list">
                <div>
                  <span>Cash</span>
                  <strong>{formatMoney(data.collections.cashKobo)}</strong>
                </div>
                <div>
                  <span>Bank transfer</span>
                  <strong>{formatMoney(data.collections.bankTransferKobo)}</strong>
                </div>
                <div>
                  <span>POS</span>
                  <strong>{formatMoney(data.collections.posKobo)}</strong>
                </div>
                <div>
                  <span>Debt repayments</span>
                  <strong>{formatMoney(data.collections.debtRepaymentsKobo)}</strong>
                </div>
                <div>
                  <span>Refunds paid</span>
                  <strong>{formatMoney(data.collections.refundsPaidKobo)}</strong>
                </div>
              </div>
            </div>
            <div className="card inventory-card financial-pillar">
              <h2>Purchases &amp; payables</h2>
              <div className="detail-list">
                <div>
                  <span>Ordered</span>
                  <strong>{formatMoney(data.purchases.totalOrderedKobo)}</strong>
                </div>
                <div>
                  <span>Goods received</span>
                  <strong>{formatMoney(data.purchases.goodsReceivedKobo)}</strong>
                </div>
                <div>
                  <span>Paid to suppliers</span>
                  <strong>{formatMoney(data.purchases.paidToSuppliersKobo)}</strong>
                </div>
                <div>
                  <span>Supplier reversals</span>
                  <strong>{formatMoney(data.purchases.supplierPaymentReversalsKobo)}</strong>
                </div>
                <div>
                  <span>Outstanding</span>
                  <strong>{formatMoney(data.purchases.outstandingSupplierBalanceKobo)}</strong>
                </div>
              </div>
            </div>
            <div className="card inventory-card financial-pillar">
              <h2>Expenses</h2>
              <div className="detail-list">
                <div>
                  <span>Recorded</span>
                  <strong>{formatMoney(data.expenses.recordedGrossKobo)}</strong>
                </div>
                <div>
                  <span>Reversed</span>
                  <strong>{formatMoney(data.expenses.reversedKobo)}</strong>
                </div>
                <div>
                  <span>Net expenses</span>
                  <strong>{formatMoney(data.expenses.netKobo)}</strong>
                </div>
              </div>
              {data.expenses.byCategory.map((category) => (
                <div className="expense-mini-row" key={category.categoryId}>
                  <span>{category.categoryName}</span>
                  <strong>{formatMoney(category.amountKobo)}</strong>
                </div>
              ))}
            </div>
            <div className="card inventory-card financial-pillar">
              <h2>Inventory</h2>
              <div className="detail-list">
                <div>
                  <span>Stock at cost</span>
                  <strong>{formatMoney(data.inventory.stockValueCostKobo)}</strong>
                </div>
                <div>
                  <span>Stock at retail</span>
                  <strong>{formatMoney(data.inventory.stockValueRetailKobo)}</strong>
                </div>
                <div>
                  <span>Units on hand</span>
                  <strong>{data.inventory.stockUnits.toLocaleString()}</strong>
                </div>
                <div>
                  <span>COGS in period</span>
                  <strong>{formatMoney(data.inventory.costOfGoodsSoldKobo)}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Sales trend</h2>
                <p>{period} buckets with actual money received and COGS.</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Sales</th>
                    <th>Gross</th>
                    <th>Discounts</th>
                    <th>Refunds</th>
                    <th>Net revenue</th>
                    <th>Money received</th>
                    <th>COGS</th>
                    <th>Gross profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.salesTrend.map((row) => (
                    <tr key={row.period}>
                      <td>{row.label}</td>
                      <td>{row.transactionsCount}</td>
                      <td>{formatMoney(row.grossSalesKobo)}</td>
                      <td>{formatMoney(row.discountsKobo)}</td>
                      <td>{formatMoney(row.refundsKobo)}</td>
                      <td>{formatMoney(row.netSalesRevenueKobo)}</td>
                      <td>{formatMoney(row.moneyReceivedKobo)}</td>
                      <td>{formatMoney(row.costOfGoodsSoldKobo)}</td>
                      <td>{formatMoney(row.grossProfitKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Purchase orders in period</h2>
                <p>Ordered value, received value and supplier payments are distinct columns.</p>
              </div>
            </div>
            {data.purchaseRows.length === 0 ? (
              <p className="muted">No purchase orders in this period.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Date</th>
                      <th>Supplier</th>
                      <th>Status</th>
                      <th>Total</th>
                      <th>Received</th>
                      <th>Paid</th>
                      <th>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.purchaseRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.referenceNumber}</td>
                        <td>{formatDate(row.orderDate)}</td>
                        <td>{row.supplierName}</td>
                        <td>{row.status.replaceAll('_', ' ')}</td>
                        <td>{formatMoney(row.totalKobo)}</td>
                        <td>{formatMoney(row.receivedValueKobo)}</td>
                        <td>{formatMoney(row.paidKobo)}</td>
                        <td>{formatMoney(row.outstandingKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Supplier payments in period</h2>
                <p>Recorded payments and reversals.</p>
              </div>
            </div>
            {data.supplierPaymentRows.length === 0 ? (
              <p className="muted">No supplier payments in this period.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>Supplier</th>
                      <th>Kind</th>
                      <th>Method</th>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.supplierPaymentRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.paymentNumber}</td>
                        <td>{row.supplierName}</td>
                        <td>
                          <StatusBadge tone={row.paymentKind === 'reversal' ? 'red' : 'green'}>
                            {row.paymentKind}
                          </StatusBadge>
                        </td>
                        <td>{paymentMethodLabels[row.method]}</td>
                        <td>{formatDate(row.paidAt)}</td>
                        <td>{formatMoney(row.amountKobo)}</td>
                        <td>{row.reference ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Outstanding supplier balances</h2>
                <p>Live balances, independent of the selected period.</p>
              </div>
            </div>
            {data.supplierBalances.length === 0 ? (
              <p className="muted">No outstanding supplier balances.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Goods received</th>
                      <th>Net paid</th>
                      <th>Outstanding</th>
                      <th>Open invoices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.supplierBalances.map((row) => (
                      <tr key={row.supplierId}>
                        <td>{row.supplierName}</td>
                        <td>{formatMoney(row.totalGoodsReceivedKobo)}</td>
                        <td>{formatMoney(row.netPaidKobo)}</td>
                        <td>{formatMoney(row.outstandingBalanceKobo)}</td>
                        <td>{row.outstandingInvoiceCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Expenses</h2>
                <p>Recorded and reversed operating costs in the period.</p>
              </div>
            </div>
            {data.expenseRows.length === 0 ? (
              <p className="muted">No expenses in this period.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Date</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th>Method</th>
                      <th>Status</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.expenseRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.expenseNumber}</td>
                        <td>{formatDate(row.expenseDate)}</td>
                        <td>{row.categoryName}</td>
                        <td>{row.description}</td>
                        <td>{paymentMethodLabels[row.paymentMethod]}</td>
                        <td>
                          <StatusBadge
                            tone={
                              row.status === 'recorded'
                                ? 'green'
                                : row.status === 'reversed'
                                  ? 'red'
                                  : 'neutral'
                            }
                          >
                            {row.status}
                          </StatusBadge>
                        </td>
                        <td>{formatMoney(row.amountKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Inventory valuation</h2>
                <p>Batch cost layers where present, product cost otherwise.</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Unit</th>
                    <th>Quantity</th>
                    <th>At cost</th>
                    <th>At retail</th>
                    <th>Batch tracked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inventoryValuation.rows.map((row) => (
                    <tr key={row.productId}>
                      <td>{row.productName}</td>
                      <td>{row.baseUnitSymbol}</td>
                      <td>{row.stockQuantity}</td>
                      <td>{formatMoney(row.costValueKobo)}</td>
                      <td>{formatMoney(row.retailValueKobo)}</td>
                      <td>{row.batchTracked ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.inventoryValuation.rows.length === 0 && (
              <p className="muted">No stock on hand.</p>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Cost of goods sold</h2>
                <p>Net of refunds, by product.</p>
              </div>
            </div>
            {data.cogsRows.length === 0 ? (
              <p className="muted">No sales in this period.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Unit</th>
                      <th>Quantity sold</th>
                      <th>Revenue</th>
                      <th>COGS</th>
                      <th>Gross profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cogsRows.map((row) => (
                      <tr key={row.productId}>
                        <td>{row.productName}</td>
                        <td>{row.baseUnitSymbol}</td>
                        <td>{row.baseQuantitySold}</td>
                        <td>{formatMoney(row.revenueKobo)}</td>
                        <td>{formatMoney(row.cogsKobo)}</td>
                        <td>{formatMoney(row.grossProfitKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Cash movement</h2>
                <p>Actual money in and out, including supplier payments and expenses.</p>
              </div>
            </div>
            <p className="inventory-note small">{data.cashMovement.note}</p>
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
                  {data.cashMovement.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDate(row.date)}</td>
                      <td>{row.type.replaceAll('_', ' ')}</td>
                      <td>{paymentMethodLabels[row.method]}</td>
                      <td className={row.direction === 'in' ? 'text-green' : 'text-red'}>
                        {row.direction}
                      </td>
                      <td>{formatMoney(row.amountKobo)}</td>
                      <td>{row.reference ?? row.entityReference}</td>
                      <td>{row.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.cashMovement.rows.length === 0 && (
              <p className="muted">No cash movement in this period.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
