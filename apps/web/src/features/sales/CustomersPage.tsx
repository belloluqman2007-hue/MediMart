import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Edit3, Eye, RefreshCw, UserPlus, Users } from 'lucide-react';
import {
  customerInputSchema,
  customerStatuses,
  hasPermission,
  type CustomerStatus,
  type CustomerSummary,
  type PaginatedCustomers,
} from '@medimart/shared';
import { errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import { buildQuery, formatMoney, koboToNairaInput, nairaToKobo, useAsync } from '../inventory/lib';
import {
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Pagination,
  SearchField,
  StatusBadge,
} from '../inventory/shared';
import { SalesAccessGate } from './SalesAccessGate';

export function CustomersPage() {
  const { api, user, notify } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'customers.view'));
  const canManage = Boolean(user && hasPermission(user.permissions, 'customers.manage'));

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<CustomerStatus | ''>('');
  const [hasDebtOnly, setHasDebtOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Create / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerSummary | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [creditLimitInput, setCreditLimitInput] = useState('');
  const [custStatus, setCustStatus] = useState<CustomerStatus>('active');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const customers = useAsync(
    () =>
      allowed
        ? api.request<PaginatedCustomers>(
            `/api/customers${buildQuery({
              search: debounced || undefined,
              status: statusFilter || undefined,
              hasDebt: hasDebtOnly ? 'true' : undefined,
              page,
              pageSize: 20,
            })}`,
          )
        : Promise.resolve(null),
    [allowed, debounced, statusFilter, hasDebtOnly, page],
  );

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Customers"
        title="Customers"
        description="Customer directory, transaction history, credit limits, and outstanding balances."
        permission="customers.view"
      />
    );
  }

  function openCreate() {
    setEditing(null);
    setFullName('');
    setPhone('');
    setEmail('');
    setAddress('');
    setNotes('');
    setCreditLimitInput('');
    setCustStatus('active');
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(cust: CustomerSummary) {
    setEditing(cust);
    setFullName(cust.fullName);
    setPhone(cust.phone ?? '');
    setEmail(cust.email ?? '');
    setAddress(cust.address ?? '');
    setNotes(cust.notes ?? '');
    setCreditLimitInput(
      cust.creditLimitKobo !== null ? koboToNairaInput(cust.creditLimitKobo) : '',
    );
    setCustStatus(cust.status);
    setFormError(null);
    setModalOpen(true);
  }

  async function saveCustomer(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const limitKobo = creditLimitInput.trim() ? nairaToKobo(creditLimitInput) : null;
    if (creditLimitInput.trim() && limitKobo === null) {
      setFormError('Enter a valid credit limit in naira (for example 50000.00).');
      return;
    }
    const parsed = customerInputSchema.safeParse({
      fullName,
      phone: phone || null,
      email: email || null,
      address: address || null,
      notes: notes || null,
      creditLimitKobo: limitKobo,
      status: custStatus,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]!.message);
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await api.request<CustomerSummary>(`/api/customers/${editing.id}`, 'PUT', parsed.data);
        notify(`Customer ${parsed.data.fullName} updated.`, 'success');
      } else {
        await api.request<CustomerSummary>('/api/customers', 'POST', parsed.data);
        notify(`Customer ${parsed.data.fullName} registered.`, 'success');
      }
      setModalOpen(false);
      customers.reload();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const data = customers.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Business"
        title="Customers"
        description="Manage customer contact details, credit limits, purchase histories, and outstanding debt balances."
        action={
          <>
            <Button variant="secondary" onClick={customers.reload} busy={customers.loading}>
              <RefreshCw size={15} /> Refresh
            </Button>
            {canManage && (
              <Button onClick={openCreate}>
                <UserPlus size={15} /> Register customer
              </Button>
            )}
          </>
        }
      />

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Customer directory</h2>
            <p>Unpaid customer credit is tracked accurately and never counted as cash received.</p>
          </div>
        </div>

        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search by customer name, code, phone, or email…"
            label="Search customers"
          />
          <select
            aria-label="Filter by customer status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as CustomerStatus | '');
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {customerStatuses.map((s) => (
              <option key={s} value={s}>
                {s === 'active' ? 'Active' : 'Inactive'}
              </option>
            ))}
          </select>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={hasDebtOnly}
              onChange={(event) => {
                setHasDebtOnly(event.target.checked);
                setPage(1);
              }}
            />
            <span>With outstanding debt only</span>
          </label>
        </div>

        {customers.loading && !data ? (
          <LoadingBlock label="Loading customers…" />
        ) : customers.error ? (
          <ErrorBlock message={customers.error} onRetry={customers.reload} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            icon={<Users size={24} />}
            title="No customers found"
            message="Register regular customers to track purchase history, credit sales, and debt repayments."
            action={
              canManage ? (
                <Button onClick={openCreate}>
                  <UserPlus size={15} /> Register customer
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Customer</th>
                    <th>Contact</th>
                    <th className="num">Sales</th>
                    <th className="num">Total purchases</th>
                    <th className="num">Credit limit</th>
                    <th className="num">Outstanding debt</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((cust) => (
                    <tr key={cust.id}>
                      <td>
                        <code>{cust.code}</code>
                      </td>
                      <td>
                        <Link to={`/customers/${cust.id}`} className="row-link">
                          <strong>{cust.fullName}</strong>
                        </Link>
                      </td>
                      <td>
                        <div>{cust.phone ?? '—'}</div>
                        {cust.email && <div className="muted small">{cust.email}</div>}
                      </td>
                      <td className="num">{cust.salesCount}</td>
                      <td className="num">{formatMoney(cust.totalPurchasesKobo)}</td>
                      <td className="num">
                        {cust.creditLimitKobo !== null
                          ? formatMoney(cust.creditLimitKobo)
                          : 'No cap'}
                      </td>
                      <td className="num">
                        <strong className={cust.outstandingBalanceKobo > 0 ? 'text-amber' : ''}>
                          {formatMoney(cust.outstandingBalanceKobo)}
                        </strong>
                      </td>
                      <td>
                        <StatusBadge tone={cust.status === 'active' ? 'green' : 'neutral'}>
                          {cust.status === 'active' ? 'Active' : 'Inactive'}
                        </StatusBadge>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Link
                            to={`/customers/${cust.id}`}
                            className="icon-button"
                            aria-label={`View ${cust.fullName}`}
                            title="Customer profile & ledger"
                          >
                            <Eye size={15} />
                          </Link>
                          {canManage && (
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Edit ${cust.fullName}`}
                              onClick={() => openEdit(cust)}
                            >
                              <Edit3 size={15} />
                            </button>
                          )}
                        </div>
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
        )}
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit ${editing.fullName}` : 'Register customer'}
      >
        <form onSubmit={(event) => void saveCustomer(event)} className="modal-form">
          <FormError message={formError} />
          <Field label="Full name">
            <input
              aria-label="Customer full name"
              required
              minLength={2}
              maxLength={160}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          </Field>
          <div className="form-two-columns">
            <Field label="Phone">
              <input
                aria-label="Customer phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                aria-label="Customer email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Address">
            <input
              aria-label="Customer address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <div className="form-two-columns">
            <Field label="Credit limit (₦)" hint="Blank = unlimited credit allowed">
              <input
                aria-label="Credit limit (₦)"
                inputMode="decimal"
                placeholder="50000.00"
                value={creditLimitInput}
                onChange={(event) => setCreditLimitInput(event.target.value)}
              />
            </Field>
            <Field label="Status">
              <select
                aria-label="Customer status"
                value={custStatus}
                onChange={(event) => setCustStatus(event.target.value as CustomerStatus)}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
          </div>
          <Field label="Notes">
            <input
              aria-label="Customer notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              {editing ? 'Save changes' : 'Create customer'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
