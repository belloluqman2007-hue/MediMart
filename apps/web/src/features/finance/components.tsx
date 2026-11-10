import type { ReactNode } from 'react';
import type { PurchaseStatus } from '@medimart/shared';
import { formatMoney, purchaseStatusTone } from './lib';
import { StatusBadge } from '../inventory/shared';

export function FinanceMetric({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: 'green' | 'amber' | 'red' | 'neutral' | 'blue' | 'purple';
}) {
  return (
    <div className={`inventory-metric ${tone ?? ''}`}>
      <span className="subtle-label">{label}</span>
      <strong>{value}</strong>
      {caption && <small>{caption}</small>}
    </div>
  );
}

export function Money({ kobo }: { kobo: number | null | undefined }) {
  return <span className="money-cell">{formatMoney(kobo)}</span>;
}

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return <StatusBadge tone={purchaseStatusTone(status)}>{status.replaceAll('_', ' ')}</StatusBadge>;
}

export function PermissionNotice({ children }: { children: ReactNode }) {
  return (
    <div className="inventory-note">
      <strong>Access is managed by your administrator.</strong>
      <p>{children}</p>
    </div>
  );
}
