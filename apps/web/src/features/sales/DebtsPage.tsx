import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Eye, HandCoins, RefreshCw } from 'lucide-react';
import {
  debtStatuses,
  debtStatusLabels,
  hasPermission,
  paymentMethodLabels,
  paymentMethods,
  type DebtDetail,
  type DebtReport,
  type DebtStatus,
  type DebtSummary,
  type PaginatedDebts,
  type PaymentMethod,
} from '@medimart/shared';
import { errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';
import { Button, FormError, Modal, PageHeading } from '../../components/ui';
import {
  buildQuery,
  formatDate,
  formatDateTime,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  useAsync,
} from '../inventory/lib';
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

export function DebtsPage() {
  const { api, user, notify } = useApp();
  const allowed = Boolean(user && hasPermission(user.permissions, 'debts.view'));
  const canRepay = Boolean(user && hasPermission(user.permissions, 'debts.repay'));

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState<'outstanding' | DebtStatus | ''>('outstanding');
  const [page, setPage] = useState(1);

  // Repayment modal
  const [selectedDebt, setSelectedDebt] = useState<DebtSummary | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [repayBusy, setRepayBusy] = useState(false);
  const [repayError, setRepayError] = useState<string | null>(null);
  const repayOpRef = useRef<string | null>(null);

  // Debt detail modal
  const [inspectDebtId, setInspectDebtId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const report = useAsync(
    () => (allowed ? api.request<DebtReport>('/api/debts/report') : Promise.resolve(null)),
    [allowed],
  );

  const debts = useAsync(
    () =>
      allowed
        ? api.request<PaginatedDebts>(
            `/api/debts${buildQuery({
              search: debounced || undefined,
              status: statusFilter || undefined,
              page,
              pageSize: 20,
            })}`,
          )
        : Promise.resolve(null),
    [allowed, debounced, statusFilter, page],
  );

  const detailState = useAsync(
    () =>
      allowed && inspectDebtId
        ? api.request<DebtDetail>(`/api/debts/${inspectDebtId}`)
        : Promise.resolve(null),
    [allowed, inspectDebtId],
  );

  if (!allowed) {
    return (
      <SalesAccessGate
        eyebrow="Finance"
        title="Debts"
        description="Track unpaid customer credit, partial repayments, full settlements, and debt aging."
        permission="debts.view"
      />
    );
  }

  function openRepay(debt: DebtSummary, fullSettlement: boolean) {
    setSelectedDebt(debt);
    setAmountInput(fullSettlement ? koboToNairaInput(debt.outstandingKobo) : '');
    setMethod('cash');
    setReference('');
    setNotes('');
    setRepayError(null);
    repayOpRef.current = crypto.randomUUID();
  }

  async function submitDebtRepayment(event: FormEvent) {
    event.preventDefault();
    if (!selectedDebt) return;
    setRepayError(null);
    const amountKobo = nairaToKobo(amountInput);
    if (amountKobo === null || amountKobo <= 0) {
      setRepayError('Enter a valid repayment amount greater than zero.');
      return;
    }
    if (amountKobo > selectedDebt.outstandingKobo) {
      setRepayError(
        `Repayment cannot exceed the remaining debt of ${formatMoney(selectedDebt.outstandingKobo)}.`,
      );
      return;
    }
    setRepayBusy(true);
    try {
      await api.request(`/api/debts/${selectedDebt.id}/repayments`, 'POST', {
        operationId: repayOpRef.current ?? crypto.randomUUID(),
        amountKobo,
        method,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      });
      notify(
        `Recorded ${formatMoney(amountKobo)} repayment against ${selectedDebt.saleReceiptNumber}.`,
        'success',
      );
      setSelectedDebt(null);
      debts.reload();
      report.reload();
    } catch (caught) {
      setRepayError(errorMessage(caught));
    } finally {
      setRepayBusy(false);
    }
  }

  const r = report.data;
  const list = debts.data;

  return (
    <div className="inventory-workspace">
      <PageHeading
        eyebrow="Finance"
        title="Debts &amp; credit accounts"
        description="Outstanding credit is tracked separately from cash received until each repayment is collected."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              report.reload();
              debts.reload();
            }}
            busy={debts.loading || report.loading}
          >
            <RefreshCw size={15} /> Refresh
          </Button>
        }
      />

      {r && (
        <section className="inventory-metrics" aria-label="Debt summary metrics">
          <div className="inventory-metric">
            <span className="muted small">Total outstanding credit</span>
            <div className="metric-value">{formatMoney(r.totalOutstandingKobo)}</div>
            <small className="muted">
              {r.openDebtCount} open debt{r.openDebtCount === 1 ? '' : 's'} ·{' '}
              {r.customersWithDebtCount} customer{r.customersWithDebtCount === 1 ? '' : 's'}
            </small>
          </div>
          <div className="inventory-metric">
            <span className="muted small">Overdue debt balance</span>
            <div className="metric-value">{formatMoney(r.overdueAmountKobo)}</div>
            <small className="muted">{r.overdueDebtCount} past due date</small>
          </div>
          <div className="inventory-metric">
            <span className="muted small">Total debt repaid</span>
            <div className="metric-value">{formatMoney(r.totalRepaidKobo)}</div>
            <small className="muted">Counted in money received on collection</small>
          </div>
          <div className="inventory-metric">
            <span className="muted small">Original credit issued</span>
            <div className="metric-value">{formatMoney(r.totalOriginalCreditKobo)}</div>
            <small className="muted">
              Cancelled via reversals: {formatMoney(r.totalCancelledKobo)}
            </small>
          </div>
        </section>
      )}

      <section className="card inventory-card">
        <div className="card-heading">
          <div>
            <h2>Customer debt ledger</h2>
            <p>Record partial repayments or full settlements with complete payment audit trails.</p>
          </div>
        </div>

        <div className="inventory-filters">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search customer name, code, phone, or receipt #…"
            label="Search debts"
          />
          <select
            aria-label="Filter by debt status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as 'outstanding' | DebtStatus | '');
              setPage(1);
            }}
          >
            <option value="outstanding">Outstanding (Unpaid + Part paid)</option>
            <option value="">All debt records</option>
            {debtStatuses.map((s) => (
              <option key={s} value={s}>
                {debtStatusLabels[s]}
              </option>
            ))}
          </select>
        </div>

        {debts.loading && !list ? (
          <LoadingBlock label="Loading debt records…" />
        ) : debts.error ? (
          <ErrorBlock message={debts.error} onRetry={debts.reload} />
        ) : !list || list.items.length === 0 ? (
          <EmptyState
            icon={<HandCoins size={24} />}
            title="No matching debt records"
            message="Credit sales and part-payments appear here automatically until settled."
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Sale receipt</th>
                    <th>Created</th>
                    <th>Due date</th>
                    <th className="num">Original credit</th>
                    <th className="num">Paid</th>
                    <th className="num">Outstanding</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((debt) => (
                    <tr key={debt.id}>
                      <td>
                        <Link to={`/customers/${debt.customerId}`} className="row-link">
                          <strong>{debt.customerName}</strong>
                        </Link>
                        <div className="muted small">
                          {debt.customerCode}
                          {debt.customerPhone ? ` · ${debt.customerPhone}` : ''}
                        </div>
                      </td>
                      <td>
                        <Link to={`/pos/sales/${debt.saleId}`} className="row-link">
                          {debt.saleReceiptNumber}
                        </Link>
                      </td>
                      <td>{formatDate(debt.createdAt)}</td>
                      <td>
                        {formatDate(debt.dueDate)}
                        {debt.isOverdue && (
                          <>
                            {' '}
                            <StatusBadge tone="red">Overdue</StatusBadge>
                          </>
                        )}
                      </td>
                      <td className="num">{formatMoney(debt.originalAmountKobo)}</td>
                      <td className="num">{formatMoney(debt.amountPaidKobo)}</td>
                      <td className="num">
                        <strong>{formatMoney(debt.outstandingKobo)}</strong>
                      </td>
                      <td>
                        <StatusBadge
                          tone={
                            debt.status === 'settled'
                              ? 'green'
                              : debt.status === 'cancelled'
                                ? 'neutral'
                                : 'amber'
                          }
                        >
                          {debtStatusLabels[debt.status]}
                        </StatusBadge>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`View payment history for ${debt.saleReceiptNumber}`}
                            onClick={() => setInspectDebtId(debt.id)}
                          >
                            <Eye size={15} />
                          </button>
                          {canRepay && debt.outstandingKobo > 0 && (
                            <>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => openRepay(debt, false)}
                              >
                                Repay
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                onClick={() => openRepay(debt, true)}
                              >
                                Settle
                              </Button>
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
              page={list.page}
              totalPages={list.totalPages}
              total={list.total}
              onChange={setPage}
            />
          </>
        )}
      </section>

      {r && r.recentRepayments.length > 0 && (
        <section className="card inventory-card">
          <div className="card-heading">
            <div>
              <h2>Recent debt repayments</h2>
              <p>Latest auditable debt collections across customers.</p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Repayment #</th>
                  <th>Customer</th>
                  <th>Sale receipt</th>
                  <th>Method</th>
                  <th className="num">Amount collected</th>
                  <th className="num">Remaining debt</th>
                  <th>Recorded by</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {r.recentRepayments.map((rep) => (
                  <tr key={rep.id}>
                    <td>
                      <strong>{rep.receiptNumber}</strong>
                    </td>
                    <td>{rep.customerName}</td>
                    <td>{rep.saleReceiptNumber}</td>
                    <td>{paymentMethodLabels[rep.method]}</td>
                    <td className="num">
                      <strong>{formatMoney(rep.amountKobo)}</strong>
                    </td>
                    <td className="num">{formatMoney(rep.balanceAfterKobo)}</td>
                    <td>{rep.recordedByName ?? rep.recordedBy}</td>
                    <td>{formatDateTime(rep.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Record Debt Repayment Modal */}
      <Modal
        open={Boolean(selectedDebt)}
        onClose={() => setSelectedDebt(null)}
        title={
          selectedDebt
            ? `Record repayment · ${selectedDebt.customerName} (${selectedDebt.saleReceiptNumber})`
            : 'Record repayment'
        }
      >
        {selectedDebt && (
          <form onSubmit={(event) => void submitDebtRepayment(event)} className="modal-form">
            <p className="confirm-message">
              Outstanding balance on {selectedDebt.saleReceiptNumber}:{' '}
              <strong>{formatMoney(selectedDebt.outstandingKobo)}</strong>. Enter a partial amount
              or keep the full balance to settle completely.
            </p>
            <FormError message={repayError} />
            <div className="pos-quick-cash" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="pos-unit-chip"
                onClick={() => setAmountInput(koboToNairaInput(selectedDebt.outstandingKobo))}
              >
                Full settlement ({formatMoney(selectedDebt.outstandingKobo)})
              </button>
              {selectedDebt.outstandingKobo >= 2 && (
                <button
                  type="button"
                  className="pos-unit-chip"
                  onClick={() =>
                    setAmountInput(koboToNairaInput(Math.floor(selectedDebt.outstandingKobo / 2)))
                  }
                >
                  Half ({formatMoney(Math.floor(selectedDebt.outstandingKobo / 2))})
                </button>
              )}
            </div>
            <Field label="Repayment amount (₦)">
              <input
                aria-label="Debt repayment amount (₦)"
                inputMode="decimal"
                required
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
              />
            </Field>
            <div className="form-two-columns">
              <Field label="Payment method">
                <select
                  aria-label="Debt repayment method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as PaymentMethod)}
                >
                  {paymentMethods.map((m) => (
                    <option key={m} value={m}>
                      {paymentMethodLabels[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference (optional)">
                <input
                  aria-label="Debt repayment reference"
                  placeholder="Transfer / POS ref"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
            </div>
            <Field label="Notes (optional)">
              <input
                aria-label="Debt repayment notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setSelectedDebt(null)}>
                Cancel
              </Button>
              <Button type="submit" busy={repayBusy}>
                Save repayment
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Debt History Modal */}
      <Modal
        open={Boolean(inspectDebtId)}
        onClose={() => setInspectDebtId(null)}
        title={
          detailState.data
            ? `Debt history · ${detailState.data.saleReceiptNumber}`
            : 'Debt payment history'
        }
      >
        {detailState.loading && !detailState.data ? (
          <LoadingBlock label="Loading debt history…" />
        ) : detailState.error ? (
          <ErrorBlock message={detailState.error} onRetry={detailState.reload} />
        ) : detailState.data ? (
          <div className="supplier-detail">
            <p className="inventory-note">
              <strong>{detailState.data.customerName}</strong> · Original credit:{' '}
              {formatMoney(detailState.data.originalAmountKobo)} · Repaid:{' '}
              {formatMoney(detailState.data.amountPaidKobo)} · Outstanding:{' '}
              <strong>{formatMoney(detailState.data.outstandingKobo)}</strong>
            </p>
            {detailState.data.payments.length === 0 ? (
              <p className="empty-small">No repayments recorded on this debt yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Repayment #</th>
                      <th>Method</th>
                      <th className="num">Amount</th>
                      <th className="num">Balance after</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailState.data.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.receiptNumber}</td>
                        <td>{paymentMethodLabels[p.method]}</td>
                        <td className="num">{formatMoney(p.amountKobo)}</td>
                        <td className="num">{formatMoney(p.balanceAfterKobo)}</td>
                        <td>{formatDateTime(p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
