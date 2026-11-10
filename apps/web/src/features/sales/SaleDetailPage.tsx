import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Ban, Printer, RefreshCw, RotateCcw } from 'lucide-react';
import {
  debtStatusLabels,
  hasPermission,
  ledgerPaymentMethodLabels,
  paymentMethodLabels,
  paymentMethods,
  productTypeLabels,
  salePaymentStatusLabels,
  saleStatusLabels,
  type PaymentMethod,
  type SaleDetail,
} from '@medimart/shared';
import { errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';
import { Badge, Button, FormError, Modal, PageHeading } from '../../components/ui';
import { formatDate, formatDateTime, formatMoney, useAsync } from '../inventory/lib';
import { BackLink, ErrorBlock, Field, LoadingBlock, StatusBadge } from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

export function SaleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api, user, notify } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'sales.view'));
  const canVoid = Boolean(user && hasPermission(user.permissions, 'sales.void'));
  const canRefund = Boolean(user && hasPermission(user.permissions, 'sales.refund'));

  const state = useAsync(
    () => (allowed && id ? api.request<SaleDetail>(`/api/sales/${id}`) : Promise.resolve(null)),
    [allowed, id],
  );

  // Void modal state
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidMethod, setVoidMethod] = useState<PaymentMethod>('cash');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const voidOpRef = useRef<string | null>(null);

  // Refund modal state
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('cash');
  const [refundReference, setRefundReference] = useState('');
  const [restockItems, setRestockItems] = useState(true);
  const [refundQtys, setRefundQtys] = useState<Record<string, number>>({});
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const refundOpRef = useRef<string | null>(null);

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Sales"
        title="Sale details"
        description="Inspect line items, batch allocations, payments, and audit reversals."
        permission="sales.view"
      />
    );
  }

  const sale = state.data;

  function openVoidModal() {
    setVoidReason('');
    setVoidError(null);
    voidOpRef.current = crypto.randomUUID();
    setVoidOpen(true);
  }

  function openRefundModal(detail: SaleDetail) {
    const initial: Record<string, number> = {};
    for (const item of detail.items) {
      initial[item.id] = 0;
    }
    setRefundQtys(initial);
    setRefundReason('');
    setRefundReference('');
    setRestockItems(true);
    setRefundError(null);
    refundOpRef.current = crypto.randomUUID();
    setRefundOpen(true);
  }

  async function submitVoid(event: FormEvent) {
    event.preventDefault();
    if (!sale) return;
    setVoidError(null);
    if (voidReason.trim().length < 3) {
      setVoidError('Provide a clear reason (at least 3 characters) to void this sale.');
      return;
    }
    setVoidBusy(true);
    try {
      await api.request<SaleDetail>(`/api/sales/${sale.id}/void`, 'POST', {
        operationId: voidOpRef.current ?? crypto.randomUUID(),
        reason: voidReason.trim(),
        refundMethod: voidMethod,
      });
      setVoidOpen(false);
      state.reload();
      notify(`Sale ${sale.receiptNumber} voided and stock restored.`, 'success');
    } catch (caught) {
      setVoidError(errorMessage(caught));
    } finally {
      setVoidBusy(false);
    }
  }

  async function submitRefund(event: FormEvent) {
    event.preventDefault();
    if (!sale) return;
    setRefundError(null);
    const items = Object.entries(refundQtys)
      .filter(([, qty]) => Number.isInteger(qty) && qty > 0)
      .map(([saleItemId, quantity]) => ({ saleItemId, quantity }));

    if (items.length === 0) {
      setRefundError('Enter a refund quantity greater than zero for at least one line item.');
      return;
    }
    if (refundReason.trim().length < 3) {
      setRefundError('Provide a reason (at least 3 characters) for this refund.');
      return;
    }
    setRefundBusy(true);
    try {
      await api.request<SaleDetail>(`/api/sales/${sale.id}/refund`, 'POST', {
        operationId: refundOpRef.current ?? crypto.randomUUID(),
        reason: refundReason.trim(),
        restockItems,
        refundMethod,
        reference: refundReference.trim() || null,
        items,
      });
      setRefundOpen(false);
      state.reload();
      notify(`Refund recorded for ${sale.receiptNumber}.`, 'success');
    } catch (caught) {
      setRefundError(errorMessage(caught));
    } finally {
      setRefundBusy(false);
    }
  }

  const eligibleForVoid =
    Boolean(sale) && sale!.status === 'completed' && sale!.refundedTotalKobo === 0;
  const eligibleForRefund =
    Boolean(sale) &&
    (sale!.status === 'completed' || sale!.status === 'partially_refunded') &&
    sale!.items.some((item) => item.refundableQuantity > 0);

  return (
    <>
      <BackLink to="/pos/sales">Back to sales history</BackLink>
      <PageHeading
        eyebrow="Sale record"
        title={sale ? sale.receiptNumber : 'Sale details'}
        description="Completed sales are never deleted; any void or refund is permanently recorded with stock and payment reversals."
        action={
          sale && (
            <>
              <Button variant="secondary" onClick={state.reload} busy={state.loading}>
                <RefreshCw size={15} /> Refresh
              </Button>
              <Link to={`/pos/receipts/${sale.id}`} className="button button-secondary">
                <Printer size={15} /> View &amp; print receipt
              </Link>
              {canRefund && eligibleForRefund && (
                <Button variant="secondary" onClick={() => openRefundModal(sale)}>
                  <RotateCcw size={15} /> Process refund
                </Button>
              )}
              {canVoid && eligibleForVoid && (
                <Button variant="danger" onClick={openVoidModal}>
                  <Ban size={15} /> Void sale
                </Button>
              )}
            </>
          )
        }
      />

      {state.loading && !sale ? (
        <LoadingBlock label="Loading sale details…" />
      ) : state.error ? (
        <ErrorBlock message={state.error} onRetry={state.reload} />
      ) : sale ? (
        <>
          <section className="inventory-metrics" aria-label="Sale financial summary">
            <div className="inventory-metric">
              <span className="muted small">Sale total</span>
              <div className="metric-value">{formatMoney(sale.totalKobo)}</div>
              <small className="muted">Subtotal {formatMoney(sale.subtotalKobo)}</small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Amount paid</span>
              <div className="metric-value">{formatMoney(sale.amountPaidKobo)}</div>
              <small className="muted">
                Tendered {formatMoney(sale.tenderedKobo)} · Change {formatMoney(sale.changeDueKobo)}
              </small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Current credit balance</span>
              <div className="metric-value">{formatMoney(sale.currentOutstandingKobo)}</div>
              <small className="muted">
                Initial credit {formatMoney(sale.initialOutstandingKobo)}
              </small>
            </div>
            <div className="inventory-metric">
              <span className="muted small">Refunded total</span>
              <div className="metric-value">{formatMoney(sale.refundedTotalKobo)}</div>
              <small className="muted">{saleStatusLabels[sale.status]}</small>
            </div>
          </section>

          <div className="inventory-detail-grid">
            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Transaction summary</h2>
                  <p>Recorded in integer kobo with immutable audit linkage.</p>
                </div>
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
              </div>
              <dl className="detail-list">
                <div>
                  <dt>Receipt number</dt>
                  <dd>{sale.receiptNumber}</dd>
                </div>
                <div>
                  <dt>Date &amp; time</dt>
                  <dd>{formatDateTime(sale.createdAt)}</dd>
                </div>
                <div>
                  <dt>Customer</dt>
                  <dd>
                    {sale.customerId ? (
                      <Link to={`/customers/${sale.customerId}`} className="row-link">
                        {sale.customerName}
                      </Link>
                    ) : (
                      sale.customerName
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Cashier / staff</dt>
                  <dd>{sale.soldByName ?? sale.soldBy}</dd>
                </div>
                <div>
                  <dt>Payment status</dt>
                  <dd>{salePaymentStatusLabels[sale.paymentStatus]}</dd>
                </div>
                {sale.discountTotalKobo > 0 && (
                  <>
                    <div>
                      <dt>Total discount</dt>
                      <dd>{formatMoney(sale.discountTotalKobo)}</dd>
                    </div>
                    <div>
                      <dt>Discount reason</dt>
                      <dd>{sale.discountReason ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Authorized by</dt>
                      <dd>{sale.discountAuthorizedByName ?? 'Cashier permission'}</dd>
                    </div>
                  </>
                )}
                {sale.notes && (
                  <div>
                    <dt>Notes</dt>
                    <dd>{sale.notes}</dd>
                  </div>
                )}
                {sale.voidedAt && (
                  <div>
                    <dt>Voided</dt>
                    <dd>
                      {formatDateTime(sale.voidedAt)} by {sale.voidedByName ?? 'Staff'} —{' '}
                      {sale.voidReason}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Payment &amp; debt ledger</h2>
                  <p>Every payment leg and reversal payout recorded on this receipt.</p>
                </div>
              </div>
              {sale.payments.length === 0 ? (
                <p className="empty-small">
                  No cash, transfer, or POS payment recorded at checkout (100% credit sale).
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Kind</th>
                        <th>Method</th>
                        <th>Reference</th>
                        <th className="num">Net amount</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sale.payments.map((payment) => (
                        <tr key={payment.id}>
                          <td>{payment.paymentKind.replace('_', ' ')}</td>
                          <td>{ledgerPaymentMethodLabels[payment.method]}</td>
                          <td>{payment.reference ?? '—'}</td>
                          <td className="num">
                            <strong>
                              {payment.paymentKind === 'sale_payment' ? '' : '−'}
                              {formatMoney(payment.netAmountKobo)}
                            </strong>
                          </td>
                          <td>{formatDateTime(payment.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {sale.debt && (
                <div className="inventory-note" style={{ marginTop: 12 }}>
                  <strong>Linked customer debt:</strong> Original credit{' '}
                  {formatMoney(sale.debt.originalAmountKobo)} · Paid{' '}
                  {formatMoney(sale.debt.amountPaidKobo)} · Cancelled by reversal{' '}
                  {formatMoney(sale.debt.amountCancelledKobo)} ·{' '}
                  <strong>Outstanding: {formatMoney(sale.debt.outstandingKobo)}</strong> (
                  {debtStatusLabels[sale.debt.status]}){' '}
                  <Link to="/debts" className="row-link">
                    Open Debts
                  </Link>
                </div>
              )}
            </section>
          </div>

          {/* Line items & FEFO Batch allocations */}
          <section className="card inventory-card">
            <div className="card-heading">
              <div>
                <h2>Sold items &amp; FEFO batch deductions</h2>
                <p>Unit conversions and batch-level stock movements tied to this receipt.</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Type</th>
                    <th className="num">Sold qty</th>
                    <th className="num">Base qty</th>
                    <th className="num">Unit price</th>
                    <th className="num">Line discount</th>
                    <th className="num">Net total</th>
                    <th className="num">Refunded</th>
                    <th>FEFO batch allocations</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.productName}</strong>
                        {item.productSku && <div className="muted small">{item.productSku}</div>}
                      </td>
                      <td>
                        <Badge tone={item.productType === 'medicine' ? 'green' : 'neutral'}>
                          {productTypeLabels[item.productType]}
                        </Badge>
                      </td>
                      <td className="num">
                        {item.quantity} {item.unitSymbol}
                      </td>
                      <td className="num">{item.baseQuantity}</td>
                      <td className="num">{formatMoney(item.unitPriceKobo)}</td>
                      <td className="num">
                        {item.lineDiscountKobo > 0 ? `−${formatMoney(item.lineDiscountKobo)}` : '—'}
                      </td>
                      <td className="num">
                        <strong>{formatMoney(item.netTotalKobo)}</strong>
                      </td>
                      <td className="num">
                        {item.quantityRefunded > 0
                          ? `${item.quantityRefunded} ${item.unitSymbol}`
                          : '—'}
                      </td>
                      <td>
                        <div className="pos-alloc-badges">
                          {item.allocations.map((alloc) => (
                            <span key={alloc.id} className="status-pill status-neutral">
                              {alloc.batchNumber ? `Batch ${alloc.batchNumber}` : 'Unbatched'}:{' '}
                              {alloc.baseQuantity}
                              {alloc.expiryDate ? ` (exp ${formatDate(alloc.expiryDate)})` : ''}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Reversals Audit Trail */}
          {sale.reversals.length > 0 && (
            <section className="card inventory-card">
              <div className="card-heading">
                <div>
                  <h2>Reversal &amp; refund history</h2>
                  <p>
                    Permanent reversal records preserving full accounting and stock traceability.
                  </p>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reversal #</th>
                      <th>Type</th>
                      <th>Reason</th>
                      <th>Restocked</th>
                      <th className="num">Total reversed</th>
                      <th className="num">Credit reduced</th>
                      <th className="num">Cash/Method refunded</th>
                      <th>By</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sale.reversals.map((rev) => (
                      <tr key={rev.id}>
                        <td>
                          <strong>{rev.reversalNumber}</strong>
                        </td>
                        <td>
                          <StatusBadge tone={rev.reversalType === 'void' ? 'red' : 'amber'}>
                            {rev.reversalType.toUpperCase()}
                          </StatusBadge>
                        </td>
                        <td>{rev.reason}</td>
                        <td>{rev.restockItems ? 'Yes' : 'No (damaged)'}</td>
                        <td className="num">{formatMoney(rev.totalReversedKobo)}</td>
                        <td className="num">{formatMoney(rev.debtReducedKobo)}</td>
                        <td className="num">
                          {formatMoney(rev.cashRefundedKobo)}
                          {rev.refundMethod ? ` (${paymentMethodLabels[rev.refundMethod]})` : ''}
                        </td>
                        <td>{rev.createdByName ?? rev.createdBy}</td>
                        <td>{formatDateTime(rev.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Void Modal */}
          <Modal
            open={voidOpen}
            onClose={() => setVoidOpen(false)}
            title={`Void ${sale.receiptNumber}`}
          >
            <form onSubmit={(event) => void submitVoid(event)} className="modal-form">
              <p className="confirm-message">
                Voiding keeps receipt <strong>{sale.receiptNumber}</strong> on record as{' '}
                <strong>Voided</strong>, restores all sold batch quantities to inventory, cancels
                any unpaid credit first, and records a reversal for any paid balance.
              </p>
              <FormError message={voidError} />
              <Field label="Reason for voiding">
                <input
                  aria-label="Reason for voiding"
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Duplicate ring-up / customer cancelled at counter"
                  value={voidReason}
                  onChange={(event) => setVoidReason(event.target.value)}
                />
              </Field>
              <Field label="Reversal method for paid portion">
                <select
                  aria-label="Void refund method"
                  value={voidMethod}
                  onChange={(event) => setVoidMethod(event.target.value as PaymentMethod)}
                >
                  {paymentMethods.map((m) => (
                    <option key={m} value={m}>
                      {paymentMethodLabels[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-actions">
                <Button type="button" variant="secondary" onClick={() => setVoidOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" busy={voidBusy}>
                  Confirm void sale
                </Button>
              </div>
            </form>
          </Modal>

          {/* Refund Modal */}
          <Modal
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
            title={`Refund items from ${sale.receiptNumber}`}
          >
            <form onSubmit={(event) => void submitRefund(event)} className="modal-form">
              <p className="confirm-message">
                Select quantities to refund. Any unpaid credit on this sale (
                {formatMoney(sale.currentOutstandingKobo)}) is reduced before cash is refunded.
              </p>
              <FormError message={refundError} />

              <div className="pos-refund-lines">
                {sale.items.map((item) => (
                  <div key={item.id} className="pos-refund-line">
                    <div>
                      <strong>{item.productName}</strong>
                      <div className="muted small">
                        Refundable: {item.refundableQuantity} {item.unitSymbol} · Net{' '}
                        {formatMoney(item.netTotalKobo)}
                      </div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={item.refundableQuantity}
                      disabled={item.refundableQuantity <= 0}
                      aria-label={`Refund quantity for ${item.productName}`}
                      value={refundQtys[item.id] ?? 0}
                      onChange={(event) =>
                        setRefundQtys((current) => ({
                          ...current,
                          [item.id]: Math.max(
                            0,
                            Math.min(item.refundableQuantity, Number(event.target.value)),
                          ),
                        }))
                      }
                    />
                  </div>
                ))}
              </div>

              <label className="checkbox-inline" style={{ margin: '10px 0' }}>
                <input
                  type="checkbox"
                  checked={restockItems}
                  onChange={(event) => setRestockItems(event.target.checked)}
                />
                <span>Return refunded quantities to sellable inventory batches</span>
              </label>

              <div className="form-two-columns">
                <Field label="Refund payout method">
                  <select
                    aria-label="Refund payout method"
                    value={refundMethod}
                    onChange={(event) => setRefundMethod(event.target.value as PaymentMethod)}
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
                    aria-label="Refund reference"
                    value={refundReference}
                    onChange={(event) => setRefundReference(event.target.value)}
                  />
                </Field>
              </div>

              <Field label="Refund reason">
                <input
                  aria-label="Refund reason"
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Unopened return / wrong strength"
                  value={refundReason}
                  onChange={(event) => setRefundReason(event.target.value)}
                />
              </Field>

              <div className="form-actions">
                <Button type="button" variant="secondary" onClick={() => setRefundOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" busy={refundBusy}>
                  Record refund
                </Button>
              </div>
            </form>
          </Modal>
        </>
      ) : null}
    </>
  );
}
