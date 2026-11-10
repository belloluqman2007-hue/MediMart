import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Pencil, Plus, Power, Truck, Wallet } from 'lucide-react';
import {
  hasPermission,
  type Paginated,
  type SupplierDetail,
  type SupplierInput,
  type SupplierSummary,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { errorMessage } from '../../lib/api';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { buildQuery, formatDate, formatDateTime, formatMoney, useAsync } from './lib';
import {
  ConfirmDialog,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Pagination,
  SearchField,
  StatusBadge,
} from './shared';

const emptyDraft: SupplierInput = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  businessInfo: '',
  notes: '',
  status: 'active',
};

export function SuppliersPage() {
  const { api, user, notify } = useApp();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<SupplierInput | null>(null);
  const [editing, setEditing] = useState<SupplierSummary | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [toggling, setToggling] = useState<SupplierSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = Boolean(user && hasPermission(user.permissions, 'suppliers.manage'));
  const canSeeAccount = Boolean(user && hasPermission(user.permissions, 'supplier_debts.view'));

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const suppliers = useAsync(
    () =>
      api.request<Paginated<SupplierSummary>>(
        `/api/suppliers${buildQuery({ search: debounced, status, page, pageSize: 20 })}`,
      ),
    [debounced, status, page],
  );
  const detail = useAsync(
    () =>
      viewing ? api.request<SupplierDetail>(`/api/suppliers/${viewing}`) : Promise.resolve(null),
    [viewing],
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    if (draft.name.trim().length < 2) {
      setError('Give the supplier a name of at least two characters.');
      return;
    }
    setBusy(true);
    try {
      await api.request(
        editing ? `/api/suppliers/${editing.id}` : '/api/suppliers',
        editing ? 'PUT' : 'POST',
        draft,
      );
      notify(editing ? 'Supplier updated.' : 'Supplier added.', 'success');
      setDraft(null);
      setEditing(null);
      suppliers.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function toggleStatus() {
    if (!toggling) return;
    setBusy(true);
    try {
      await api.request(
        `/api/suppliers/${toggling.id}/${toggling.status === 'active' ? 'deactivate' : 'activate'}`,
        'POST',
        {},
      );
      notify(
        toggling.status === 'active' ? 'Supplier deactivated.' : 'Supplier reactivated.',
        'success',
      );
      setToggling(null);
      suppliers.reload();
    } catch (caught) {
      notify(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Inventory"
        title="Suppliers"
        description="Who you buy from, what they supplied, and when it arrived."
        action={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null);
                setError(null);
                setDraft({ ...emptyDraft });
              }}
            >
              <Plus size={16} /> Add supplier
            </Button>
          ) : undefined
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
            placeholder="Search name, contact, phone, email…"
            label="Search suppliers"
          />
          <select
            aria-label="Filter by supplier status"
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
        </div>
        {suppliers.loading && !suppliers.data ? (
          <LoadingBlock label="Loading suppliers…" />
        ) : suppliers.error ? (
          <ErrorBlock message={suppliers.error} onRetry={suppliers.reload} />
        ) : suppliers.data && suppliers.data.items.length === 0 ? (
          <EmptyState
            icon={<Truck size={27} />}
            title={debounced ? 'No suppliers match' : 'No suppliers yet'}
            message={
              debounced
                ? 'Try a different search term.'
                : 'Add the businesses that deliver your stock to keep receiving history tidy.'
            }
          />
        ) : suppliers.data ? (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Contact</th>
                    <th>Phone</th>
                    <th className="numeric">Products</th>
                    <th>Status</th>
                    <th>Added</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.data.items.map((supplier) => (
                    <tr key={supplier.id}>
                      <td>
                        <strong>{supplier.name}</strong>
                        {supplier.email && <small className="block muted">{supplier.email}</small>}
                      </td>
                      <td>{supplier.contactPerson || '—'}</td>
                      <td>{supplier.phone || '—'}</td>
                      <td className="numeric">{supplier.productCount}</td>
                      <td>
                        <StatusBadge tone={supplier.status === 'active' ? 'green' : 'neutral'}>
                          {supplier.status === 'active' ? 'Active' : 'Inactive'}
                        </StatusBadge>
                      </td>
                      <td className="muted">{formatDate(supplier.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-button"
                            aria-label={`View ${supplier.name}`}
                            onClick={() => setViewing(supplier.id)}
                          >
                            <Eye size={15} />
                          </button>
                          {canSeeAccount && (
                            <Link
                              className="icon-button"
                              to={`/suppliers/${supplier.id}/account`}
                              aria-label={`Open account for ${supplier.name}`}
                              title="Supplier account, invoices and payments"
                            >
                              <Wallet size={15} />
                            </Link>
                          )}
                          {canManage && (
                            <>
                              <button
                                className="icon-button"
                                aria-label={`Edit ${supplier.name}`}
                                onClick={() => {
                                  setEditing(supplier);
                                  setError(null);
                                  setDraft({
                                    name: supplier.name,
                                    contactPerson: supplier.contactPerson ?? '',
                                    phone: supplier.phone ?? '',
                                    email: supplier.email ?? '',
                                    address: supplier.address ?? '',
                                    businessInfo: supplier.businessInfo ?? '',
                                    notes: supplier.notes ?? '',
                                    status: supplier.status,
                                  });
                                }}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`Toggle ${supplier.name}`}
                                onClick={() => setToggling(supplier)}
                              >
                                <Power size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={suppliers.data.page}
              totalPages={suppliers.data.totalPages}
              total={suppliers.data.total}
              onChange={setPage}
            />
          </>
        ) : null}
      </section>

      <Modal
        open={Boolean(draft)}
        onClose={() => {
          setDraft(null);
          setEditing(null);
        }}
        title={editing ? 'Edit supplier' : 'Add supplier'}
      >
        {draft && (
          <form className="modal-form" onSubmit={(event) => void save(event)} noValidate>
            <Field label="Supplier name">
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={120}
                required
              />
            </Field>
            <div className="form-two-columns">
              <Field label="Contact person">
                <input
                  value={draft.contactPerson ?? ''}
                  onChange={(event) => setDraft({ ...draft, contactPerson: event.target.value })}
                  maxLength={120}
                />
              </Field>
              <Field label="Phone number">
                <input
                  value={draft.phone ?? ''}
                  onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                  maxLength={40}
                />
              </Field>
            </div>
            <Field label="Email">
              <input
                type="email"
                value={draft.email ?? ''}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                maxLength={254}
              />
            </Field>
            <Field label="Address">
              <textarea
                className="inventory-textarea"
                rows={2}
                value={draft.address ?? ''}
                onChange={(event) => setDraft({ ...draft, address: event.target.value })}
                maxLength={400}
              />
            </Field>
            <Field label="Business information" hint="Registration details, credit terms, notes.">
              <textarea
                className="inventory-textarea"
                rows={2}
                value={draft.businessInfo ?? ''}
                onChange={(event) => setDraft({ ...draft, businessInfo: event.target.value })}
                maxLength={400}
              />
            </Field>
            <Field label="Notes">
              <textarea
                className="inventory-textarea"
                rows={2}
                value={draft.notes ?? ''}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                maxLength={1000}
              />
            </Field>
            <Field label="Status">
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as 'active' | 'inactive' })
                }
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
            <FormError message={error} />
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                {editing ? 'Save changes' : 'Add supplier'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={detail.data?.name ?? 'Supplier'}
      >
        {detail.loading && !detail.data ? (
          <LoadingBlock label="Loading supplier…" />
        ) : detail.error ? (
          <ErrorBlock message={detail.error} onRetry={detail.reload} />
        ) : detail.data ? (
          <div className="supplier-detail">
            {canSeeAccount && (
              <div className="button-row">
                <Link
                  className="button button-secondary"
                  to={`/suppliers/${detail.data.id}/account`}
                >
                  <Wallet size={15} /> Open supplier account
                </Link>
              </div>
            )}
            <p className="muted small">
              {[detail.data.contactPerson, detail.data.phone, detail.data.email]
                .filter(Boolean)
                .join(' · ') || 'No contact details recorded'}
            </p>
            {detail.data.address && <p className="small">{detail.data.address}</p>}
            {detail.data.businessInfo && <p className="small muted">{detail.data.businessInfo}</p>}
            {detail.data.notes && <p className="small muted">Notes: {detail.data.notes}</p>}
            <h3>Products supplied</h3>
            {detail.data.products.length ? (
              <ul className="inventory-list compact">
                {detail.data.products.map((product) => (
                  <li key={product.id}>
                    <Link to={`/inventory/products/${product.id}`}>
                      <span>
                        <strong>{product.name}</strong>
                        <small>{product.sku ? `SKU ${product.sku}` : 'No SKU'}</small>
                      </span>
                      <span className="muted small">{product.stockQuantity} on hand</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-small">No stock has been received from this supplier yet.</p>
            )}
            <h3>Stock receiving history</h3>
            {detail.data.receipts.length ? (
              <ul className="inventory-list compact">
                {detail.data.receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <span>
                      <strong>{receipt.productName}</strong>
                      <small>
                        {formatDateTime(receipt.createdAt)} · {receipt.userName || 'System'}
                      </small>
                    </span>
                    <span className="muted small">
                      +{receipt.quantity}
                      {receipt.batchNumber ? ` · ${receipt.batchNumber}` : ''}
                      {receipt.unitCostKobo !== null
                        ? ` · ${formatMoney(receipt.unitCostKobo)}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-small">No receipts recorded from this supplier.</p>
            )}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(toggling)}
        title={toggling?.status === 'active' ? 'Deactivate supplier?' : 'Reactivate supplier?'}
        message={
          toggling?.status === 'active'
            ? 'The supplier stays in your records with its history, but will not appear in active supplier lists.'
            : 'The supplier becomes available again for new stock receipts.'
        }
        confirmLabel={toggling?.status === 'active' ? 'Deactivate' : 'Reactivate'}
        danger={toggling?.status === 'active'}
        busy={busy}
        onCancel={() => setToggling(null)}
        onConfirm={() => void toggleStatus()}
      />
    </>
  );
}
