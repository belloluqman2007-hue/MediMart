import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertCircle, ArrowRight, LoaderCircle, X } from 'lucide-react';
export function Brand({
  inverse = false,
  compact = false,
}: {
  inverse?: boolean;
  compact?: boolean;
}) {
  return (
    <Link to="/" className={`brand ${inverse ? 'brand-inverse' : ''}`} aria-label="MediMart home">
      <span className="brand-mark">
        <span />
        <span />
      </span>
      {!compact && (
        <span className="brand-word">
          Medi<span>Mart</span>
          <small>BUSINESS, IN GOOD HEALTH.</small>
        </span>
      )}
    </Link>
  );
}
export function Button({
  children,
  className = '',
  variant = 'primary',
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button button-${variant} ${className}`}
    >
      {busy && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function FormError({ message }: { message: string | null }) {
  return message ? (
    <div className="form-error" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current!.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function FoundationNote() {
  return (
    <div className="foundation-note">
      <Activity size={14} />
      <span>Thoughtfully built. Locally connected.</span>
      <span className="note-version">MediMart v0.1.0</span>
    </div>
  );
}
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="text-link" to={to}>
      {children}
      <ArrowRight size={15} />
    </Link>
  );
}
