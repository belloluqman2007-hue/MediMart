import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, PackagePlus, Save } from 'lucide-react';
import type {
  Paginated,
  ProductDetail,
  StockReceiveInput,
  SupplierSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, PageHeading } from '../../components/ui';
import { addDaysIso, formatMoney, nairaToKobo, today, useAsync, useProductOptions } from './lib';
import { ErrorBlock, Field, LoadingBlock } from './shared';

type Receipt = {
  movement: { id: string; quantity: number; newBalance: number; batchNumber: string | null };
  product: { id: string; name: string; stockQuantity: number; baseUnitSymbol: string };
};

export function StockReceivePage() {
  const { api, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const [productSearch, setProductSearch] = useState('');
  const [productId, setProductId] = useState(params.get('productId') ?? '');
  const [quantity, setQuantity] = useState('1');
  const [unitId, setUnitId] = useState('');
  const [unitCost, setUnitCost] = useState('0.00');
  const [supplierId, setSupplierId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [manufacturingDate, setManufacturingDate] = useState('');
  const [expiryDate, setExpiryDate] = useState(addDaysIso(365));
  const [reason, setReason] = useState('Stock received from supplier');
  const [referenceId, setReferenceId] = useState('');
  const [openingStock, setOpeningStock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const products = useProductOptions(productSearch);
  const suppliers = useAsync(
    () => api.request<Paginated<SupplierSummary>>('/api/suppliers?status=active&pageSize=100'),
    [],
  );
  const product = useAsync(
    () =>
      productId ? api.request<ProductDetail>(`/api/products/${productId}`) : Promise.resolve(null),
    [productId],
  );
  const detail = product.data;
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
  const submittedQuantity = Number(quantity);
  const baseQuantity =
    Number.isInteger(submittedQuantity) && submittedQuantity > 0 ? submittedQuantity * factor : 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setReceipt(null);
    if (!detail) {
      setError('Choose a product first.');
      return;
    }
    const unitCostKobo = nairaToKobo(unitCost);
    if (unitCostKobo === null) {
      setError('Enter the unit cost in naira with at most two decimal places.');
      return;
    }
    const payload: StockReceiveInput = {
      productId: detail.id,
      quantity: submittedQuantity,
      unitId: activeUnitId,
      unitCostKobo,
      supplierId: supplierId || null,
      reason,
      referenceId: referenceId || null,
      batchNumber: batchNumber || null,
      manufacturingDate: manufacturingDate || null,
      expiryDate: expiryDate || null,
      movementType: openingStock ? 'opening_stock' : 'stock_received',
    };
    setBusy(true);
    try {
      const result = await api.request<Receipt>('/api/stock/receive', 'POST', payload);
      setReceipt(result);
      notify(`${result.movement.quantity} base units received.`, 'success');
      setBatchNumber('');
      setReferenceId('');
      setManufacturingDate('');
      setQuantity('1');
      product.reload();
      products.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Receive stock"
        description="Record a delivery into a batch. Stock, batch quantity, and the ledger update together."
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
            <h2>What arrived?</h2>
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
                    if (event.target.value) setOpeningStock(false);
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
                · Reorder at {detail.reorderLevel} ·{' '}
                {detail.isExpiryTracked ? 'Expiry tracking is on' : 'No expiry tracking'}
              </p>
            )}
          </div>

          <div className="form-section">
            <h2>Quantity and cost</h2>
            <div className="form-two-columns">
              <Field
                label="Quantity received"
                error={
                  !Number.isInteger(submittedQuantity) || submittedQuantity < 1
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
              <Field label="Unit received in">
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
              <Field
                label="Cost per unit (₦)"
                hint="Cost of one selected unit, not the whole delivery."
              >
                <input
                  inputMode="decimal"
                  value={unitCost}
                  onChange={(event) => setUnitCost(event.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Supplier">
                <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                  <option value="">No supplier / not recorded</option>
                  {(suppliers.data?.items ?? []).map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference (invoice or waybill)">
                <input
                  value={referenceId}
                  onChange={(event) => setReferenceId(event.target.value)}
                  maxLength={64}
                />
              </Field>
              <Field label="Reason" hint="Recorded on the stock ledger entry.">
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                />
              </Field>
            </div>
            <p className="inventory-note">
              {baseQuantity > 0 && Number.isInteger(baseQuantity) ? (
                <>
                  This adds <strong>{baseQuantity}</strong> {detail?.baseUnitSymbol ?? 'base units'}{' '}
                  to stock. Delivery cost{' '}
                  {formatMoney((nairaToKobo(unitCost) ?? 0) * (Number(quantity) || 0))}.
                </>
              ) : (
                'Enter a whole quantity to see the base-unit conversion.'
              )}
            </p>
          </div>

          <div className="form-section">
            <h2>Batch and expiry</h2>
            <div className="form-two-columns">
              <Field
                label="Batch number"
                hint={
                  detail?.isExpiryTracked ? 'Required for expiry-tracked products.' : 'Optional'
                }
              >
                <input
                  value={batchNumber}
                  onChange={(event) => setBatchNumber(event.target.value)}
                  maxLength={64}
                />
              </Field>
              <Field label="Manufacturing date">
                <input
                  type="date"
                  value={manufacturingDate}
                  max={today()}
                  onChange={(event) => setManufacturingDate(event.target.value)}
                />
              </Field>
              <Field
                label="Expiry date"
                hint={detail?.isExpiryTracked ? 'Required. Past dates are rejected.' : 'Optional'}
              >
                <input
                  type="date"
                  value={expiryDate}
                  min={today()}
                  onChange={(event) => setExpiryDate(event.target.value)}
                />
              </Field>
              <Field
                label="Ledger type"
                hint="Opening stock only applies before any other movement."
              >
                <select
                  value={openingStock ? 'opening' : 'received'}
                  onChange={(event) => setOpeningStock(event.target.value === 'opening')}
                >
                  <option value="received">Stock received</option>
                  <option value="opening">Opening stock</option>
                </select>
              </Field>
            </div>
          </div>

          <FormError message={error} />
          <div className="form-actions">
            <Link to="/inventory/products" className="button button-secondary">
              Cancel
            </Link>
            <Button type="submit" busy={busy} disabled={!detail}>
              <Save size={16} /> Record receipt
            </Button>
          </div>
        </form>

        <aside className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>Receipt summary</h2>
              <p>Confirmed only after the server accepts it.</p>
            </div>
          </div>
          {receipt ? (
            <div className="receipt-summary">
              <span className="receipt-check">
                <CheckCircle2 size={26} />
              </span>
              <h3>Stock received</h3>
              <p>
                {receipt.product.name} now holds{' '}
                <strong>
                  {receipt.product.stockQuantity} {receipt.product.baseUnitSymbol}
                </strong>
                .
              </p>
              <p className="muted small">
                Ledger entry added {receipt.movement.quantity} ·{' '}
                {receipt.movement.batchNumber
                  ? `batch ${receipt.movement.batchNumber}`
                  : 'no batch'}
              </p>
              <Button variant="secondary" onClick={() => setReceipt(null)}>
                <PackagePlus size={15} /> Receive another
              </Button>
            </div>
          ) : (
            <div className="empty-small">
              <PackagePlus size={20} />
              Nothing recorded yet. Each receipt is written atomically with its batch and ledger
              entry, and appears in movement history immediately.
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
