import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paginated, ProductSummary } from '@medimart/shared';
import { errorMessage } from '../../lib/api';
import { useApp } from '../../lib/context';

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};
/** Naira is only ever displayed; all stored money is an integer amount of kobo. */
export function formatMoney(kobo: number | null | undefined) {
  const value = kobo ?? 0;
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
  }).format(value / 100);
}
export function koboToNairaInput(kobo: number | null | undefined) {
  const value = Math.max(0, Math.trunc(kobo ?? 0));
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
/** Parse a naira input into integer kobo without floating-point arithmetic. */
export function nairaToKobo(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
export function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
export function buildQuery(values: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Small fetch hook with explicit loading/error states and stale-response protection.
 * Loading is derived from the requested key, so no state is set synchronously in an effect.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const depsKey = JSON.stringify(deps);
  const requestKey = `${depsKey}#${nonce}`;
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null }>({
    key: '',
    data: null,
    error: null,
  });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  useEffect(() => {
    let active = true;
    void loaderRef.current().then(
      (value) => {
        if (active) setResult({ key: requestKey, data: value, error: null });
      },
      (caught: unknown) => {
        if (active)
          setResult((current) => ({
            key: requestKey,
            data: current.data,
            error: errorMessage(caught),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [requestKey]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return {
    data: result.data,
    loading: result.key !== requestKey,
    error: result.key === requestKey ? result.error : null,
    reload,
  };
}

/** Product picker used by the stock forms. Searches the catalogue on the server. */
export function useProductOptions(search: string) {
  const { api } = useApp();
  const [debounced, setDebounced] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  return useAsync(
    () =>
      api.request<Paginated<ProductSummary>>(
        `/api/products${buildQuery({ search: debounced, pageSize: 50, status: 'active' })}`,
      ),
    [debounced],
  );
}

export function pageSlice<T>(data: Paginated<T> | null) {
  return data ?? { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 };
}
/** Shared date input bounds for stock receiving. */
export const today = () => new Date().toISOString().slice(0, 10);
export function addDaysIso(days: number) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
