import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, Pencil, ReceiptText, Truck } from 'lucide-react';
import {
  hasPermission,
  purchaseLineStatusLabels,
  type PurchaseOrderDetail,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { BackLink, ErrorBlock, LoadingBlock, StatusBadge } from '../inventory/shared';
import { FinanceMetric, PurchaseStatusBadge } from './components';
import { formatDate, formatDateTime, formatMoney, paymentMethodLabels, useAsync } from './lib';

export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { api, user, notify } = useApp();
  const purchase = useAsync(() => api.request<PurchaseOrderDetail>(`/api/purchases/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  const canEdit = Boolean(user && hasPermission(user.permissions, 'purchases.edit'));
  const canCancel = Boolean(user && hasPermission(user.permissions, 'purchases.cancel'));
  const canReceive = Boolean(user && hasPermission(user.permissions, 'purchases.receive'));
  const canPay = Boolean(user && hasPermission(user.permissions, 'supplier_payments.record'));
  const data = purchase.data;

  async function run(path: string, body: object, success: string) {
    setBusy(true);
    setError(null);
    try {
      await api.request(path, 'POST', body);
      notify(success, 'success');
      setCancelOpen(false);
      purchase.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  if (purchase.loading && !data) return <LoadingBlock label="Loading purchase order…" />;
  if (purchase.error) return <ErrorBlock message={purchase.error} onRetry={purchase.reload} />;
  if (!data) return null;

  const receivable = data.status === 'ordered' || data.status === 'partially_received';
  const cancellable = data.status === 'draft' || data.status === 'ordered';

  return (
    <div className="inventory-workspace">
      <BackLink to="/purchases">Back to purchases</BackLink>
      <PageHeading
        eyebrow="Purchase order"
        title={data.referenceNumber}
        description={`${data.supplierName} · created ${formatDateTime(data.createdAt)} by ${data.createdByName ?? 'a team member'}`}
        action={
          <div className="button-row">
            {data.status === 'draft' && canEdit && (
              <Link className="button button-secondary" to={`/purchases/${data.id}/edit`}>
                <Pencil size={15} /> Edit draft
              </Link>
            )}
            {data.status === 'draft' && canEdit && (
              <Button
                onClick={() =>
                  void run(`/api/purchases/${data.id}/order`, {}, 'Purchase order placed.')
                }
                busy={busy}
              >
                <CheckCircle2 size={15} /> Mark ordered
              </Button>
            )}
            {receivable && canReceive && (
              <Link className="button button-primary" to={`/purchases/${data.id}/receive`}>
                <Truck size={15} /> Receive goods
              </Link>
            )}
            {cancellable && canCancel && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                <Ban size={15} /> Cancel
              </Button>
            )}
          </div>
        }
      />
      <FormError message={error} />
      <div className="inventory-metrics">
        <FinanceMetric
          label="Order total"
          value={formatMoney(data.totalKobo)}
          caption={`${data.itemCount} product line${data.itemCount === 1 ? '' : 's'}`}
        />
        <FinanceMetric
          label="Goods received"
          value={formatMoney(data.receivedValueKobo)}
          caption="Value of accepted deliveries"
          tone="green"
        />
        <FinanceMetric
          label="Paid to supplier"
          value={formatMoney(data.paidKobo)}
          caption="Recorded payments, net of reversals"
          tone="blue"
        />
        <FinanceMetric
          label="Outstanding"
          value={formatMoney(data.outstandingKobo)}
          caption={
            data.outstandingKobo > 0
              ? 'Owed after receipts and payments'
              : 'Nothing owed on received goods'
          }
          tone={data.outstandingKobo > 0 ? 'amber' : 'neutral'}
        />
      </div>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Order status</h2>
            <p>Only received goods create stock and supplier debt.</p>
          </div>
          <PurchaseStatusBadge status={data.status} />
        </div>
        <div className="inventory-detail-grid">
          <div className="detail-list">
            <div>
              <span>Supplier</span>
              <strong>{data.supplierName}</strong>
            </div>
            <div>
              <span>Supplier phone</span>
              <strong>{data.supplierPhone ?? '—'}</strong>
            </div>
            <div>
              <span>Expected delivery</span>
              <strong>{formatDate(data.expectedDeliveryDate)}</strong>
            </div>
            <div>
              <span>Ordered</span>
              <strong>
                {data.orderedAt
                  ? `${formatDateTime(data.orderedAt)}${data.orderedByName ? ` · ${data.orderedByName}` : ''}`
                  : 'Not placed yet'}
              </strong>
            </div>
            {data.status === 'cancelled' && (
              <div>
                <span>Cancellation</span>
                <strong>
                  {data.cancelReason ?? '—'}{' '}
                  {data.cancelledByName ? `· ${data.cancelledByName}` : ''}
                </strong>
              </div>
            )}
          </div>
          <div className="detail-list">
            <div>
              <span>Goods subtotal</span>
              <strong>{formatMoney(data.subtotalKobo)}</strong>
            </div>
            <div>
              <span>Discounts</span>
              <strong>{formatMoney(data.discountTotalKobo)}</strong>
            </div>
            <div>
              <span>Additional charges</span>
              <strong>{formatMoney(data.additionalChargesKobo)}</strong>
            </div>
            <div>
              <span>Order total</span>
              <strong>{formatMoney(data.totalKobo)}</strong>
            </div>
            <div>
              <span>Notes</span>
              <strong>{data.notes ?? '—'}</strong>
            </div>
          </div>
        </div>
        {data.discountReason && (
          <p className="inventory-note small">Discount reason: {data.discountReason}</p>
        )}
        {data.additionalChargesReason && (
          <p className="inventory-note small">Additional charges: {data.additionalChargesReason}</p>
        )}
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Ordered products</h2>
            <p>
              Received quantities are shown in the purchase unit, with base-unit totals in brackets.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Unit</th>
                <th>Ordered</th>
                <th>Received</th>
                <th>Pending</th>
                <th>Unit cost</th>
                <th>Line total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="table-primary">{item.productName}</span>
                    {item.productSku && <small className="muted">{item.productSku}</small>}
                  </td>
                  <td>
                    {item.unitName} ({item.conversionFactor}x)
                  </td>
                  <td>
                    {item.quantity} <small className="muted">({item.baseQuantity} base)</small>
                  </td>
                  <td>
                    {item.receivedQuantity}{' '}
                    <small className="muted">({item.receivedBaseQuantity} base)</small>
                  </td>
                  <td>
                    {item.pendingQuantity}{' '}
                    <small className="muted">
                      ({item.baseQuantity - item.receivedBaseQuantity} base)
                    </small>
                  </td>
                  <td>{formatMoney(item.unitCostKobo)}</td>
                  <td>{formatMoney(item.lineTotalKobo)}</td>
                  <td>
                    <StatusBadge
                      tone={
                        item.status === 'received'
                          ? 'green'
                          : item.status === 'partial'
                            ? 'amber'
                            : 'neutral'
                      }
                    >
                      {purchaseLineStatusLabels[item.status]}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Goods received</h2>
            <p>Each delivery is an atomic receipt that generated stock ledger movements.</p>
          </div>
          <Link className="button button-secondary" to="/purchases/receipts">
            <ReceiptText size={15} /> All receipts
          </Link>
        </div>
        {data.receipts.length === 0 ? (
          <p className="muted">No goods have been received against this order yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Received</th>
                  <th>Items</th>
                  <th>Value</th>
                  <th>Rejected</th>
                  <th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {data.receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td>
                      <span className="table-primary">{receipt.receiptNumber}</span>
                    </td>
                    <td>{formatDate(receipt.receivedDate)}</td>
                    <td>{receipt.itemCount}</td>
                    <td>{formatMoney(receipt.receivedValueKobo)}</td>
                    <td>{receipt.totalRejectedBaseQuantity} base units</td>
                    <td>{receipt.receivedByName ?? '—'}</td>
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
            <h2>Supplier payments</h2>
            <p>
              Payments are allocated to this invoice. Reversals are separate records, never
              deletions.
            </p>
          </div>
          {canPay && data.supplierId && (
            <Link className="button button-secondary" to={`/suppliers/${data.supplierId}/account`}>
              Record payment
            </Link>
          )}
        </div>
        {data.payments.length === 0 ? (
          <p className="muted">No payments have been recorded for this order.</p>
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
                  <th>Allocated here</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      <span className="table-primary">{payment.paymentNumber}</span>
                    </td>
                    <td>{payment.paymentKind === 'reversal' ? 'Reversal' : 'Payment'}</td>
                    <td>{paymentMethodLabels[payment.method]}</td>
                    <td>{formatDate(payment.paidAt)}</td>
                    <td>{formatMoney(payment.amountKobo)}</td>
                    <td>{formatMoney(payment.allocatedToOrderKobo)}</td>
                    <td>{payment.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this purchase order?"
      >
        <div className="modal-form">
          <p className="muted">
            Cancelling keeps the order in history. It cannot be received after cancellation.
          </p>
          <label className="field-label">
            Cancellation reason
            <textarea
              className="inventory-textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this order being cancelled?"
            />
          </label>
          <FormError message={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep order
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={reason.trim().length < 3}
              onClick={() =>
                void run(
                  `/api/purchases/${data.id}/cancel`,
                  { reason: reason.trim() },
                  'Purchase order cancelled.',
                )
              }
            >
              Cancel order
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
