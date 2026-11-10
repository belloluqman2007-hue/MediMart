import { useEffect, useState } from 'react';
import type { Paginated, PaymentMethod, PurchaseStatus, SupplierSummary } from '@medimart/shared';
import { useApp } from '../../lib/context';
import { useAsync } from '../inventory/lib';

export {
  addDaysIso,
  buildQuery,
  formatDate,
  formatDateTime,
  formatMoney,
  koboToNairaInput,
  nairaToKobo,
  today,
  useAsync,
  useProductOptions,
} from '../inventory/lib';

export type SupplierOption = Pick<
  SupplierSummary,
  'id' | 'name' | 'contactPerson' | 'phone' | 'status'
>;

export function useSuppliers(search = '') {
  const { api } = useApp();
  const [debounced, setDebounced] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  return useAsync(
    () =>
      api.request<Paginated<SupplierOption>>(
        `/api/suppliers?search=${encodeURIComponent(debounced)}&pageSize=100&status=active`,
      ),
    [debounced],
  );
}

export function randomId() {
  return crypto.randomUUID();
}

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  pos_terminal: 'POS',
};

export function purchaseStatusTone(status: PurchaseStatus) {
  if (status === 'received') return 'green' as const;
  if (status === 'partially_received') return 'amber' as const;
  if (status === 'cancelled') return 'red' as const;
  return 'neutral' as const;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type RangePreset = 'today' | 'week' | 'month' | 'last_month' | 'year';

export function rangeFor(preset: RangePreset) {
  const today = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const end = iso(today);
  if (preset === 'today') return { from: end, to: end };
  if (preset === 'week') {
    const start = new Date(today);
    const offset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
    return { from: iso(start), to: end };
  }
  if (preset === 'month') return { from: `${end.slice(0, 7)}-01`, to: end };
  if (preset === 'last_month') {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const finish = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { from: iso(start), to: iso(finish) };
  }
  return { from: `${end.slice(0, 4)}-01-01`, to: end };
}
