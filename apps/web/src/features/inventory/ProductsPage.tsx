import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Boxes, PackagePlus, Plus, Upload } from 'lucide-react';
import {
  hasPermission,
  productTypeLabels,
  productTypes,
  type CategorySummary,
  type Paginated,
  type ProductSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { buildQuery, formatMoney, useAsync } from './lib';
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Pagination,
  SearchField,
  StatusBadge,
} from './shared';

export function ProductsPage() {
  const { api, user } = useApp();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('search') ?? '');
  const [debounced, setDebounced] = useState(search);
  const [type, setType] = useState(params.get('type') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [stock, setStock] = useState(params.get('stock') ?? '');
  const [categoryId, setCategoryId] = useState(params.get('categoryId') ?? '');
  const [sort, setSort] = useState(params.get('sort') ?? 'createdAt');
  const [order, setOrder] = useState(params.get('order') ?? 'desc');
  const [page, setPage] = useState(Number(params.get('page') ?? 1));
  const canCreate = Boolean(user && hasPermission(user.permissions, 'products.create'));
  const canReceive = Boolean(user && hasPermission(user.permissions, 'stock.receive'));
  const canImport = Boolean(user && hasPermission(user.permissions, 'products.import'));

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        const values: Record<string, string> = {
          search,
          type,
          status,
          stock,
          categoryId,
          sort,
          order,
        };
        for (const [key, value] of Object.entries(values)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (page > 1) next.set('page', String(page));
        else next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [search, type, status, stock, categoryId, sort, order, page, setParams]);

  const categories = useAsync(
    () => api.request<{ categories: CategorySummary[] }>('/api/categories'),
    [],
  );
  const products = useAsync(
    () =>
      api.request<Paginated<ProductSummary>>(
        `/api/products${buildQuery({
          search: debounced,
          type,
          status,
          stock,
          categoryId,
          sort,
          order,
          page,
          pageSize: 20,
        })}`,
      ),
    [debounced, type, status, stock, categoryId, sort, order, page],
  );
  const data = products.data;
  const resetFilters = () => {
    setSearch('');
    setType('');
    setStatus('');
    setStock('');
    setCategoryId('');
    setSort('createdAt');
    setOrder('desc');
    setPage(1);
  };
  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Products"
        description="Every medicine, drink, snack, and household item you sell."
        action={
          <>
            {canReceive && (
              <Link to="/inventory/receive" className="button button-secondary">
                <PackagePlus size={16} /> Receive stock
              </Link>
            )}
            {canImport && (
              <Link to="/inventory/products/import" className="button button-secondary">
                <Upload size={16} /> Import
              </Link>
            )}
            {canCreate && (
              <Link to="/inventory/products/new" className="button button-primary">
                <Plus size={16} /> Add product
              </Link>
            )}
          </>
        }
      />
      <section className="card inventory-card">
        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search name, SKU, barcode, brand…"
            label="Search products"
          />
          <select
            aria-label="Filter by product type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All types</option>
            {productTypes.map((value) => (
              <option key={value} value={value}>
                {productTypeLabels[value]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by category"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {(categories.data?.categories ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by stock level"
            value={stock}
            onChange={(event) => {
              setStock(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any stock level</option>
            <option value="in">In stock</option>
            <option value="low">Below reorder level</option>
            <option value="out">Out of stock</option>
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            aria-label="Sort products"
            value={`${sort}:${order}`}
            onChange={(event) => {
              const [nextSort, nextOrder] = event.target.value.split(':');
              setSort(nextSort!);
              setOrder(nextOrder!);
            }}
          >
            <option value="createdAt:desc">Newest first</option>
            <option value="name:asc">Name A–Z</option>
            <option value="stockQuantity:asc">Lowest stock</option>
            <option value="sellingPriceKobo:desc">Highest price</option>
            <option value="reorderLevel:desc">Highest reorder level</option>
          </select>
          <Button variant="ghost" onClick={resetFilters}>
            Reset
          </Button>
        </div>
        {products.loading && !data ? (
          <LoadingBlock label="Loading products…" />
        ) : products.error ? (
          <ErrorBlock message={products.error} onRetry={products.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<Boxes size={28} />}
            title={
              debounced || type || categoryId || stock ? 'No products match' : 'No products yet'
            }
            message={
              debounced || type || categoryId || stock
                ? 'Try a different search or clear the filters.'
                : 'Add your first product and MediMart will track its stock, batches, and expiry.'
            }
            action={
              canCreate ? (
                <Link className="button button-primary" to="/inventory/products/new">
                  Add a product
                </Link>
              ) : undefined
            }
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Type</th>
                    <th>Category</th>
                    <th className="numeric">Stock</th>
                    <th className="numeric">Cost</th>
                    <th className="numeric">Selling</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <Link to={`/inventory/products/${product.id}`} className="table-primary">
                          {product.name}
                        </Link>
                        <small className="block muted">
                          {[product.brand, product.sku && `SKU ${product.sku}`]
                            .filter(Boolean)
                            .join(' · ') || 'No brand or SKU'}
                        </small>
                      </td>
                      <td>{productTypeLabels[product.productType]}</td>
                      <td>{product.categoryName || '—'}</td>
                      <td className="numeric">
                        <span
                          className={
                            product.stockQuantity === 0
                              ? 'text-red'
                              : product.stockQuantity <= product.reorderLevel
                                ? 'text-amber'
                                : ''
                          }
                        >
                          {product.stockQuantity} {product.baseUnitSymbol}
                        </span>
                      </td>
                      <td className="numeric">{formatMoney(product.purchaseCostKobo)}</td>
                      <td className="numeric">{formatMoney(product.sellingPriceKobo)}</td>
                      <td>
                        <StatusBadge tone={product.status === 'active' ? 'green' : 'neutral'}>
                          {product.status === 'active' ? 'Active' : 'Inactive'}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              onChange={setPage}
            />
          </>
        ) : null}
      </section>
    </>
  );
}
