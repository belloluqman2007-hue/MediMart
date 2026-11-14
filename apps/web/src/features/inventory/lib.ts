import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paginated, ProductImportRowInput, ProductSummary } from '@medimart/shared';
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

/**
 * A deliberately small RFC-4180 CSV reader: quoted fields, escaped quotes, embedded newlines and
 * CRLF. It reports problems per row instead of throwing, so a stray quote on line 400 does not hide
 * the other 399 rows.
 */
export function parseCsv(text: string): { rows: ProductImportRowInput[]; errors: string[] } {
  const records: string[][] = [];
  const errors: string[] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      line += 1;
      recordLine = line;
      continue;
    }
    field += char;
  }
  if (quoted) errors.push(`A quoted value starting near line ${recordLine} never closes.`);
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  const header = nonEmpty.shift();
  if (!header) return { rows: [], errors: [...errors, 'The file is empty.'] };

  const columns = header.map((cell) => cell.trim().replace(/^\ufeff/, ''));
  const nameIndex = columns.findIndex((column) => column.toLowerCase() === 'name');
  if (nameIndex === -1)
    return { rows: [], errors: [...errors, 'The header row must contain a "name" column.'] };

  const rows: ProductImportRowInput[] = nonEmpty.map((cells) => {
    const value = (key: string) => {
      const at = columns.findIndex((column) => column.toLowerCase() === key.toLowerCase());
      return at === -1 ? '' : (cells[at] ?? '').trim();
    };
    const packSize = value('packSize');
    const row: ProductImportRowInput = {
      name: cells[nameIndex]?.trim() ?? '',
      genericName: value('genericName') || undefined,
      brand: value('brand') || undefined,
      sku: value('sku') || undefined,
      barcode: value('barcode') || undefined,
      productType: value('productType') || undefined,
      category: value('category') || undefined,
      dosageForm: value('dosageForm') || undefined,
      strength: value('strength') || undefined,
      ...(packSize ? { packSize } : {}),
      manufacturer: value('manufacturer') || undefined,
      purchaseCostKobo: value('purchaseCostKobo') || undefined,
      sellingPriceKobo: value('sellingPriceKobo') || undefined,
      reorderLevel: value('reorderLevel') || undefined,
      baseUnit: value('baseUnit') || undefined,
      expiryTracked: value('expiryTracked') || undefined,
      status: value('status') || undefined,
    };
    return row;
  });

  return { rows, errors };
}
