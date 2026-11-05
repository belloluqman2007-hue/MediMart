import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { Button, Modal } from '../../components/ui';

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="inventory-loading" role="status" aria-live="polite">
      <LoaderCircle size={20} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inventory-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <strong>Something needs attention</strong>
        <p>{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw size={15} /> Try again
        </Button>
      )}
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="inventory-empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}
export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="table-pagination">
      <span className="muted small">
        Page {page} of {totalPages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="pagination-buttons">
        <button
          className="icon-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
export function SearchField({
  value,
  onChange,
  placeholder,
  label = 'Search',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <div className="inventory-search">
      <Search size={16} />
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button className="icon-button" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
export function StatusBadge({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'neutral' | 'red';
  children: ReactNode;
}) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  busy = false,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="confirm-message">{message}</p>
      <div className="form-actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field-label">
      {label}
      {children}
      {hint && <small>{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="back-link">
      <ChevronLeft size={15} /> {children}
    </Link>
  );
}
export function BatchStatus({
  status,
}: {
  status: 'active' | 'depleted' | 'expired' | 'expiring';
}) {
  if (status === 'expired') return <StatusBadge tone="red">Expired</StatusBadge>;
  if (status === 'expiring') return <StatusBadge tone="amber">Near expiry</StatusBadge>;
  if (status === 'depleted') return <StatusBadge tone="neutral">Depleted</StatusBadge>;
  return <StatusBadge tone="green">Active</StatusBadge>;
}
