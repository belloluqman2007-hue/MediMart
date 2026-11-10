import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Save, Trash2 } from 'lucide-react';
import {
  hasPermission,
  type Paginated,
  type ProductDetail,
  type ProductSummary,
  type ProductUnitSummary,
  type PurchaseOrderDetail,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, PageHeading } from '../../components/ui';
import { BackLink, Field, LoadingBlock, ErrorBlock } from '../inventory/shared';
import {
  buildQuery,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  randomId,
  today,
  useAsync,
} from './lib';

type UnitOption = ProductUnitSummary;

type LineDraft = {
  key: string;
  productId: string;
  productName: string;
  unitId: string;
  units: UnitOption[];
  quantity: string;
  unitCost: string;
  lineDiscount: string;
};

const blankLine = (): LineDraft => ({
  key: randomId(),
  productId: '',
  productName: '',
  unitId: '',
  units: [],
  quantity: '1',
  unitCost: '0.00',
  lineDiscount: '0.00',
});

export function PurchaseFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { api } = useApp();
  const suppliers = useAsync(
    () =>
      api.request<Paginated<{ id: string; name: string; status: string }>>(
        '/api/suppliers?pageSize=100&status=active',
      ),
    [],
  );
  const products = useAsync(
    () =>
      api.request<Paginated<ProductSummary>>(
        `/api/products${buildQuery({ pageSize: 100, status: 'active' })}`,
      ),
    [],
  );
  const existing = useAsync(
    () =>
      editing ? api.request<PurchaseOrderDetail>(`/api/purchases/${id}`) : Promise.resolve(null),
    [editing, id],
  );

  if (existing.loading && !existing.data) return <LoadingBlock label="Loading purchase…" />;
  if (existing.error) return <ErrorBlock message={existing.error} onRetry={existing.reload} />;

  return (
    <PurchaseFormBody
      key={id ?? 'new'}
      purchase={existing.data}
      supplierItems={suppliers.data?.items ?? []}
      productItems={products.data?.items ?? []}
      productTotal={products.data?.total ?? 0}
    />
  );
}

type FormProps = {
  purchase: PurchaseOrderDetail | null;
  supplierItems: Array<{ id: string; name: string }>;
  productItems: ProductSummary[];
  productTotal: number;
};

