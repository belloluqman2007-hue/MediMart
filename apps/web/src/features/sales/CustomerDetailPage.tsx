import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { HandCoins, RefreshCw } from 'lucide-react';
import {
  debtStatusLabels,
  hasPermission,
  paymentMethodLabels,
  paymentMethods,
  salePaymentStatusLabels,
  saleStatusLabels,
  type CustomerDetail,
  type CustomerRepaymentResult,
  type PaymentMethod,
} from '@medimart/shared';
import { errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  useAsync,
} from '../inventory/lib';
import { BackLink, ErrorBlock, Field, LoadingBlock, StatusBadge } from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api, user, notify } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'customers.view'));
  const canRepay = Boolean(user && hasPermission(user.permissions, 'debts.repay'));

  const state = useAsync(
    () =>
      allowed && id ? api.request<CustomerDetail>(`/api/customers/${id}`) : Promise.resolve(null),
    [allowed, id],
  );

  // Repayment modal
  const [repayOpen, setRepayOpen] = useState(false);
  const [settleAll, setSettleAll] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [repayError, setRepayError] = useState<string | null>(null);
  const repayOpRef = useRef<string | null>(null);

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Customers"
        title="Customer profile"
        description="Purchase history, credit balance, and debt repayment ledger."
        permission="customers.view"
      />
    );
  }

  const cust = state.data;

  function openRepaymentModal(detail: CustomerDetail, full: boolean) {
    setSettleAll(full);
    setAmountInput(koboToNairaInput(detail.outstandingBalanceKobo));
    setMethod('cash');
    setReference('');
    setNotes('');
    setRepayError(null);
    repayOpRef.current = crypto.randomUUID();
    setRepayOpen(true);
  }

  async function submitRepayment(event: FormEvent) {
    event.preventDefault();
    if (!cust) return;
    setRepayError(null);
    const amountKobo = settleAll ? undefined : nairaToKobo(amountInput);
    if (!settleAll && (amountKobo === null || amountKobo === undefined || amountKobo <= 0)) {
      setRepayError('Enter a valid repayment amount greater than zero.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.request<CustomerRepaymentResult>(
        `/api/customers/${cust.id}/repayments`,
        'POST',
        {
          operationId: repayOpRef.current ?? crypto.randomUUID(),
          settleAll,
          ...(settleAll ? {} : { amountKobo }),
          method,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
        },
      );
      setRepayOpen(false);
      state.reload();
      notify(
        `Recorded ${formatMoney(result.totalAppliedKobo)} debt repayment for ${cust.fullName}.`,
        'success',
      );
    } catch (caught) {
      setRepayError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inventory-workspace">
      <BackLink to="/customers">Back to customers</BackLink>
      <PageHeading
        eyebrow={cust ? cust.code : 'Customer'}
        title={cust ? cust.fullName : 'Customer profile'}
        description="Complete purchase history, credit obligations, and auditable debt repayments."
        action={
          cust && (
            <>
              <Button variant="secondary" onClick={state.reload} busy={state.loading}>
                <RefreshCw size={15} /> Refresh
              </Button>
              {canRepay && cust.outstandingBalanceKobo > 0 && (
                <>
                  <Button variant="secondary" onClick={() => openRepaymentModal(cust, false)}>
                    <HandCoins size={15} /> Part repayment
                  </Button>
                  <Button onClick={() => openRepaymentModal(cust, true)}>
                    <HandCoins size={15} /> Settle full debt (
                    {formatMoney(cust.outstandingBalanceKobo)})
                  </Button>
                </>
              )}
            </>
          )
        }
      />

      {state.loading && !cust ? (
        <LoadingBlock label="Loading customer profile…" />
      ) : state.error ? (
        <ErrorBlock message={state.error} onRetry={state.reload} />
      ) : cust ? (
        <>
          <section className="inventory-metrics">
            <div className="inventory-metric">
              <span className="muted small">Total purchases</span>
              <div className="metric-value">{formatMoney(cust.totalPurchasesKobo)}</div>
              <small className="muted">{cust.salesCount} completed receipts</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Total credit issued</span>
              <div className="metric-value">{formatMoney(cust.totalCreditKobo)}</div>
              <small className="muted">Lifetime credit across sales</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Total debt repaid</span>
              <div className="metric-value">{formatMoney(cust.totalRepaidKobo)}</div>
              <small className="muted">Collected against credit</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Current outstanding debt</span>
              <div className="metric-value">{formatMoney(cust.outstandingBalanceKobo)}</div>
              <small className="muted">
                {cust.openDebtCount} open debt{cust.openDebtCount === 1 ? '' : 's'}
                {cust.creditLimitKobo !== null
                  ? ` · Limit ${formatMoney(cust.creditLimitKobo)}`
                  : ''}
              </small>
            </div>
          </section>

          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Contact &amp; account details</h2>
                <p>Registered customer profile.</p>
              </div>
              <StatusBadge tone={cust.status === 'active' ? 'green' : 'neutral'}>
                {cust.status === 'active' ? 'Active' : 'Inactive'}
              </StatusBadge>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Customer code</dt>
                <dd>{cust.code}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{cust.phone ?? '—'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{cust.email ?? '—'}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>{cust.address ?? '—'}</dd>
              </div>
              {cust.notes && (
                <div>
                  <dt>Notes</dt>
                  <dd>{cust.notes}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Debts Table */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Credit &amp; debt records</h2>
                <p>Each credit or part-paid sale creates a tracked debt obligation.</p>
              </div>
            </div>
            {cust.debts.length === 0 ? (
              <p className="empty-small">No credit debts recorded for this customer.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Sale receipt</th>
                      <th>Date</th>
                      <th>Due date</th>
                      <th className="num">Original credit</th>
                      <th className="num">Paid</th>
                      <th className="num">Cancelled</th>
                      <th className="num">Outstanding</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cust.debts.map((debt) => (
                      <tr key={debt.id}>
                        <td>
                          <Link to={`/pos/sales/${debt.saleId}`} className="row-link">
                            <strong>{debt.saleReceiptNumber}</strong>
                          </Link>
                        </td>
                        <td>{formatDateTime(debt.createdAt)}</td>
                        <td>
                          {formatDate(debt.dueDate)}
                          {debt.isOverdue && (
                            <>
                              {' '}
                              <StatusBadge tone="red">Overdue</StatusBadge>
                            </>
                          )}
                        </td>
                        <td className="num">{formatMoney(debt.originalAmountKobo)}</td>
                        <td className="num">{formatMoney(debt.amountPaidKobo)}</td>
                        <td className="num">{formatMoney(debt.amountCancelledKobo)}</td>
                        <td className="num">
                          <strong>{formatMoney(debt.outstandingKobo)}</strong>
                        </td>
                        <td>
                          <StatusBadge
                            tone={
                              debt.status === 'settled'
                                ? 'green'
                                : debt.status === 'cancelled'
                                  ? 'neutral'
                                  : 'amber'
                            }
                          >
                            {debtStatusLabels[debt.status]}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Debt Repayment History */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Debt repayment history</h2>
                <p>Append-only ledger of repayments received from {cust.fullName}.</p>
              </div>
            </div>
            {cust.repayments.length === 0 ? (
              <p className="empty-small">No debt repayments recorded yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Repayment #</th>
                      <th>Sale receipt</th>
                      <th>Method</th>
                      <th>Reference</th>
                      <th className="num">Amount paid</th>
                      <th className="num">Balance after</th>
                      <th>Recorded by</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cust.repayments.map((rep) => (
                      <tr key={rep.id}>
                        <td>
                          <strong>{rep.receiptNumber}</strong>
                        </td>
                        <td>{rep.saleReceiptNumber}</td>
                        <td>{paymentMethodLabels[rep.method]}</td>
                        <td>{rep.reference ?? '—'}</td>
                        <td className="num">
                          <strong>{formatMoney(rep.amountKobo)}</strong>
                        </td>
                        <td className="num">{formatMoney(rep.balanceAfterKobo)}</td>
                        <td>{rep.recordedByName ?? rep.recordedBy}</td>
                        <td>{formatDateTime(rep.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent Sales */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Transaction history</h2>
                <p>Recent receipts linked to {cust.fullName}.</p>
              </div>
            </div>
            {cust.recentSales.length === 0 ? (
              <p className="empty-small">No sales recorded yet for this customer.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Receipt #</th>
                      <th>Date</th>
                      <th className="num">Total</th>
                      <th className="num">Paid</th>
                      <th className="num">Outstanding</th>
                      <th>Payment</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cust.recentSales.map((sale) => (
                      <tr key={sale.id}>
                        <td>
                          <Link to={`/pos/sales/${sale.id}`} className="row-link">
                            <strong>{sale.receiptNumber}</strong>
                          </Link>
                        </td>
                        <td>{formatDateTime(sale.createdAt)}</td>
                        <td className="num">{formatMoney(sale.totalKobo)}</td>
                        <td className="num">{formatMoney(sale.amountPaidKobo)}</td>
                        <td className="num">{formatMoney(sale.currentOutstandingKobo)}</td>
                        <td>
                          <StatusBadge tone={sale.paymentStatus === 'paid' ? 'green' : 'amber'}>
                            {salePaymentStatusLabels[sale.paymentStatus]}
                          </StatusBadge>
                        </td>
                        <td>{saleStatusLabels[sale.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Customer Repayment Modal */}
          <Modal
            open={repayOpen}
            onClose={() => setRepayOpen(false)}
            title={`Record debt repayment · ${cust.fullName}`}
          >
            <form onSubmit={(event) => void submitRepayment(event)} className="modal-form">
              <p className="confirm-message">
                Current unpaid balance: <strong>{formatMoney(cust.outstandingBalanceKobo)}</strong>.
                Repayments are applied oldest-debt-first (FIFO) and recorded in cash/money received
                at the time of repayment.
              </p>
              <FormError message={repayError} />
              <label className="checkbox-inline" style={{ margin: '8px 0' }}>
                <input
                  type="checkbox"
                  checked={settleAll}
                  onChange={(event) => {
                    setSettleAll(event.target.checked);
                    if (event.target.checked) {
                      setAmountInput(koboToNairaInput(cust.outstandingBalanceKobo));
                    }
                  }}
                />
                <span>
                  Settle full outstanding balance ({formatMoney(cust.outstandingBalanceKobo)})
                </span>
              </label>

              {!settleAll && (
                <Field label="Repayment amount (₦)">
                  <input
                    aria-label="Repayment amount (₦)"
                    inputMode="decimal"
                    required
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                  />
                </Field>
              )}

              <div className="form-two-columns">
                <Field label="Payment method">
                  <select
                    aria-label="Repayment method"
                    value={method}
                    onChange={(event) => setMethod(event.target.value as PaymentMethod)}
                  >
                    {paymentMethods.map((m) => (
                      <option key={m} value={m}>
                        {paymentMethodLabels[m]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reference (optional)">
                  <input
                    aria-label="Repayment reference"
                    placeholder="Transfer / POS ref"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </Field>
              </div>
              <Field label="Notes (optional)">
                <input
                  aria-label="Repayment notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </Field>
              <div className="form-actions">
                <Button type="button" variant="secondary" onClick={() => setRepayOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" busy={busy}>
                  Record repayment
                </Button>
              </div>
            </form>
          </Modal>
        </>
      ) : null}
    </div>
  );
}
