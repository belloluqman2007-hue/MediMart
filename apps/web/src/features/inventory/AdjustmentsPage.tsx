import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Scale, ShieldAlert } from 'lucide-react';
import {
  hasPermission,
  stockMovementLabels,
  type ProductDetail,
  type StockAdjustmentInput,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, PageHeading } from '../../components/ui';
import { formatDate, useAsync, useProductOptions } from './lib';
import { ErrorBlock, Field, LoadingBlock, StatusBadge } from './shared';

type AdjustmentType =
  'adjustment_increase' | 'adjustment_decrease' | 'damaged' | 'expired' | 'correction';
type Result = {
  movement: { id: string; quantity: number; newBalance: number; movementType: AdjustmentType };
  product: { name: string; stockQuantity: number; baseUnitSymbol: string };
};

export function AdjustmentsPage() {
  const { api, user, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const [productSearch, setProductSearch] = useState('');
  const [productId, setProductId] = useState(params.get('productId') ?? '');
  const [batchId, setBatchId] = useState('');
  const [movementType, setMovementType] = useState<AdjustmentType>('adjustment_decrease');
  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease');
  const [quantity, setQuantity] = useState('1');
  const [unitId, setUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const products = useProductOptions(productSearch);
  const product = useAsync(
    () =>
      productId ? api.request<ProductDetail>(`/api/products/${productId}`) : Promise.resolve(null),
    [productId],
  );
  const detail = product.data;
  const canWriteOff = Boolean(user && hasPermission(user.permissions, 'stock.write_off'));
  const activeUnitId = unitId || detail?.baseUnitId || '';
  const units = useMemo(() => {
    if (!detail) return [];
    return [
      { id: detail.baseUnitId, label: `${detail.baseUnitName} (${detail.baseUnitSymbol}) — base` },
      ...detail.units.map((unit) => ({
        id: unit.unitId,
        label: `${unit.name} (1 = ${unit.factor} ${detail.baseUnitSymbol})`,
      })),
    ];
  }, [detail]);
  const factor = useMemo(() => {
    if (!detail) return 1;
    if (activeUnitId === detail.baseUnitId) return 1;
    return detail.units.find((unit) => unit.unitId === activeUnitId)?.factor ?? 1;
  }, [detail, activeUnitId]);
  const batches = useMemo(() => detail?.batches ?? [], [detail]);
  const activeBatchId = batches.some((batch) => batch.id === batchId) ? batchId : '';
  const selectedBatch = batches.find((batch) => batch.id === activeBatchId);
  const baseQuantity = Number(quantity) * factor;
  const decreases =
    movementType === 'adjustment_decrease' ||
    movementType === 'damaged' ||
    movementType === 'expired' ||
    (movementType === 'correction' && direction === 'decrease');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!detail) {
      setError('Choose a product first.');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Give a reason of at least three characters. Every adjustment must be explainable.');
      return;
    }
    const payload: StockAdjustmentInput = {
      productId: detail.id,
      batchId: activeBatchId || null,
      movementType,
      quantity: Number(quantity),
      unitId: activeUnitId,
      reason,
      referenceId: referenceId || null,
      ...(movementType === 'correction' ? { direction } : {}),
    };
    setBusy(true);
    try {
      const response = await api.request<Result>('/api/stock/adjust', 'POST', payload);
      setResult(response);
      notify('Stock adjustment recorded.', 'success');
      setReason('');
      setReferenceId('');
      setQuantity('1');
      product.reload();
      products.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const writeOffBlocked =
    (movementType === 'damaged' || movementType === 'expired') && !canWriteOff;

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Adjust stock"
        description="Corrections, damages, and write-offs always require a reason and a batch where batches exist."
        action={
          <Link to="/inventory/movements" className="button button-secondary">
            Movement history
          </Link>
        }
      />
      {product.error && <ErrorBlock message={product.error} onRetry={product.reload} />}
      <div className="inventory-detail-grid">
        <form className="card inventory-form" onSubmit={(event) => void submit(event)} noValidate>
          <div className="form-section">
            <h2>Which stock?</h2>
            <div className="form-two-columns">
              <Field label="Search products">
                <input
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  placeholder="Type to filter the catalogue"
                />
              </Field>
              <Field label="Product">
                <select
                  value={productId}
                  onChange={(event) => {
                    setProductId(event.target.value);
                    setUnitId('');
                    setParams(
                      (current) => {
                        const next = new URLSearchParams(current);
                        if (event.target.value) next.set('productId', event.target.value);
                        else next.delete('productId');
                        return next;
                      },
                      { replace: true },
                    );
                  }}
                  required
                >
                  <option value="">Choose a product</option>
                  {(products.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} — {item.stockQuantity} {item.baseUnitSymbol}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {products.loading && <LoadingBlock label="Loading products…" />}
            {detail && (
              <p className="inventory-note">
                On hand:{' '}
                <strong>
                  {detail.stockQuantity} {detail.baseUnitSymbol}
                </strong>{' '}
                · {batches.length} batch{batches.length === 1 ? '' : 'es'}
              </p>
            )}
          </div>

          <div className="form-section">
            <h2>Adjustment details</h2>
            <div className="form-two-columns">
              <Field label="Adjustment type">
                <select
                  value={movementType}
                  onChange={(event) => setMovementType(event.target.value as AdjustmentType)}
                >
                  <option value="adjustment_increase">Correction — increase</option>
                  <option value="adjustment_decrease">Correction — decrease</option>
                  <option value="damaged">Damaged stock</option>
                  <option value="expired">Expired stock</option>
                  <option value="correction">Stock correction (either direction)</option>
                </select>
              </Field>
              {movementType === 'correction' && (
                <Field label="Direction">
                  <select
                    value={direction}
                    onChange={(event) =>
                      setDirection(event.target.value as 'increase' | 'decrease')
                    }
                  >
                    <option value="decrease">Decrease stock</option>
                    <option value="increase">Increase stock</option>
                  </select>
                </Field>
              )}
              <Field
                label="Batch"
                hint={batches.length ? 'Required for batch-tracked stock.' : undefined}
              >
                <select value={activeBatchId} onChange={(event) => setBatchId(event.target.value)}>
                  <option value="">
                    {batches.length ? 'Choose a batch' : 'No batches for this product'}
                  </option>
                  {batches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.batchNumber} · {batch.quantityRemaining} left
                      {batch.expiryDate ? ` · exp ${formatDate(batch.expiryDate)}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Quantity"
                error={
                  !Number.isInteger(Number(quantity)) || Number(quantity) < 1
                    ? 'Enter a whole number of 1 or more.'
                    : undefined
                }
              >
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </Field>
              <Field label="Unit">
                <select value={activeUnitId} onChange={(event) => setUnitId(event.target.value)}>
                  {units.length ? (
                    units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label}
                      </option>
                    ))
                  ) : (
                    <option value="">Choose a product first</option>
                  )}
                </select>
              </Field>
              <Field label="Reference">
                <input
                  value={referenceId}
                  onChange={(event) => setReferenceId(event.target.value)}
                  maxLength={64}
                  placeholder="Optional"
                />
              </Field>
            </div>
            <Field label="Reason" hint="Required. Stored with the ledger entry and audit log.">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                placeholder="e.g. Recount found three damaged packs"
              />
            </Field>
            <p className="inventory-note">
              {Number.isInteger(baseQuantity) && baseQuantity > 0 ? (
                <>
                  {decreases ? 'Reduces' : 'Increases'} stock by <strong>{baseQuantity}</strong>{' '}
                  {detail?.baseUnitSymbol ?? 'base units'}
                  {selectedBatch
                    ? ` in batch ${selectedBatch.batchNumber} (${selectedBatch.quantityRemaining} available).`
                    : '.'}
                </>
              ) : (
                'Enter a whole quantity to preview the adjustment.'
              )}
            </p>
            {writeOffBlocked && (
              <div className="inventory-error" role="alert">
                <ShieldAlert size={18} />
                <div>
                  <strong>Write-off permission required</strong>
                  <p>
                    Your account can adjust stock but cannot write off damaged or expired stock.
                  </p>
                </div>
              </div>
            )}
          </div>

          <FormError message={error} />
          <div className="form-actions">
            <Link to="/inventory/products" className="button button-secondary">
              Cancel
            </Link>
            <Button type="submit" busy={busy} disabled={!detail || writeOffBlocked}>
              <Scale size={16} /> Record adjustment
            </Button>
          </div>
        </form>

        <aside className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>Adjustment summary</h2>
              <p>Negative stock is always refused by the server.</p>
            </div>
          </div>
          {result ? (
            <div className="receipt-summary">
              <span className="receipt-check">
                <CheckCircle2 size={26} />
              </span>
              <h3>{stockMovementLabels[result.movement.movementType]}</h3>
              <p>
                {result.product.name} now holds{' '}
                <strong>
                  {result.product.stockQuantity} {result.product.baseUnitSymbol}
                </strong>
                .
              </p>
              <p className="muted small">
                Ledger change {result.movement.quantity > 0 ? '+' : ''}
                {result.movement.quantity}
              </p>
              <Button variant="secondary" onClick={() => setResult(null)}>
                Record another
              </Button>
            </div>
          ) : (
            <div className="empty-small">
              <Scale size={20} />
              Adjustments are append-only. Previous stock records are never overwritten.
            </div>
          )}
          {detail && detail.batches.some((batch) => batch.status === 'expired') && (
            <div className="inventory-note">
              <StatusBadge tone="red">Expired batches</StatusBadge>
              <p className="small muted">
                Expired stock stays visible but is excluded from sale allocation. Write it off with
                the Expired stock adjustment type.
              </p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