function PurchaseFormBody({ purchase, supplierItems, productItems, productTotal }: FormProps) {
  const { api, user, notify } = useApp();
  const navigate = useNavigate();
  const editing = Boolean(purchase);
  const canCreate = Boolean(user && hasPermission(user.permissions, 'purchases.create'));
  const canEdit = Boolean(user && hasPermission(user.permissions, 'purchases.edit'));

  const [supplierId, setSupplierId] = useState(purchase?.supplierId ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    purchase
      ? purchase.items.map((item) => ({
          key: item.id,
          productId: item.productId,
          productName: item.productName,
          unitId: item.unitId,
          units: [
            {
              unitId: item.unitId,
              code: '',
              name: item.unitName,
              symbol: item.unitSymbol,
              factor: item.conversionFactor,
            },
          ],
          quantity: String(item.quantity),
          unitCost: koboToNairaInput(item.unitCostKobo),
          lineDiscount: koboToNairaInput(item.lineDiscountKobo),
        }))
      : [blankLine()],
  );
  const [orderDiscount, setOrderDiscount] = useState(
    purchase ? koboToNairaInput(purchase.orderDiscountKobo) : '0.00',
  );
  const [discountReason, setDiscountReason] = useState(purchase?.discountReason ?? '');
  const [charges, setCharges] = useState(
    purchase ? koboToNairaInput(purchase.additionalChargesKobo) : '0.00',
  );
  const [chargesReason, setChargesReason] = useState(purchase?.additionalChargesReason ?? '');
  const [expectedDate, setExpectedDate] = useState(purchase?.expectedDeliveryDate ?? '');
  const [notes, setNotes] = useState(purchase?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!purchase) return;
    let active = true;
    void Promise.all(
      [...new Set(purchase.items.map((item) => item.productId))].map((productId) =>
        api.request<ProductDetail>(`/api/products/${productId}`),
      ),
    )
      .then((details) => {
        if (!active) return;
        const byId = new Map(details.map((detail) => [detail.id, detail]));
        setLines((current) =>
          current.map((line) => {
            const detail = byId.get(line.productId);
            if (!detail) return line;
            return { ...line, units: unitsFor(detail), productName: detail.name };
          }),
        );
      })
      .catch(() => {
        /* Existing line units remain usable if a product detail cannot be refreshed. */
      });
    return () => {
      active = false;
    };
  }, [api, purchase]);

  const productById = useMemo(
    () => new Map(productItems.map((product) => [product.id, product])),
    [productItems],
  );

  async function selectProduct(key: string, productId: string) {
    const summary = productById.get(productId);
    if (!summary) {
      setLines((current) =>
        current.map((line) => (line.key === key ? { ...line, productId } : line)),
      );
      return;
    }
    try {
      const detail = await api.request<ProductDetail>(`/api/products/${summary.id}`);
      const units = unitsFor(detail);
      const base = units.find((unit) => unit.factor === 1) ?? units[0]!;
      setLines((current) =>
        current.map((line) =>
          line.key === key
            ? {
                ...line,
                productId,
                productName: detail.name,
                units,
                unitId: base.unitId,
                unitCost: koboToNairaInput(detail.purchaseCostKobo * base.factor),
              }
            : line,
        ),
      );
    } catch {
      setLines((current) =>
        current.map((line) =>
          line.key === key
            ? {
                ...line,
                productId,
                productName: summary.name,
                units: [
                  {
                    unitId: summary.baseUnitId,
                    code: '',
                    name: summary.baseUnitName,
                    symbol: summary.baseUnitSymbol,
                    factor: 1,
                  },
                ],
                unitId: summary.baseUnitId,
                unitCost: koboToNairaInput(summary.purchaseCostKobo),
              }
            : line,
        ),
      );
    }
  }

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function selectUnit(key: string, unitId: string) {
    const line = lines.find((entry) => entry.key === key);
    if (!line) return;
    const unit = line.units.find((entry) => entry.unitId === unitId);
    const product = productById.get(line.productId);
    const suggested = product && unit ? product.purchaseCostKobo * unit.factor : null;
    updateLine(key, {
      unitId,
      ...(suggested !== null ? { unitCost: koboToNairaInput(suggested) } : {}),
    });
  }

  const preview = useMemo(() => {
    let subtotal = 0;
    let lineDiscounts = 0;
    for (const line of lines) {
      const quantity = Number(line.quantity);
      const cost = nairaToKobo(line.unitCost) ?? 0;
      const discount = nairaToKobo(line.lineDiscount) ?? 0;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      subtotal += quantity * cost;
      lineDiscounts += discount;
    }
    const order = nairaToKobo(orderDiscount) ?? 0;
    const extra = nairaToKobo(charges) ?? 0;
    return {
      subtotal,
      lineDiscounts,
      orderDiscount: order,
      charges: extra,
      total: subtotal - lineDiscounts - order + extra,
    };
  }, [lines, orderDiscount, charges]);

  async function save(event: FormEvent | null, targetStatus: 'draft' | 'ordered') {
    event?.preventDefault();
    setError(null);
    if (!supplierId) {
      setError('Choose a supplier for this purchase.');
      return;
    }
    const items = [];
    for (const line of lines) {
      if (!line.productId || !line.unitId) {
        setError('Choose a product and unit on every line, or remove the empty line.');
        return;
      }
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        setError('Every quantity must be a whole number greater than zero.');
        return;
      }
      const unitCostKobo = nairaToKobo(line.unitCost);
      const lineDiscountKobo = nairaToKobo(line.lineDiscount);
      if (unitCostKobo === null || lineCostInvalid(unitCostKobo, quantity)) {
        setError('Enter a valid purchase price in naira for every line.');
        return;
      }
      if (lineDiscountKobo === null || lineDiscountKobo > unitCostKobo * quantity) {
        setError('A line discount cannot be more than that line’s subtotal.');
        return;
      }
      items.push({
        productId: line.productId,
        unitId: line.unitId,
        quantity,
        unitCostKobo,
        lineDiscountKobo,
      });
    }
    if (items.length === 0) {
      setError('Add at least one product to the purchase.');
      return;
    }
    const orderDiscountKobo = nairaToKobo(orderDiscount);
    const additionalChargesKobo = nairaToKobo(charges);
    if (orderDiscountKobo === null || additionalChargesKobo === null) {
      setError('Enter discount and additional charges as valid naira amounts.');
      return;
    }
    if (orderDiscountKobo > preview.subtotal - preview.lineDiscounts) {
      setError('The order discount cannot exceed the value of the goods.');
      return;
    }
    const payload = {
      supplierId,
      items,
      orderDiscountKobo,
      discountReason: discountReason.trim() || undefined,
      additionalChargesKobo,
      additionalChargesReason: chargesReason.trim() || undefined,
      expectedDeliveryDate: expectedDate || undefined,
      notes: notes.trim() || undefined,
    };
    setBusy(true);
    try {
      if (editing && purchase) {
        await api.request(`/api/purchases/${purchase.id}`, 'PUT', {
          ...payload,
          version: purchase.version,
        });
        notify('Purchase order updated.', 'success');
        navigate(`/purchases/${purchase.id}`);
      } else {
        const created = await api.request<PurchaseOrderDetail>('/api/purchases', 'POST', {
          ...payload,
          operationId: randomId(),
          status: targetStatus,
        });
        notify(
          targetStatus === 'ordered' ? 'Purchase order placed.' : 'Draft purchase saved.',
          'success',
        );
        navigate(`/purchases/${created.id}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The purchase could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (!canCreate && !editing)
    return <ErrorBlock message="You do not have permission to create purchase orders." />;
  if (!canEdit && editing)
    return <ErrorBlock message="You do not have permission to edit purchase orders." />;
  if (editing && purchase && purchase.status !== 'draft')
    return (
      <ErrorBlock message="Only a draft purchase can be edited. This order has already been placed or received." />
    );

  return (
    <div className="inventory-workspace">
      <BackLink to={purchase ? `/purchases/${purchase.id}` : '/purchases'}>
        Back to purchases
      </BackLink>
      <PageHeading
        eyebrow="Purchasing"
        title={editing ? 'Edit draft purchase' : 'New purchase order'}
        description="Each line uses the product's purchase unit. Prices are entered in naira and stored as integer kobo."
        action={
          <Button variant="secondary" onClick={() => void save(null, 'draft')} busy={busy}>
            <Save size={15} /> Save draft
          </Button>
        }
      />
      <FormError message={error} />
      <form className="card inventory-form" onSubmit={(event) => void save(event, 'ordered')}>
        <section className="form-section">
          <h2>Supplier and delivery</h2>
          <div className="form-two-columns">
            <Field label="Supplier">
              <select
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                required
              >
                <option value="">Choose an active supplier…</option>
                {supplierItems.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Expected delivery date" hint="Optional">
              <input
                type="date"
                min={today()}
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="form-section">
          <div className="card-heading">
            <div>
              <h2>Products</h2>
              <p>
                Quantities are whole units. The supplier's pack or carton sizes come from inventory.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLines((current) => [...current, blankLine()])}
            >
              <Plus size={15} /> Add line
            </Button>
          </div>
          {productTotal > productItems.length && (
            <p className="inventory-note small">
              Showing the first {productItems.length} active products. Use inventory search to check
              the full catalogue.
            </p>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Unit</th>
                  <th>Quantity</th>
                  <th>Unit price (₦)</th>
                  <th>Line discount (₦)</th>
                  <th>Line total</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const quantity = Number(line.quantity);
                  const cost = nairaToKobo(line.unitCost) ?? 0;
                  const discount = nairaToKobo(line.lineDiscount) ?? 0;
                  const lineTotal =
                    Number.isFinite(quantity) && quantity > 0 ? quantity * cost - discount : 0;
                  return (
                    <tr key={line.key}>
                      <td>
                        <select
                          aria-label="Product"
                          value={line.productId}
                          onChange={(event) => void selectProduct(line.key, event.target.value)}
                        >
                          <option value="">Choose product…</option>
                          {(productItems ?? []).map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name} · {product.baseUnitSymbol}
                            </option>
                          ))}
                          {line.productId &&
                            !(productItems ?? []).some(
                              (product) => product.id === line.productId,
                            ) && <option value={line.productId}>{line.productName}</option>}
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label="Purchase unit"
                          value={line.unitId}
                          disabled={!line.productId}
                          onChange={(event) => selectUnit(line.key, event.target.value)}
                        >
                          {line.units.map((unit) => (
                            <option key={unit.unitId} value={unit.unitId}>
                              {unit.name} ({unit.factor}x)
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label="Quantity"
                          type="number"
                          min={1}
                          step={1}
                          value={line.quantity}
                          onChange={(event) =>
                            updateLine(line.key, { quantity: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Unit purchase price in naira"
                          inputMode="decimal"
                          value={line.unitCost}
                          onChange={(event) =>
                            updateLine(line.key, { unitCost: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Line discount in naira"
                          inputMode="decimal"
                          value={line.lineDiscount}
                          onChange={(event) =>
                            updateLine(line.key, { lineDiscount: event.target.value })
                          }
                        />
                      </td>
                      <td>{formatMoney(lineTotal)}</td>
                      <td>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Remove line"
                          disabled={lines.length === 1}
                          onClick={() =>
                            setLines((current) => current.filter((entry) => entry.key !== line.key))
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="form-section">
          <h2>Discounts, charges and notes</h2>
          <div className="form-two-columns">
            <Field label="Order discount (₦)" hint="Requires a reason">
              <input
                inputMode="decimal"
                value={orderDiscount}
                onChange={(event) => setOrderDiscount(event.target.value)}
              />
            </Field>
            <Field label="Discount reason">
              <input
                value={discountReason}
                onChange={(event) => setDiscountReason(event.target.value)}
                placeholder="e.g. Negotiated wholesale discount"
              />
            </Field>
            <Field label="Additional charges (₦)" hint="Delivery, handling or other costs">
              <input
                inputMode="decimal"
                value={charges}
                onChange={(event) => setCharges(event.target.value)}
              />
            </Field>
            <Field label="Charge description">
              <input
                value={chargesReason}
                onChange={(event) => setChargesReason(event.target.value)}
                placeholder="e.g. Delivery to the shop"
              />
            </Field>
          </div>
          <Field label="Notes" hint="Optional delivery instructions">
            <textarea
              className="inventory-textarea"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </section>

        <div className="form-section purchase-totals">
          <div className="detail-list">
            <div>
              <span>Goods subtotal</span>
              <strong>{formatMoney(preview.subtotal)}</strong>
            </div>
            <div>
              <span>Line discounts</span>
              <strong>{formatMoney(preview.lineDiscounts)}</strong>
            </div>
            <div>
              <span>Order discount</span>
              <strong>{formatMoney(preview.orderDiscount)}</strong>
            </div>
            <div>
              <span>Additional charges</span>
              <strong>{formatMoney(preview.charges)}</strong>
            </div>
            <div className="grand-row">
              <span>Order total</span>
              <strong>{formatMoney(preview.total)}</strong>
            </div>
          </div>
          <p className="small muted">
            This total is a commitment, not a payment. No stock or payable is recorded until goods
            are received.
          </p>
        </div>

        <div className="form-actions">
          <Link
            className="button button-secondary"
            to={purchase ? `/purchases/${purchase.id}` : '/purchases'}
          >
            Cancel
          </Link>
          <Button type="submit" busy={busy}>
            {editing ? <Save size={15} /> : <Plus size={15} />}
            {editing ? 'Save changes' : 'Save and mark as ordered'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function unitsFor(detail: ProductDetail): UnitOption[] {
  const base: UnitOption = {
    unitId: detail.baseUnitId,
    code: 'base',
    name: detail.baseUnitName,
    symbol: detail.baseUnitSymbol,
    factor: 1,
  };
  const configured = detail.units.filter((unit) => unit.unitId !== detail.baseUnitId);
  return [base, ...configured].sort((a, b) => a.factor - b.factor);
}

function lineCostInvalid(unitCostKobo: number, quantity: number) {
  return !Number.isInteger(unitCostKobo) || unitCostKobo <= 0 || unitCostKobo * quantity <= 0;
}
