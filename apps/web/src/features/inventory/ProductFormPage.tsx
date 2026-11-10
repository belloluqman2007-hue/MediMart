import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Plus, Save, Trash2 } from 'lucide-react';
import {
  hasPermission,
  productInputSchema,
  productTypeLabels,
  productTypes,
  type CategorySummary,
  type ProductDetail,
  type UnitSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, PageHeading } from '../../components/ui';
import { formatMoney, koboToNairaInput, nairaToKobo, useAsync } from './lib';
import { BackLink, ErrorBlock, Field, LoadingBlock } from './shared';

type Conversion = { unitId: string; factor: string };
type FormState = {
  name: string;
  genericName: string;
  brand: string;
  sku: string;
  barcode: string;
  productType: string;
  categoryId: string;
  description: string;
  manufacturer: string;
  purchaseCost: string;
  sellingPrice: string;
  reorderLevel: string;
  baseUnitId: string;
  isExpiryTracked: boolean;
  status: 'active' | 'inactive';
  conversions: Conversion[];
};
const emptyState: FormState = {
  name: '',
  genericName: '',
  brand: '',
  sku: '',
  barcode: '',
  productType: 'medicine',
  categoryId: '',
  description: '',
  manufacturer: '',
  purchaseCost: '0.00',
  sellingPrice: '0.00',
  reorderLevel: '0',
  baseUnitId: '',
  isExpiryTracked: true,
  status: 'active',
  conversions: [],
};
function toForm(product: ProductDetail): FormState {
  return {
    name: product.name,
    genericName: product.genericName ?? '',
    brand: product.brand ?? '',
    sku: product.sku ?? '',
    barcode: product.barcode ?? '',
    productType: product.productType,
    categoryId: product.categoryId ?? '',
    description: product.description ?? '',
    manufacturer: product.manufacturer ?? '',
    purchaseCost: koboToNairaInput(product.purchaseCostKobo),
    sellingPrice: koboToNairaInput(product.sellingPriceKobo),
    reorderLevel: String(product.reorderLevel),
    baseUnitId: product.baseUnitId,
    isExpiryTracked: product.isExpiryTracked,
    status: product.status,
    conversions: product.units.map((unit) => ({
      unitId: unit.unitId,
      factor: String(unit.factor),
    })),
  };
}

/** Loads reference data, then mounts the form so its state has no effect-driven updates. */
export function ProductFormPage() {
  const { id } = useParams();
  const { api } = useApp();
  const reference = useAsync(
    () =>
      Promise.all([
        api.request<{ categories: CategorySummary[] }>('/api/categories'),
        api.request<{ units: UnitSummary[] }>('/api/units'),
        id ? api.request<ProductDetail>(`/api/products/${id}`) : Promise.resolve(null),
      ]),
    [id],
  );
  if (reference.loading && !reference.data) return <LoadingBlock label="Preparing the form…" />;
  if (reference.error) return <ErrorBlock message={reference.error} onRetry={reference.reload} />;
  if (!reference.data) return null;
  const [categories, units, product] = reference.data;
  return (
    <ProductForm
      key={product?.id ?? 'new'}
      product={product}
      categories={categories.categories}
      units={units.units}
    />
  );
}

