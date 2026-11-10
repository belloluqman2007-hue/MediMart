import type { SqlExecutor } from '@medimart/database';
import { ApiError } from '../../errors';
import { todayIso } from '../inventory/common';

/** Integer-only proportional split used for base-unit costs. Never floating point storage. */
export function proportionalKobo(totalKobo: number, part: number, whole: number) {
  if (whole <= 0) return 0;
  const value = Math.round((totalKobo * part) / whole);
  if (!Number.isSafeInteger(value))
    throw new ApiError(400, 'AMOUNT_INVALID', 'The calculated amount is not valid.');
  return value;
}

/** A report window always has a bounded, ordered pair of calendar dates. */
export function reportWindow(query: { from?: string; to?: string }) {
  const to = query.to ?? todayIso();
  const from = query.from ?? to;
  if (from > to)
    throw new ApiError(
      400,
      'DATE_RANGE_INVALID',
      'The start date must be on or before the end date.',
    );
  return { from, to };
}

export type SupplierRow = {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  status: 'active' | 'inactive';
  deleted_at: string | null;
};

export async function loadSupplier(tx: SqlExecutor, id: string): Promise<SupplierRow> {
  const row = (
    await tx.all<SupplierRow>(
      'SELECT id,name,contact_person,phone,email,status,deleted_at FROM suppliers WHERE id = ?',
      [id],
    )
  )[0];
  if (!row || row.deleted_at)
    throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'This supplier does not exist.');
  return row;
}

export function requireActiveSupplier(supplier: SupplierRow) {
  if (supplier.status !== 'active')
    throw new ApiError(
      409,
      'SUPPLIER_INACTIVE',
      'Reactivate this supplier before creating purchase records for them.',
    );
}

/** Reject floating-point or unsafe values before they can reach a kobo column. */
export function assertIntegerKobo(value: number, field = 'amount') {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ApiError(400, 'MONEY_INVALID', `The ${field} must be a whole amount of kobo.`);
  return value;
}

export function csvCell(value: unknown) {
  const raw = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula prefixes in free-text fields without altering numbers.
  const text = /^[=+@\t]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]) {
  return [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join(
    '\r\n',
  );
}

export function dateRangeIso(from: string, to: string) {
  return { fromIso: `${from}T00:00:00.000Z`, toIso: `${to}T23:59:59.999Z` };
}
