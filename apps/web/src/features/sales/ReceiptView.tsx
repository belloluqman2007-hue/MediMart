import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileText, Printer, Receipt, ShoppingBag } from 'lucide-react';
import {
  hasPermission,
  ledgerPaymentMethodLabels,
  salePaymentStatusLabels,
  saleStatusLabels,
  type SaleDetail,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { formatDate, formatDateTime, formatMoney, useAsync } from '../inventory/lib';
import { BackLink, ErrorBlock, LoadingBlock, StatusBadge } from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

export type ReceiptPrintMode = 'thermal' | 'standard';

export function ReceiptDocument({ sale, mode }: { sale: SaleDetail; mode: ReceiptPrintMode }) {
  const activePayments = sale.payments.filter((payment) => payment.paymentKind === 'sale_payment');
  return (
    <article
      className={`receipt-sheet ${mode === 'thermal' ? 'receipt-thermal' : 'receipt-standard'}`}
      aria-label={`Receipt ${sale.receiptNumber}`}
    >
      <header className="receipt-header">
        <h2>{sale.shop.businessName}</h2>
        {sale.shop.shopAddress && <p>{sale.shop.shopAddress}</p>}
        {(sale.shop.shopPhone || sale.shop.shopEmail) && (
          <p>{[sale.shop.shopPhone, sale.shop.shopEmail].filter(Boolean).join(' · ')}</p>
        )}
        <div className="receipt-badge-row">
          <span className="receipt-doc-title">OFFICIAL SALES RECEIPT</span>
          {sale.status !== 'completed' && (
            <span className="receipt-status-stamp">
              {saleStatusLabels[sale.status].toUpperCase()}
            </span>
          )}
        </div>
      </header>

      <div className="receipt-divider" />

      <dl className="receipt-meta">
        <div>
          <dt>Receipt No.</dt>
          <dd>{sale.receiptNumber}</dd>
        </div>
        <div>
          <dt>Date &amp; time</dt>
          <dd>{formatDateTime(sale.createdAt)}</dd>
        </div>
        <div>
          <dt>Customer</dt>
          <dd>
            {sale.customerName}
            {sale.customerPhone ? ` (${sale.customerPhone})` : ''}
          </dd>
        </div>
        <div>
          <dt>Served by</dt>
          <dd>{sale.soldByName ?? 'Staff'}</dd>
        </div>
        <div>
          <dt>Payment status</dt>
          <dd>{salePaymentStatusLabels[sale.paymentStatus]}</dd>
        </div>
      </dl>

      <div className="receipt-divider" />

      <table className="receipt-items-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Unit</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.productName}</strong>
                {item.lineDiscountKobo > 0 && (
                  <small className="receipt-item-sub">
                    Line discount: −{formatMoney(item.lineDiscountKobo)}
                  </small>
                )}
                {item.quantityRefunded > 0 && (
                  <small className="receipt-item-sub">
                    Returned: {item.quantityRefunded} {item.unitSymbol}
                  </small>
                )}
              </td>
              <td className="num">
                {item.quantity} {item.unitSymbol}
              </td>
              <td className="num">{formatMoney(item.unitPriceKobo)}</td>
              <td className="num">{formatMoney(item.lineTotalKobo)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="receipt-divider" />

      <dl className="receipt-totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{formatMoney(sale.subtotalKobo)}</dd>
        </div>
        {sale.lineDiscountTotalKobo > 0 && (
          <div>
            <dt>Item discounts</dt>
            <dd>−{formatMoney(sale.lineDiscountTotalKobo)}</dd>
          </div>
        )}
        {sale.cartDiscountKobo > 0 && (
          <div>
            <dt>
              Cart discount
              {sale.discountReason ? ` (${sale.discountReason})` : ''}
            </dt>
            <dd>−{formatMoney(sale.cartDiscountKobo)}</dd>
          </div>
        )}
        {sale.discountTotalKobo > 0 && (
          <div>
            <dt>Total discount</dt>
            <dd>−{formatMoney(sale.discountTotalKobo)}</dd>
          </div>
        )}
        <div className="receipt-grand-total">
          <dt>Grand total</dt>
          <dd>{formatMoney(sale.totalKobo)}</dd>
        </div>
      </dl>

      <div className="receipt-divider" />

      <section className="receipt-payments" aria-label="Payment breakdown">
        <h3>Payment breakdown</h3>
        {activePayments.length === 0 ? (
          <p className="receipt-credit-line">
            No upfront payment collected — recorded on customer credit account.
          </p>
        ) : (
          <dl className="receipt-totals">
            {activePayments.map((payment) => (
              <div key={payment.id}>
                <dt>
                  {ledgerPaymentMethodLabels[payment.method]}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                </dt>
                <dd>{formatMoney(payment.tenderedKobo)}</dd>
              </div>
            ))}
          </dl>
        )}

        <dl className="receipt-totals receipt-settlement">
          <div>
            <dt>Amount tendered</dt>
            <dd>{formatMoney(sale.tenderedKobo)}</dd>
          </div>
          <div>
            <dt>Amount paid (applied)</dt>
            <dd>{formatMoney(sale.amountPaidKobo)}</dd>
          </div>
          <div>
            <dt>Change due</dt>
            <dd>{formatMoney(sale.changeDueKobo)}</dd>
          </div>
          <div className={sale.currentOutstandingKobo > 0 ? 'receipt-balance-due' : ''}>
            <dt>Outstanding balance</dt>
            <dd>{formatMoney(sale.currentOutstandingKobo)}</dd>
          </div>
          {sale.debt?.dueDate && sale.currentOutstandingKobo > 0 && (
            <div>
              <dt>Payment due date</dt>
              <dd>{formatDate(sale.debt.dueDate)}</dd>
            </div>
          )}
        </dl>
      </section>

      {sale.reversals.length > 0 && (
        <>
          <div className="receipt-divider" />
          <section className="receipt-reversals" aria-label="Reversals and refunds">
            <h3>Reversal / refund record</h3>
            {sale.reversals.map((rev) => (
              <div key={rev.id} className="receipt-reversal-entry">
                <strong>
                  {rev.reversalNumber} · {rev.reversalType.toUpperCase()}
                </strong>
                <span>
                  Amount: {formatMoney(rev.totalReversedKobo)} (Cash refunded:{' '}
                  {formatMoney(rev.cashRefundedKobo)}, Credit reduced:{' '}
                  {formatMoney(rev.debtReducedKobo)})
                </span>
                <small>Reason: {rev.reason}</small>
              </div>
            ))}
          </section>
        </>
      )}

      <div className="receipt-divider" />

      <footer className="receipt-footer">
        <p>{sale.shop.receiptFooter || 'Thank you for shopping at MediMart.'}</p>
        <small>All monetary amounts calculated in integer kobo (NGN).</small>
      </footer>
    </article>
  );
}

export function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const { api, user } = useApp();
  const [mode, setMode] = useState<ReceiptPrintMode>('thermal');
  const allowed = Boolean(user && hasPermission(user.permissions, 'sales.view'));

  const state = useAsync(
    () => (allowed && id ? api.request<SaleDetail>(`/api/sales/${id}`) : Promise.resolve(null)),
    [allowed, id],
  );

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Receipts"
        title="Sales receipt"
        description="Printable ordinary paper and thermal POS receipts."
        permission="sales.view"
      />
    );
  }

  const sale = state.data;

  return (
    <div className={`receipt-page print-mode-${mode}`}>
      <div className="no-print">
        <BackLink to={sale ? `/pos/sales/${sale.id}` : '/pos/sales'}>Back to sale details</BackLink>
        <PageHeading
          eyebrow="Sales receipt"
          title={sale ? sale.receiptNumber : 'Loading receipt'}
          description="Switch between 80mm thermal roll and full-page ordinary paper formats, then print."
          action={
            sale && (
              <div className="receipt-toolbar">
                <div className="segmented-control" role="group" aria-label="Receipt format">
                  <button
                    type="button"
                    className={mode === 'thermal' ? 'active' : ''}
                    onClick={() => setMode('thermal')}
                  >
                    <Receipt size={15} /> Thermal (80mm)
                  </button>
                  <button
                    type="button"
                    className={mode === 'standard' ? 'active' : ''}
                    onClick={() => setMode('standard')}
                  >
                    <FileText size={15} /> Ordinary paper (A4)
                  </button>
                </div>
                <Button variant="primary" onClick={() => window.print()}>
                  <Printer size={15} /> Print receipt
                </Button>
                <Link to="/pos" className="button button-secondary">
                  <ShoppingBag size={15} /> New sale
                </Link>
              </div>
            )
          }
        />
      </div>

      {state.loading && !sale ? (
        <LoadingBlock label="Preparing receipt…" />
      ) : state.error ? (
        <ErrorBlock message={state.error} onRetry={state.reload} />
      ) : sale ? (
        <>
          <div className="receipt-status-bar no-print">
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
            <StatusBadge
              tone={
                sale.paymentStatus === 'paid'
                  ? 'green'
                  : sale.paymentStatus === 'partial' || sale.paymentStatus === 'credit'
                    ? 'amber'
                    : 'neutral'
              }
            >
              {salePaymentStatusLabels[sale.paymentStatus]}
            </StatusBadge>
          </div>
          <div className="receipt-preview-stage">
            <ReceiptDocument sale={sale} mode={mode} />
          </div>
        </>
      ) : null}
    </div>
  );
}
