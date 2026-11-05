/**
 * Shared column helpers for durable migrations.
 *
 * These helpers are code, not data: the SQL text they emit is what checksums cover.
 * Never change their output — released migrations would no longer verify.
 */
export const timestamp = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
const uuidPattern = (column: string) =>
  `length(${column}) = 36 AND substr(${column},9,1) = '-' AND substr(${column},14,1) = '-' AND substr(${column},19,1) = '-' AND substr(${column},24,1) = '-' AND length(replace(${column},'-','')) = 32 AND replace(${column},'-','') NOT GLOB '*[^0-9a-f]*' AND substr(${column},15,1) IN ('1','2','3','4','5','6','7','8') AND substr(${column},20,1) IN ('8','9','a','b')`;
export function uuid(column: string) {
  return `${column} TEXT NOT NULL CHECK (${uuidPattern(column)})`;
}
/** A nullable UUID column that still verifies UUID layout when present. */
export function optionalUuid(column: string) {
  return `${column} TEXT CHECK (${column} IS NULL OR (${uuidPattern(column)}))`;
}
/** INTEGER-only money column in kobo. Never REAL, never floating point. */
export function kobo(column: string) {
  return `${column} INTEGER NOT NULL DEFAULT 0 CHECK (typeof(${column}) = 'integer' AND ${column} >= 0 AND ${column} <= 1000000000000)`;
}
