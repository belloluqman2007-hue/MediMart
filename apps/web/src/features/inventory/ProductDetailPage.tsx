import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Boxes,
  CalendarClock,
  Layers3,
  Pencil,
  Power,
  PackagePlus,
  Scale,
  ShieldAlert,
} from 'lucide-react';
import {
  hasPermission,
  productTypeLabels,
  stockMovementLabels,
  type FefoAllocation,
  type ProductDetail,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Badge, Button, PageHeading } from '../../components/ui';
import { formatDate, formatDateTime, formatMoney, useAsync } from './lib';
import {
  BackLink,
  BatchStatus,
  ConfirmDialog,
  ErrorBlock,
  LoadingBlock,
  StatusBadge,
} from './shared';

export function ProductDetailPage() {
  const { id } = useParams();
  const { api, user, notify } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fefoQuantity, setFefoQuantity] = useState('1');
  const [fefo, setFefo] = useState<FefoAllocation | null>(null);
  const [fefoError, setFefoError] = useState<string | null>(null);
  const product = useAsync(() => api.request<ProductDetail>(`/api/products/${id}`), [id]);
  const data = product.data;
  const canEdit = Boolean(user && hasPermission(user.permissions, 'products.edit'));
  const canToggle = Boolean(user && hasPermission(user.permissions, 'products.deactivate'));
  const canReceive = Boolean(user && hasPermission(user.permissions, 'stock.receive'));
  const canAdjust = Boolean(user && hasPermission(user.permissions, 'stock.adjust'));
  const canSeeFefo = Boolean(user && hasPermission(user.permissions, 'stock.view'));
  const activeBatches = data?.batches.filter((batch) => batch.quantityRemaining > 0) ?? [];

  async function toggleStatus() {
    if (!data) return;
    setBusy(true);
    try {
      await api.request(
        `/api/products/${data.id}/${data.status === 'active' ? 'deactivate' : 'activate'}`,
        'POST',
        {},
      );
      notify(data.status === 'active' ? 'Product deactivated.' : 'Product reactivated.', 'success');
      setConfirming(false);
      product.reload();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function previewFefo() {
    setFefoError(null);
    const quantity = Number(fefoQuantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setFefoError('Enter a whole quantity of base units.');
      return;
    }
    try {
      setFefo(await api.request<FefoAllocation>(`/api/products/${id}/fefo?quantity=${quantity}`));
    } catch (error) {
      setFefoError(errorMessage(error));
    }
  }

  if (product.loading && !data) return <LoadingBlock label="Loading product…" />;
  if (product.error) return <ErrorBlock message={product.error} onRetry={product.reload} />;
  if (!data) return null;

  return (
    <>
      <BackLink to="/inventory/products">Back to products</BackLink>
      <PageHeading
        eyebrow={productTypeLabels[data.productType]}
        title={data.name}
        description={
          [data.genericName, data.brand, data.manufacturer].filter(Boolean).join(' · ') ||
          'Product record'
        }
        action={
          <>
            {canReceive && data.status === 'active' && (
              <Link
                to={`/inventory/receive?productId=${data.id}`}
                className="button button-secondary"
              >
                <PackagePlus size={16} /> Receive stock
              </Link>
            )}
            {canAdjust && (
              <Link
                to={`/inventory/adjustments?productId=${data.id}`}
                className="button button-secondary"
              >
                <Scale size={16} /> Adjust stock
              </Link>
            )}
            {canEdit && (
              <Link to={`/inventory/products/${data.id}/edit`} className="button button-primary">
                <Pencil size={16} /> Edit product
              </Link>
            )}
          </>
        }
      />
      <section className="inventory-detail-grid">
        <div className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>Stock position</h2>
              <p>
                Counted in {data.baseUnitName.toLowerCase()}s ({data.baseUnitSymbol})
              </p>
            </div>
            <StatusBadge tone={data.status === 'active' ? 'green' : 'neutral'}>
              {data.status === 'active' ? 'Active' : 'Inactive'}
            </StatusBadge>
          </div>
          <div className="stock-hero">
            <strong>
              {data.stockQuantity} <small>{data.baseUnitSymbol}</small>
            </strong>
            <span className="muted">
              Cost value {formatMoney(data.stockValueCostKobo)} · Reorder at {data.reorderLevel}
            </span>
            <div className="stock-flags">
              {data.stockQuantity === 0 && <StatusBadge tone="red">Out of stock</StatusBadge>}
              {data.stockQuantity > 0 && data.stockQuantity <= data.reorderLevel && (
                <StatusBadge tone="amber">Below reorder level</StatusBadge>
              )}
              {activeBatches.some((batch) => batch.status === 'expired') && (
                <StatusBadge tone="red">
                  <ShieldAlert size={12} /> Expired stock on hand
                </StatusBadge>
              )}
              {activeBatches.some((batch) => batch.status === 'expiring') && (
                <StatusBadge tone="amber">
                  <CalendarClock size={12} /> Near expiry
                </StatusBadge>
              )}
            </div>
          </div>
          <dl className="detail-list">
            <div>
              <dt>SKU</dt>
              <dd>{data.sku || '—'}</dd>
            </div>
            <div>
              <dt>Barcode</dt>
              <dd>{data.barcode || '—'}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{data.categoryName || 'Uncategorised'}</dd>
            </div>
            <div>
              <dt>Purchase cost</dt>
              <dd>{formatMoney(data.purchaseCostKobo)}</dd>
            </div>
            <div>
              <dt>Selling price</dt>
              <dd>{formatMoney(data.sellingPriceKobo)}</dd>
            </div>
            <div>
              <dt>Expiry tracking</dt>
              <dd>{data.isExpiryTracked ? 'Batches with expiry dates' : 'No expiry tracking'}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                {formatDateTime(data.createdAt)}
                {data.createdByName ? ` · ${data.createdByName}` : ''}
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatDateTime(data.updatedAt)}</dd>
            </div>
          </dl>
          {data.description && <p className="detail-description">{data.description}</p>}
          {canToggle && (
            <Button
              variant={data.status === 'active' ? 'danger' : 'primary'}
              onClick={() => setConfirming(true)}
            >
              <Power size={15} />
              {data.status === 'active' ? 'Deactivate product' : 'Reactivate product'}
            </Button>
          )}
        </div>

        <div className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>Unit conversions</h2>
              <p>Stock is always stored in the base unit.</p>
            </div>
            <Badge>{data.units.length} configured</Badge>
          </div>
          <div className="conversion-summary">
            <div>
              <strong>1 {data.baseUnitSymbol}</strong>
              <span className="muted small">base unit</span>
            </div>
            {data.units.map((unit) => (
              <div key={unit.unitId}>
                <strong>
                  1 {unit.symbol} = {unit.factor} {data.baseUnitSymbol}
                </strong>
                <span className="muted small">{unit.name}</span>
              </div>
            ))}
            {data.units.length === 0 && (
              <p className="empty-small">
                No conversions yet. Edit the product to add packs or cartons.
              </p>
            )}
          </div>
          {canSeeFefo && data.isExpiryTracked && (
            <div className="fefo-panel">
              <h3>
                <Layers3 size={15} /> FEFO preview
              </h3>
              <p className="muted small">
                First Expired, First Out is the allocation order future sales will use. Expired
                batches are excluded.
              </p>
              <div className="fefo-form">
                <input
                  type="number"
                  min={1}
                  aria-label="Quantity for FEFO preview"
                  value={fefoQuantity}
                  onChange={(event) => setFefoQuantity(event.target.value)}
                />
                <Button variant="secondary" onClick={() => void previewFefo()}>
                  Preview
                </Button>
              </div>
              {fefoError && <p className="field-error">{fefoError}</p>}
              {fefo && (
                <div className="fefo-result">
                  <p className="small">
                    Allocatable {fefo.allocatableQuantity} of {fefo.requestedQuantity}{' '}
                    {data.baseUnitSymbol}
                  </p>
                  {fefo.allocations.length ? (
                    <ul>
                      {fefo.allocations.map((allocation) => (
                        <li key={allocation.batchId}>
                          <span>Batch {allocation.batchNumber}</span>
                          <span className="muted">
                            exp {formatDate(allocation.expiryDate)} · {allocation.quantity}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">No sellable batches available.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Batches</h2>
            <p>Each batch keeps its own quantity and expiry date.</p>
          </div>
          <Link className="text-link" to={`/inventory/batches?productId=${data.id}`}>
            Batch register
          </Link>
        </div>
        {data.batches.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Manufactured</th>
                  <th>Expiry</th>
                  <th className="numeric">Received</th>
                  <th className="numeric">Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.batchNumber}</td>
                    <td>{formatDate(batch.manufacturingDate)}</td>
                    <td>{formatDate(batch.expiryDate)}</td>
                    <td className="numeric">{batch.quantityReceived}</td>
                    <td className="numeric">{batch.quantityRemaining}</td>
                    <td>
                      <BatchStatus status={batch.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-small">
            No batches yet. Receiving stock creates the first batch for expiry-tracked products.
          </div>
        )}
      </section>

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Recent movements</h2>
            <p>The last ten changes to this product’s stock.</p>
          </div>
          <Link className="text-link" to={`/inventory/movements?productId=${data.id}`}>
            Full history
          </Link>
        </div>
        {data.recentMovements.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Movement</th>
                  <th>Batch</th>
                  <th className="numeric">Change</th>
                  <th className="numeric">Balance</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.recentMovements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="muted">{formatDateTime(movement.createdAt)}</td>
                    <td>{stockMovementLabels[movement.movementType]}</td>
                    <td>{movement.batchNumber || '—'}</td>
                    <td className={`numeric ${movement.quantity > 0 ? 'text-green' : 'text-red'}`}>
                      {movement.quantity > 0 ? '+' : ''}
                      {movement.quantity}
                    </td>
                    <td className="numeric">{movement.newBalance}</td>
                    <td className="muted">{movement.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-small">
            <Boxes size={16} /> No stock movements yet.
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title={data.status === 'active' ? 'Deactivate this product?' : 'Reactivate this product?'}
        message={
          data.status === 'active'
            ? 'The product stays in your records with all its history, but it cannot receive new stock until it is reactivated. Stock can still be written off.'
            : 'The product becomes available for stock receiving again.'
        }
        confirmLabel={data.status === 'active' ? 'Deactivate' : 'Reactivate'}
        danger={data.status === 'active'}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void toggleStatus()}
      />
    </>
  );
}
