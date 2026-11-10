import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, PackageCheck } from 'lucide-react';
import type { GoodsReceiptDetail, PurchaseOrderDetail } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, PageHeading } from '../../components/ui';
import { BackLink, ErrorBlock, LoadingBlock } from '../inventory/shared';
import { PurchaseStatusBadge } from './components';
import {
  formatDate,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  randomId,
  today,
  useAsync,
} from './lib';

type ReceiveDraft = {
  purchaseOrderItemId: string;
  accepted: string;
  rejected: string;
  rejectionReason: string;
  unitCost: string;
  batchNumber: string;
  manufacturingDate: string;
  expiryDate: string;
  medicine: boolean;
};

export function ReceiveGoodsPage() {
  const { id = '' } = useParams();
  const { api } = useApp();
  const purchase = useAsync(() => api.request<PurchaseOrderDetail>(`/api/purchases/${id}`), [id]);

  if (purchase.loading && !purchase.data) return <LoadingBlock label="Loading purchase order…" />;
  if (purchase.error) return <ErrorBlock message={purchase.error} onRetry={purchase.reload} />;
  if (!purchase.data) return null;
  return <ReceiveGoodsBody key={purchase.data.id} purchase={purchase.data} />;
}

function ReceiveGoodsBody({ purchase }: { purchase: PurchaseOrderDetail }) {
  const { api, notify } = useApp();
  const [rows, setRows] = useState<ReceiveDraft[]>(() =>
    purchase.items
      .filter((item) => item.pendingQuantity > 0)
      .map((item) => ({
        purchaseOrderItemId: item.id,
        accepted: String(item.pendingQuantity),
        rejected: '0',
        rejectionReason: '',
        unitCost: koboToNairaInput(item.unitCostKobo),
        batchNumber: '',
        manufacturingDate: '',
        expiryDate: '',
        medicine: item.productType === 'medicine',
      })),
  );
  const [receivedDate, setReceivedDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GoodsReceiptDetail | null>(null);

  const pendingLines = useMemo(
    () => purchase.items.filter((item) => item.pendingQuantity > 0),
    [purchase.items],
  );

  function update(itemId: string, patch: Partial<ReceiveDraft>) {
    setRows((current) =>
      current.map((row) => (row.purchaseOrderItemId === itemId ? { ...row, ...patch } : row)),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const items = [];
    for (const row of rows) {
      const accepted = Number(row.accepted || 0);
      const rejected = Number(row.rejected || 0);
      if (
        !Number.isInteger(accepted) ||
        !Number.isInteger(rejected) ||
        accepted < 0 ||
        rejected < 0
      ) {
        setError('Enter whole numbers of units received or rejected.');
        return;
      }
      if (accepted + rejected === 0) continue;
      const unitCostKobo = nairaToKobo(row.unitCost);
      if (unitCostKobo === null || unitCostKobo <= 0) {
        setError('Enter the actual purchase price per unit for each received line.');
        return;
      }
      if (rejected > 0 && row.rejectionReason.trim().length < 3) {
        setError('Explain why goods were damaged, missing or rejected.');
        return;
      }
      if (row.medicine && accepted > 0) {
        if (!row.batchNumber.trim()) {
          setError('Enter a batch number for every medicine received.');
          return;
        }
        if (!row.expiryDate) {
          setError('Enter an expiry date for every medicine received.');
          return;
        }
      }
      items.push({
        purchaseOrderItemId: row.purchaseOrderItemId,
        quantityReceived: accepted,
        quantityRejected: rejected,
        rejectionReason: rejected > 0 ? row.rejectionReason.trim() : undefined,
        unitCostKobo,
        batchNumber: row.batchNumber.trim() || null,
        manufacturingDate: row.manufacturingDate || undefined,
        expiryDate: row.expiryDate || undefined,
      });
    }
    if (items.length === 0) {
      setError('Enter a received or rejected quantity on at least one line.');
      return;
    }
    setBusy(true);
    try {
      const receipt = await api.request<{
        receipt: GoodsReceiptDetail;
        purchase: PurchaseOrderDetail;
      }>(`/api/purchases/${purchase.id}/receipts`, 'POST', {
        operationId: randomId(),
        receivedDate,
        notes: notes.trim() || undefined,
        items,
      });
      setResult(receipt.receipt);
      notify('Goods received. Stock and supplier balance updated.', 'success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The delivery could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  const data = purchase;

  if (result) {
    return (
      <div className="inventory-workspace">
        <BackLink to={`/purchases/${purchase.id}`}>Back to purchase</BackLink>
        <PageHeading
          eyebrow="Goods receiving"
          title={`${result.receiptNumber} recorded`}
          description="The receipt is atomic: stock, batches and the supplier balance were updated together."
        />
        <section className="card inventory-card">
          <div className="inventory-metrics">
            <div className="inventory-metric green">
              <span className="subtle-label">Accepted value</span>
              <strong>{formatMoney(result.receivedValueKobo)}</strong>
            </div>
            <div className="inventory-metric amber">
              <span className="subtle-label">Rejected units</span>
              <strong>{result.totalRejectedBaseQuantity}</strong>
            </div>
            <div className="inventory-metric">
              <span className="subtle-label">Order status now</span>
              <strong>
                <PurchaseStatusBadge status={data.status} />
              </strong>
            </div>
          </div>
          <div className="button-row">
            <Link className="button button-primary" to={`/purchases/${purchase.id}`}>
              <PackageCheck size={16} /> Back to purchase
            </Link>
            <Link className="button button-secondary" to="/purchases/receipts">
              View all receipts
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (data.status === 'cancelled') {
    return <ErrorBlock message="A cancelled purchase cannot receive goods." />;
  }
  if (pendingLines.length === 0) {
    return (
      <div className="inventory-workspace">
        <BackLink to={`/purchases/${purchase.id}`}>Back to purchase</BackLink>
        <section className="card inventory-card">
          <div className="inventory-note">
            <strong>Everything has been received</strong>
            <p>
              This purchase order has no outstanding quantities. Duplicate receiving is prevented by
              the backend.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="inventory-workspace">
      <BackLink to={`/purchases/${purchase.id}`}>Back to purchase</BackLink>
      <PageHeading
        eyebrow="Goods receiving"
        title={`Receive against ${data.referenceNumber}`}
        description={`${data.supplierName} · ${pendingLines.length} line${pendingLines.length === 1 ? '' : 's'} still outstanding. Only accepted quantities enter sellable stock.`}
      />
      <FormError message={error} />
      <form className="card inventory-form" onSubmit={(event) => void submit(event)}>
        <section className="form-section">
          <div className="form-two-columns">
            <label className="field-label">
              Delivery date
              <input
                type="date"
                max={today()}
                value={receivedDate}
                onChange={(event) => setReceivedDate(event.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Delivery notes
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="e.g. Delivered by van, two cartons opened"
              />
            </label>
          </div>
        </section>

        {pendingLines.map((line) => {
          const draft = rows.find((row) => row.purchaseOrderItemId === line.id);
          if (!draft) return null;
          return (
            <section className="form-section" key={line.id}>
              <div className="card-heading">
                <div>
                  <h2>{line.productName}</h2>
                  <p>
                    Ordered {line.quantity} {line.unitName} · already received{' '}
                    {line.receivedQuantity} · {line.pendingQuantity} still pending (
                    {line.baseQuantity - line.receivedBaseQuantity} base{' '}
                    {line.baseQuantity === 1 ? 'unit' : 'units'})
                  </p>
                </div>
                {line.productType === 'medicine' && (
                  <span className="status-pill status-amber">Batch &amp; expiry required</span>
                )}
              </div>
              <div className="form-two-columns">
                <label className="field-label">
                  Accepted quantity ({line.unitName})
                  <input
                    type="number"
                    min={0}
                    max={line.pendingQuantity}
                    step={1}
                    value={draft.accepted}
                    onChange={(event) => update(line.id, { accepted: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  Damaged / missing quantity
                  <input
                    type="number"
                    min={0}
                    max={line.pendingQuantity}
                    step={1}
                    value={draft.rejected}
                    onChange={(event) => update(line.id, { rejected: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  Actual unit price (₦)
                  <input
                    inputMode="decimal"
                    value={draft.unitCost}
                    onChange={(event) => update(line.id, { unitCost: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  Rejection reason
                  <input
                    value={draft.rejectionReason}
                    disabled={Number(draft.rejected) === 0}
                    onChange={(event) => update(line.id, { rejectionReason: event.target.value })}
                    placeholder="Damaged, short delivery, expired…"
                  />
                </label>
                <label className="field-label">
                  Batch number {line.productType === 'medicine' ? '' : '(optional)'}
                  <input
                    value={draft.batchNumber}
                    onChange={(event) => update(line.id, { batchNumber: event.target.value })}
                    placeholder="e.g. AMOX-2601"
                  />
                </label>
                <label className="field-label">
                  Manufacturing date
                  <input
                    type="date"
                    value={draft.manufacturingDate}
                    onChange={(event) => update(line.id, { manufacturingDate: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  Expiry date {line.productType === 'medicine' ? '' : '(optional)'}
                  <input
                    type="date"
                    min={today()}
                    value={draft.expiryDate}
                    onChange={(event) => update(line.id, { expiryDate: event.target.value })}
                  />
                </label>
                <div className="conversion-preview">
                  <span className="small muted">Accepted in base units</span>
                  <strong>
                    {(Number(draft.accepted || 0) * line.conversionFactor).toLocaleString()} base
                    units
                  </strong>
                  <span className="small muted">
                    Previous delivery: {formatDate(data.receipts[0]?.receivedDate)}
                  </span>
                </div>
              </div>
            </section>
          );
        })}

        <div className="form-section">
          <div className="inventory-note">
            <strong>What happens when you save</strong>
            <p>
              The delivery is written in one database transaction. Accepted quantities create stock
              movements and batches; rejected quantities do not. Batch cost and expiry mismatches
              are refused, and expired medicine can never enter sellable stock.
            </p>
          </div>
        </div>

        <div className="form-actions">
          <Link className="button button-secondary" to={`/purchases/${purchase.id}`}>
            Cancel
          </Link>
          <Button type="submit" busy={busy}>
            <CheckCircle2 size={16} /> Record delivery
          </Button>
        </div>
      </form>
    </div>
  );
}
