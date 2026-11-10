import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, FileText, Pencil, Plus, Receipt, RotateCcw, Upload } from 'lucide-react';
import {
  expenseStatusLabels,
  expenseStatuses,
  hasPermission,
  type ExpenseCategorySummary,
  type ExpenseDetail,
  type ExpenseStatus,
  type ExpenseSummary,
  type Paginated,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import {
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Pagination,
  SearchField,
  StatusBadge,
} from '../inventory/shared';
import { buildQuery, formatDate, formatMoney, nairaToKobo, randomId, today, useAsync } from './lib';

type Attachment = { name: string; mime: string; dataBase64: string };

type Draft = {
  id: string | null;
  version: number | null;
  categoryId: string;
  description: string;
  amount: string;
  paymentMethod: 'cash' | 'bank_transfer' | 'pos_terminal';
  expenseDate: string;
  payee: string;
  reference: string;
  notes: string;
  attachment: Attachment | null;
};

const blank = (): Draft => ({
  id: null,
  version: null,
  categoryId: '',
  description: '',
  amount: '',
  paymentMethod: 'cash',
  expenseDate: today(),
  payee: '',
  reference: '',
  notes: '',
  attachment: null,
});

const supportTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export function ExpensesPage() {
  const { api, user, notify } = useApp();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reversing, setReversing] = useState<ExpenseSummary | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = Boolean(user && hasPermission(user.permissions, 'expenses.create'));
  const canEdit = Boolean(user && hasPermission(user.permissions, 'expenses.edit'));
  const canReverse = Boolean(user && hasPermission(user.permissions, 'expenses.reverse'));

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const categories = useAsync(
    () => api.request<{ categories: ExpenseCategorySummary[] }>('/api/expense-categories'),
    [],
  );
  const expenses = useAsync(
    () =>
      api.request<Paginated<ExpenseSummary>>(
        `/api/expenses${buildQuery({
          search: debounced,
          categoryId,
          status,
          from,
          to,
          page,
          pageSize: 20,
        })}`,
      ),
    [debounced, categoryId, status, from, to, page],
  );
  const data = expenses.data;

  async function openEdit(expense: ExpenseSummary) {
    setError(null);
    try {
      const detail = await api.request<ExpenseDetail>(`/api/expenses/${expense.id}`);
      if (detail.status !== 'draft') {
        notify('Only a draft expense can be edited. Reverse a recorded expense instead.', 'error');
        return;
      }
      setDraft({
        id: detail.id,
        version: detail.version,
        categoryId: detail.categoryId,
        description: detail.description,
        amount: (detail.amountKobo / 100).toFixed(2),
        paymentMethod: detail.paymentMethod as Draft['paymentMethod'],
        expenseDate: detail.expenseDate,
        payee: detail.payee ?? '',
        reference: detail.reference ?? '',
        notes: detail.notes ?? '',
        attachment: detail.attachment
          ? {
              name: detail.attachment.name,
              mime: detail.attachment.mime,
              dataBase64: detail.attachment.dataBase64 ?? '',
            }
          : null,
      });
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : 'The expense could not be loaded.',
        'error',
      );
    }
  }

  async function chooseAttachment(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!supportTypes.includes(file.type)) {
      setError('Attach a JPEG, PNG, WebP image or a PDF document.');
      return;
    }
    if (file.size > 36_000) {
      setError('The attachment must be 36 KB or smaller.');
      return;
    }
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!dataBase64) {
      setError('The attachment could not be read.');
      return;
    }
    setDraft((current) =>
      current
        ? { ...current, attachment: { name: file.name, mime: file.type, dataBase64 } }
        : current,
    );
  }

  async function save(event: FormEvent | null, target: 'draft' | 'recorded') {
    event?.preventDefault();
    if (!draft) return;
    setError(null);
    const amountKobo = nairaToKobo(draft.amount);
    if (amountKobo === null || amountKobo <= 0) {
      setError('Enter a valid expense amount in naira.');
      return;
    }
    if (!draft.categoryId) {
      setError('Choose an expense category.');
      return;
    }
    if (draft.description.trim().length < 3) {
      setError('Describe the expense in at least three characters.');
      return;
    }
    if (draft.expenseDate > today()) {
      setError('The expense date cannot be in the future.');
      return;
    }
    const payload = {
      categoryId: draft.categoryId,
      description: draft.description.trim(),
      amountKobo,
      paymentMethod: draft.paymentMethod,
      expenseDate: draft.expenseDate,
      payee: draft.payee.trim() || undefined,
      reference: draft.reference.trim() || undefined,
      notes: draft.notes.trim() || undefined,
      attachment: draft.attachment
        ? {
            name: draft.attachment.name,
            mime: draft.attachment.mime,
            dataBase64: draft.attachment.dataBase64,
          }
        : null,
    };
    setBusy(true);
    try {
      if (draft.id && draft.version !== null) {
        await api.request(`/api/expenses/${draft.id}`, 'PUT', {
          ...payload,
          version: draft.version,
        });
        notify('Draft expense updated.', 'success');
      } else {
        await api.request('/api/expenses', 'POST', {
          ...payload,
          operationId: randomId(),
          status: target,
        });
        notify(target === 'draft' ? 'Expense draft saved.' : 'Expense recorded.', 'success');
      }
      setDraft(null);
      expenses.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The expense could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function postExpense(expense: ExpenseSummary) {
    setBusy(true);
    try {
      await api.request(`/api/expenses/${expense.id}/record`, 'POST', {});
      notify('Expense recorded. It now counts as an operating expense.', 'success');
      expenses.reload();
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : 'The expense could not be recorded.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitReversal(event: FormEvent) {
    event.preventDefault();
    if (!reversing) return;
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/expenses/${reversing.id}/reverse`, 'POST', {
        operationId: randomId(),
        reason: reason.trim(),
      });
      notify('Expense reversed with an audit record.', 'success');
      setReversing(null);
      setReason('');
      expenses.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The expense could not be reversed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Finance"
        title="Operating expenses"
        description="Rent, utilities, transport, salaries and other running costs. Drafts do not affect profit; recorded expenses do."
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setDraft(blank());
                setError(null);
              }}
            >
              <Plus size={16} /> New expense
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
            placeholder="Search description, payee or reference…"
            label="Search expenses"
          />
          <select
            aria-label="Expense category"
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
            aria-label="Expense status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ExpenseStatus | '');
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {expenseStatuses.map((value) => (
              <option key={value} value={value}>
                {expenseStatusLabels[value]}
              </option>
            ))}
          </select>
          <label className="inline-date">
            <span className="small muted">From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="inline-date">
            <span className="small muted">To</span>
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        {expenses.loading && !data ? (
          <LoadingBlock label="Loading expenses…" />
        ) : expenses.error ? (
          <ErrorBlock message={expenses.error} onRetry={expenses.reload} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            icon={<Receipt size={27} />}
            title={debounced || status || categoryId ? 'No expenses match' : 'No expenses yet'}
            message="Record rent, utilities, transport and other operating costs to keep profit accurate."
            action={
              canCreate ? (
                <Button onClick={() => setDraft(blank())}>
                  <Plus size={15} /> New expense
                </Button>
              ) : undefined
            }
          />
        ) : data ? (
          <>
            <div className="table-scroll">
              <table className="data-table expenses-table">
                <thead>
                  <tr>
                    <th>Expense</th>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Payee</th>
                    <th>Method</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((expense) => (
                    <tr key={expense.id}>
                      <td>
                        <span className="table-primary">{expense.expenseNumber}</span>
                        {expense.hasAttachment && (
                          <small className="muted">
                            <FileText size={12} /> {expense.attachmentName}
                          </small>
                        )}
                      </td>
                      <td>{formatDate(expense.expenseDate)}</td>
                      <td>{expense.categoryName}</td>
                      <td>{expense.description}</td>
                      <td>{expense.payee ?? '—'}</td>
                      <td>{expense.paymentMethod.replaceAll('_', ' ')}</td>
                      <td>{formatMoney(expense.amountKobo)}</td>
                      <td>
                        <StatusBadge
                          tone={
                            expense.status === 'recorded'
                              ? 'green'
                              : expense.status === 'reversed'
                                ? 'red'
                                : 'neutral'
                          }
                        >
                          {expenseStatusLabels[expense.status]}
                        </StatusBadge>
                      </td>
                      <td className="row-actions">
                        {canEdit && expense.status === 'draft' && (
                          <>
                            <button
                              className="icon-button"
                              title="Edit draft"
                              aria-label={`Edit ${expense.expenseNumber}`}
                              onClick={() => void openEdit(expense)}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              className="icon-button"
                              title="Record expense"
                              aria-label={`Record ${expense.expenseNumber}`}
                              disabled={busy}
                              onClick={() => void postExpense(expense)}
                            >
                              <CheckCircle2 size={15} />
                            </button>
                          </>
                        )}
                        {canReverse && expense.status === 'recorded' && (
                          <button
                            className="icon-button"
                            title="Reverse expense"
                            aria-label={`Reverse ${expense.expenseNumber}`}
                            onClick={() => {
                              setReversing(expense);
                              setReason('');
                              setError(null);
                            }}
                          >
                            <RotateCcw size={15} />
                          </button>
                        )}
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

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit draft expense' : 'New expense'}
      >
        {draft && (
          <form className="modal-form" onSubmit={(event) => void save(event, 'recorded')}>
            <Field label="Category">
              <select
                value={draft.categoryId}
                onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
                required
              >
                <option value="">Choose a category…</option>
                {(categories.data?.categories ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Description">
              <input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="e.g. November shop rent"
                required
              />
            </Field>
            <div className="form-two-columns">
              <Field label="Amount (₦)">
                <input
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                  required
                />
              </Field>
              <Field label="Payment method">
                <select
                  value={draft.paymentMethod}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      paymentMethod: event.target.value as Draft['paymentMethod'],
                    })
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="pos_terminal">POS</option>
                </select>
              </Field>
              <Field label="Expense date">
                <input
                  type="date"
                  max={today()}
                  value={draft.expenseDate}
                  onChange={(event) => setDraft({ ...draft, expenseDate: event.target.value })}
                  required
                />
              </Field>
              <Field label="Payee" hint="Optional">
                <input
                  value={draft.payee}
                  onChange={(event) => setDraft({ ...draft, payee: event.target.value })}
                />
              </Field>
              <Field label="Reference number" hint="Optional">
                <input
                  value={draft.reference}
                  onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Notes" hint="Optional">
              <textarea
                className="inventory-textarea"
                rows={2}
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </Field>
            <Field label="Receipt or document" hint="JPEG, PNG, WebP or PDF · 36 KB max">
              <div className="button-row">
                <label className="button button-secondary">
                  <Upload size={15} /> Choose file
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    hidden
                    onChange={(event) => void chooseAttachment(event.target.files?.[0])}
                  />
                </label>
                {draft.attachment && (
                  <span className="small muted">
                    {draft.attachment.name}{' '}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setDraft({ ...draft, attachment: null })}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
            </Field>
            <FormError message={error} />
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              {!draft.id && (
                <Button
                  type="button"
                  variant="secondary"
                  busy={busy}
                  onClick={() => void save(null, 'draft')}
                >
                  Save draft
                </Button>
              )}
              <Button type="submit" busy={busy}>
                {draft.id ? <Pencil size={15} /> : <CheckCircle2 size={15} />}
                {draft.id ? 'Save changes' : 'Record expense'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={Boolean(reversing)}
        onClose={() => setReversing(null)}
        title="Reverse this expense?"
      >
        <form className="modal-form" onSubmit={(event) => void submitReversal(event)}>
          <p className="muted">
            {reversing?.expenseNumber} · {reversing?.description} ·{' '}
            {formatMoney(reversing?.amountKobo)}
          </p>
          <Field label="Reversal reason">
            <textarea
              className="inventory-textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this expense being reversed?"
            />
          </Field>
          <p className="small muted">
            The expense stays in history as reversed. It will no longer reduce operating profit.
          </p>
          <FormError message={error} />
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => setReversing(null)}>
              Keep expense
            </Button>
            <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>
              <RotateCcw size={15} /> Reverse expense
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