function ProductForm({
  product,
  categories,
  units,
}: {
  product: ProductDetail | null;
  categories: CategorySummary[];
  units: UnitSummary[];
}) {
  const editing = Boolean(product);
  const { api, user, notify } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() => (product ? toForm(product) : emptyState));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const permitted = Boolean(
    user && hasPermission(user.permissions, editing ? 'products.edit' : 'products.create'),
  );
  const mayPriceBelowCost = Boolean(
    user && hasPermission(user.permissions, 'products.price.below_cost'),
  );
  const enteredCostKobo = nairaToKobo(form.purchaseCost);
  const enteredPriceKobo = nairaToKobo(form.sellingPrice);
  const belowCost =
    enteredCostKobo !== null && enteredPriceKobo !== null && enteredPriceKobo < enteredCostKobo;
  const baseUnit = units.find((unit) => unit.id === form.baseUnitId);
  const availableUnits = useMemo(
    () => units.filter((unit) => unit.id !== form.baseUnitId),
    [units, form.baseUnitId],
  );
  const conversionPreview = (conversion: Conversion) => {
    const unit = units.find((entry) => entry.id === conversion.unitId);
    const factor = Number(conversion.factor);
    if (!unit || !Number.isInteger(factor) || factor < 1 || !baseUnit) return null;
    return `1 ${unit.symbol} = ${factor} ${baseUnit.symbol}`;
  };

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function setConversion(index: number, patch: Partial<Conversion>) {
    setForm((current) => ({
      ...current,
      conversions: current.conversions.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const purchaseCostKobo = nairaToKobo(form.purchaseCost);
    const sellingPriceKobo = nairaToKobo(form.sellingPrice);
    if (purchaseCostKobo === null || sellingPriceKobo === null) {
      setError('Enter prices in naira, with no more than two decimal places.');
      return;
    }
    const parsed = productInputSchema.safeParse({
      name: form.name,
      genericName: form.genericName,
      brand: form.brand,
      sku: form.sku,
      barcode: form.barcode,
      productType: form.productType,
      categoryId: form.categoryId,
      description: form.description,
      manufacturer: form.manufacturer,
      purchaseCostKobo,
      sellingPriceKobo,
      reorderLevel: Number(form.reorderLevel),
      baseUnitId: form.baseUnitId,
      isExpiryTracked: form.isExpiryTracked,
      status: form.status,
      units: form.conversions
        .filter((conversion) => conversion.unitId && conversion.factor)
        .map((conversion) => ({ unitId: conversion.unitId, factor: Number(conversion.factor) })),
      allowBelowCost: belowCost,
    });
    if (!parsed.success) {
      const next: Record<string, string[]> = {};
      for (const issue of parsed.error.issues)
        (next[issue.path.join('.') || 'form'] ??= []).push(issue.message);
      setFieldErrors(next);
      setError('Please check the highlighted fields.');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.request<ProductDetail>(
        editing ? `/api/products/${product!.id}` : '/api/products',
        editing ? 'PUT' : 'POST',
        parsed.data,
      );
      notify(editing ? 'Product updated.' : 'Product added.', 'success');
      navigate(`/inventory/products/${saved.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!permitted)
    return (
      <div className="inventory-empty">
        <span className="empty-icon">
          <Save size={26} />
        </span>
        <h3>This needs a different permission</h3>
        <p>
          Your account needs {editing ? 'products.edit' : 'products.create'} to save product
          records.
        </p>
        <Link className="button button-secondary" to="/inventory/products">
          Back to products
        </Link>
      </div>
    );

  return (
    <>
      <BackLink to={editing ? `/inventory/products/${product!.id}` : '/inventory/products'}>
        {editing ? 'Back to product' : 'Back to products'}
      </BackLink>
      <PageHeading
        eyebrow="Inventory"
        title={editing ? 'Edit product' : 'Add product'}
        description="Prices are stored as whole kobo. Stock is counted in the base unit you choose."
      />
      <FormError message={error} />
      <form className="card inventory-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-section">
          <h2>Product identity</h2>
          <div className="form-two-columns">
            <Field label="Product name" error={fieldErrors.name?.[0]}>
              <input
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                maxLength={160}
                required
              />
            </Field>
            <Field label="Generic name" hint="Where applicable, e.g. Paracetamol.">
              <input
                value={form.genericName}
                onChange={(event) => update('genericName', event.target.value)}
                maxLength={160}
              />
            </Field>
            <Field label="Brand">
              <input
                value={form.brand}
                onChange={(event) => update('brand', event.target.value)}
                maxLength={120}
              />
            </Field>
            <Field label="Manufacturer">
              <input
                value={form.manufacturer}
                onChange={(event) => update('manufacturer', event.target.value)}
                maxLength={160}
              />
            </Field>
            <Field
              label="SKU"
              hint="Unique where used. Letters, numbers, dots, dashes, underscores."
              error={fieldErrors.sku?.[0]}
            >
              <input
                value={form.sku}
                onChange={(event) => update('sku', event.target.value)}
                maxLength={64}
              />
            </Field>
            <Field
              label="Barcode"
              hint="Duplicates are rejected across the catalogue."
              error={fieldErrors.barcode?.[0]}
            >
              <input
                value={form.barcode}
                onChange={(event) => update('barcode', event.target.value)}
                maxLength={64}
              />
            </Field>
          </div>
        </div>

        <div className="form-section">
          <h2>Classification</h2>
          <div className="form-two-columns">
            <Field label="Product type" error={fieldErrors.productType?.[0]}>
              <select
                value={form.productType}
                onChange={(event) => {
                  const productType = event.target.value;
                  setForm((current) => ({
                    ...current,
                    productType,
                    isExpiryTracked: productType === 'medicine' ? true : current.isExpiryTracked,
                  }));
                }}
              >
                {productTypes.map((value) => (
                  <option key={value} value={value}>
                    {productTypeLabels[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select
                value={form.categoryId}
                onChange={(event) => update('categoryId', event.target.value)}
              >
                <option value="">Uncategorised</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.parentName ? ` — ${category.parentName}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select
                value={form.status}
                onChange={(event) => update('status', event.target.value as 'active' | 'inactive')}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
            <Field label="Expiry tracking" hint="Medicines normally need expiry dates and batches.">
              <select
                value={form.isExpiryTracked ? 'yes' : 'no'}
                onChange={(event) => update('isExpiryTracked', event.target.value === 'yes')}
              >
                <option value="yes">Track batch expiry</option>
                <option value="no">No expiry (e.g. general goods)</option>
              </select>
            </Field>
          </div>
          <Field label="Description">
            <textarea
              className="inventory-textarea"
              value={form.description}
              onChange={(event) => update('description', event.target.value)}
              maxLength={2000}
              rows={3}
            />
          </Field>
        </div>

        <div className="form-section">
          <h2>Pricing and stock</h2>
          <div className="form-two-columns">
            <Field label="Purchase cost (₦)" error={fieldErrors.purchaseCostKobo?.[0]}>
              <input
                inputMode="decimal"
                value={form.purchaseCost}
                onChange={(event) => update('purchaseCost', event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Selling price (₦)" error={fieldErrors.sellingPriceKobo?.[0]}>
              <input
                inputMode="decimal"
                value={form.sellingPrice}
                onChange={(event) => update('sellingPrice', event.target.value)}
                placeholder="0.00"
              />
            </Field>
            <Field label="Reorder level" hint="Base units. Alerts when stock falls to this level.">
              <input
                type="number"
                min={0}
                value={form.reorderLevel}
                onChange={(event) => update('reorderLevel', event.target.value)}
              />
            </Field>
            <Field label="Base unit" error={fieldErrors.baseUnitId?.[0]}>
              <select
                value={form.baseUnitId}
                onChange={(event) => update('baseUnitId', event.target.value)}
                required
              >
                <option value="">Choose a unit</option>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name} ({unit.symbol})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="price-preview">
            <span>Cost {formatMoney(nairaToKobo(form.purchaseCost) ?? 0)}</span>
            <span>Selling {formatMoney(nairaToKobo(form.sellingPrice) ?? 0)}</span>
            {baseUnit && <span>Base unit: {baseUnit.name}</span>}
          </div>
          {belowCost && (
            <div className="info-box warning" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>This selling price is below the purchase cost.</strong>
                <p>
                  {mayPriceBelowCost
                    ? `Each base unit would be sold ${formatMoney((enteredCostKobo ?? 0) - (enteredPriceKobo ?? 0))} below cost. Saving is recorded in the audit log.`
                    : 'Your account needs products.price.below_cost to do this. Raise the selling price or ask the owner.'}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="form-section">
          <h2>Unit conversions</h2>
          <p className="muted small">
            Define how bulk units break down into the base unit. Example: base unit tablet; 1 pack =
            10 tablets; 1 carton = 120 tablets.
          </p>
          {form.conversions.map((conversion, index) => (
            <div className="conversion-row" key={index}>
              <Field label="Unit">
                <select
                  value={conversion.unitId}
                  onChange={(event) => setConversion(index, { unitId: event.target.value })}
                >
                  <option value="">Choose a unit</option>
                  {availableUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Factor (${baseUnit?.symbol || 'base units'})`}>
                <input
                  type="number"
                  min={1}
                  value={conversion.factor}
                  onChange={(event) => setConversion(index, { factor: event.target.value })}
                />
              </Field>
              <div className="conversion-preview">
                {conversionPreview(conversion) || 'Enter a whole factor of 1 or more.'}
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove conversion"
                onClick={() =>
                  update(
                    'conversions',
                    form.conversions.filter((_, position) => position !== index),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={availableUnits.length === form.conversions.length}
            onClick={() =>
              update('conversions', [...form.conversions, { unitId: '', factor: '1' }])
            }
          >
            <Plus size={15} /> Add conversion
          </Button>
        </div>

        <div className="form-actions">
          <Link className="button button-secondary" to="/inventory/products">
            Cancel
          </Link>
          <Button type="submit" busy={busy} disabled={belowCost && !mayPriceBelowCost}>
            <Save size={16} /> {editing ? 'Save changes' : 'Add product'}
          </Button>
        </div>
      </form>
    </>
  );
}
