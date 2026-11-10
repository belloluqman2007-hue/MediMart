import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Banknote, RotateCcw, Truck } from 'lucide-react';
import {
  hasPermission,
  type SupplierAccountDetail,
  type SupplierInvoiceSummary,
  type SupplierPaymentSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { BackLink, ErrorBlock, LoadingBlock, StatusBadge } from '../inventory/shared';
import { FinanceMetric } from './components';
import {
  buildQuery,
  formatDate,
  formatDateTime,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  paymentMethodLabels,
  randomId,
  rangeFor,
  today,
  useAsync,
} from './lib';

export function SupplierAccountPage() {
  const { id = '' } = useParams();
  const { api, user, notify } = useApp();
  const initial = rangeFor('month');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const account = useAsync(
    () =>
      api.request<SupplierAccountDetail>(`/api/suppliers/${id}/account${buildQuery({ from, to })}`),
    [id, from, to],
  );
  const [paying, setPaying] = useState<SupplierInvoiceSummary | null>(null);
  const [reversing, setReversing] = useState<SupplierPaymentSummary | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'pos_terminal'>('bank_transfer');
  const [paidAt, setPaidAt] = useState(today());
  const [reference, setReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canPay = Boolean(user && hasPermission(user.permissions, 'supplier_payments.record'));
  const canReverse = Boolean(user && hasPermission(user.permissions, 'supplier_payments.reverse'));
  const data = account.data;

  function openPayment(invoice: SupplierInvoiceSummary) {
    setPaying(invoice);
    setAmount(koboToNairaInput(invoice.outstandingKobo));
    setMethod('bank_transfer');
    setPaidAt(today());
    setReference('');
    setPaymentNotes('');
    setError(null);
  }

  async function submitPayment(event: FormEvent) {
    event.preventDefault();
    if (!paying || !data) return;
    setError(null);
    const kobo = nairaToKobo(amount);
    if (kobo === null || kobo <= 0) {
      setError('Enter a valid payment amount in naira.');
      return;
    }
    if (kobo > paying.outstandingKobo) {
      setError(`This invoice only has ${formatMoney(paying.outstandingKobo)} outstanding.`);
      return;
    }
    setBusy(true);
    try {
      await api.request('/api/supplier-payments', 'POST', {
        operationId: randomId(),
        supplierId: data.supplierId,
        amountKobo: kobo,
        method,
        paidAt,
        reference: reference.trim() || undefined,
        notes: paymentNotes.trim() || undefined,
        allocations: [{ purchaseOrderId: paying.purchaseOrderId, amountKobo: kobo }],
      });
      notify('Supplier payment recorded and allocated.', 'success');
      setPaying(null);
      account.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The payment could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  async function submitReversal(event: FormEvent) {
    event.preventDefault();
    if (!reversing) return;
    setError(null);
    setBusy(true);
    try {
      await api.request(`/api/supplier-payments/${reversing.id}/reverse`, 'POST', {
        operationId: randomId(),
        reason: reason.trim(),
      });
      notify('Payment reversed with a new audit record.', 'success');
      setReversing(null);
      setReason('');
      account.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The reversal could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  if (account.loading && !data) return <LoadingBlock label="Loading supplier account…" />;
  if (account.error) return <ErrorBlock message={account.error} onRetry={account.reload} />;
  if (!data) return null;

  return (
    <div className="inventory-workspace">
      <BackLink to="/suppliers">Back to suppliers</BackLink>
      <PageHeading
        eyebrow="Supplier account"
        title={data.supplierName}
        description={`${data.contactPerson ?? 'No contact person'} · ${data.phone ?? 'No phone'} · Purchase history, payments and outstanding invoices in one place.`}
        action={
          <Link className="button button-secondary" to={`/purchases?supplierId=${data.supplierId}`}>
            <Truck size={15} /> Purchases
          </Link>
        }
      />
      <section className="card inventory-card">
        <div className="inventory-filters">
          <label className="inline-date">
            <span className="small muted">Statement from</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="inline-date">
            <span className="small muted">To</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <span className={`status-pill status-${data.status === 'active' ? 'green' : 'neutral'}`}>
            {data.status}
          </span>
        </div>
        <div className="inventory-metrics">
          <FinanceMetric
            label="Goods received"
            value={formatMoney(data.totalGoodsReceivedKobo)}
            caption={`${data.totalPurchaseOrders} orders in total`}
          />
          <FinanceMetric
            label="Net paid"
            value={formatMoney(data.netPaidKobo)}
            caption={`${formatMoney(data.totalPaymentReversalsKobo)} reversed`}
            tone="blue"
          />
          <FinanceMetric
            label="Outstanding balance"
            value={formatMoney(data.outstandingBalanceKobo)}
            caption={`${data.outstandingInvoiceCount} open invoice${data.outstandingInvoiceCount === 1 ? '' : 's'}`}
            tone={data.outstandingBalanceKobo > 0 ? 'amber' : 'green'}
          />
          <FinanceMetric
            label="Last delivery"
            value={formatDate(data.lastReceiptDate)}
            caption={
              data.lastPaymentAt
                ? `Last payment ${formatDate(data.lastPaymentAt)}`
                : 'No payments yet'
            }
          />
        </div>
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Outstanding invoices</h2>
            <p>
              A payable exists only for goods actually received, less recorded payments and
              reversals.
            </p>
          </div>
        </div>
        {data.outstandingInvoices.length === 0 ? (
          <p className="muted">Nothing is owed to this supplier.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Ordered</th>
                  <th>Goods received</th>
                  <th>Allocated paid</th>
                  <th>Outstanding</th>
                  <th>Status</th>
                  <th aria-label="Pay" />
                </tr>
              </thead>
              <tbody>
                {data.outstandingInvoices.map((invoice) => (
                  <tr key={invoice.purchaseOrderId}>
                    <td>
                      <Link className="table-primary" to={`/purchases/${invoice.purchaseOrderId}`}>
                        {invoice.referenceNumber}
                      </Link>
                    </td>
                    <td>{formatMoney(invoice.orderedValueKobo)}</td>
                    <td>{formatMoney(invoice.receivedValueKobo)}</td>
                    <td>{formatMoney(invoice.allocatedPaidKobo)}</td>
                    <td className="text-amber">{formatMoney(invoice.outstandingKobo)}</td>
                    <td>
                      <StatusBadge tone={invoice.paymentStatus === 'partial' ? 'amber' : 'neutral'}>
                        {invoice.paymentStatus}
                      </StatusBadge>
                    </td>
                    <td className="row-actions">
                      {canPay && (
                        <Button variant="secondary" onClick={() => openPayment(invoice)}>
                          <Banknote size={15} /> Pay
                        </Button>
                      )}
                    </td>
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
            <h2>Payment history</h2>
            <p>Payments can be reversed with a new record. They are never edited or deleted.</p>
          </div>
          <Link
            className="button button-secondary"
            to={`/supplier-payments?supplierId=${data.supplierId}`}
          >
            All payments
          </Link>
        </div>
        {data.recentPayments.length === 0 ? (
          <p className="muted">No payments recorded for this supplier.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Kind</th>
                  <th>Method</th>
                  <th>Paid</th>
                  <th>Amount</th>
                  <th>Reference</th>
                  <th>Invoices</th>
                  <th aria-label="Reverse" />
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      <span className="table-primary">{payment.paymentNumber}</span>
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
                    <td className="row-actions">
                      {canReverse &&
                        payment.paymentKind === 'payment' &&
                        !payment.reversedByPaymentId && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setReversing(payment);
                              setReason('');
                              setError(null);
                            }}
                          >
                            <RotateCcw size={14} /> Reverse
                          </Button>
                        )}
                      {payment.reversedByPaymentId && <small className="muted">Reversed</small>}
                    </td>
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
            <h2>Supplier statement</h2>
            <p>Opening balance, receipts, payments and reversals with a running balance (₦).</p>
          </div>
        </div>
        <div className="detail-list">
          <div>
            <span>Opening balance</span>
            <strong>{formatMoney(data.statement.openingBalanceKobo)}</strong>
          </div>
          <div>
            <span>Total debits</span>
            <strong>{formatMoney(data.statement.totalDebitsKobo)}</strong>
          </div>
          <div>
            <span>Total credits</span>
            <strong>{formatMoney(data.statement.totalCreditsKobo)}</strong>
          </div>
          <div>
            <span>Closing balance</span>
            <strong>{formatMoney(data.statement.closingBalanceKobo)}</strong>
          </div>
        </div>
        {data.statement.entries.length === 0 ? (
          <p className="muted">No statement entries in this date range.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th>Running balance</th>
                </tr>
              </thead>
              <tbody>
                {data.statement.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.date)}</td>
                    <td>{entry.reference}</td>
                    <td>{entry.description}</td>
                    <td>{entry.debitKobo > 0 ? formatMoney(entry.debitKobo) : '—'}</td>
                    <td>{entry.creditKobo > 0 ? formatMoney(entry.creditKobo) : '—'}</td>
                    <td>{formatMoney(entry.runningBalanceKobo)}</td>
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
            <h2>Purchase and receiving history</h2>
            <p>Recent purchase orders and deliveries for this supplier.</p>
          </div>
        </div>
        <div className="inventory-detail-grid">
          <div>
            <h3 className="section-title">Recent purchases</h3>
            {data.recentPurchases.length === 0 ? (
              <p className="muted">No purchases yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Status</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentPurchases.map((purchase) => (
                      <tr key={purchase.id}>
                        <td>
                          <Link className="text-link" to={`/purchases/${purchase.id}`}>
                            {purchase.referenceNumber}
                          </Link>
                        </td>
                        <td>{purchase.status.replaceAll('_', ' ')}</td>
                        <td>{formatMoney(purchase.totalKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3 className="section-title">Recent deliveries</h3>
            {data.recentReceipts.length === 0 ? (
              <p className="muted">No deliveries yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Date</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentReceipts.map((receipt) => (
                      <tr key={receipt.id}>
                        <td>{receipt.receiptNumber}</td>
                        <td>{formatDate(receipt.receivedDate)}</td>
                        <td>{formatMoney(receipt.receivedValueKobo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      <Modal
        open={Boolean(paying)}
        onClose={() => setPaying(null)}
        title={`Pay ${paying?.referenceNumber ?? 'invoice'}`}
      >
        <form className="modal-form" onSubmit={(event) => void submitPayment(event)}>
          <div className="detail-list">
            <div>
              <span>Invoice outstanding</span>
              <strong>{formatMoney(paying?.outstandingKobo)}</strong>
            </div>
            <div>
              <span>Supplier</span>
              <strong>{data.supplierName}</strong>
            </div>
          </div>
          <label className="field-label">
            Amount (₦)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          <label className="field-label">
            Payment method
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as typeof method)}
            >
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="pos_terminal">POS</option>
            </select>
          </label>
          <label className="field-label">
            Payment date
            <input
              type="date"
              max={today()}
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
              required
            />
          </label>
          <label className="field-label">
            Bank / payment reference
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. TRX-889102"
            />
          </label>
          <label className="field-label">
            Notes
            <input value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} />
          </label>
          <p className="small muted">
            The full amount is allocated to this invoice. Partial payments are allowed.
          </p>
          <FormError message={error} />
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setPaying(null)}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              <Banknote size={15} /> Record payment
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(reversing)}
        onClose={() => setReversing(null)}
        title="Reverse supplier payment?"
      >
        <form className="modal-form" onSubmit={(event) => void submitReversal(event)}>
          <p className="muted">
            {reversing?.paymentNumber} · {formatMoney(reversing?.amountKobo)} ·{' '}
            {reversing ? paymentMethodLabels[reversing.method] : ''} ·{' '}
            {formatDateTime(reversing?.createdAt)}
          </p>
          <label className="field-label">
            Reversal reason
            <textarea
              className="inventory-textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this payment being reversed?"
            />
          </label>
          <p className="small muted">
            A new reversal record will be created. The original payment stays in the audit trail.
          </p>
          <FormError message={error} />
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setReversing(null)}>
              Keep payment
            </Button>
            <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>
              <RotateCcw size={15} /> Reverse payment
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
