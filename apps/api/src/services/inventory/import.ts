import type { Database, SqlExecutor } from '@medimart/database';
import type {
  ProductImportIssue,
  ProductImportReport,
  ProductImportRowInput,
  ProductImportRowResult,
  ProductImportRun,
  ProductInput,
} from '@medimart/shared';
import { dosageForms, productInputSchema, productTypes, sha256 } from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission } from './common';
import { createProductIn, productSearchText, updateProductIn } from './products';

/**
 * Bulk catalogue onboarding.
 *
 * Design rules, all of them deliberate:
 *
 * 1. **Preview first, always.** The same evaluation runs for a preview and a real import, so what the
 *    shopkeeper sees is exactly what will happen. Only `preview: false` writes.
 * 2. **All-or-nothing.** If any row has an error the run is refused and nothing is written. A
 *    half-imported catalogue is worse than a rejected spreadsheet: the shopkeeper cannot tell which
 *    half landed.
 * 3. **Match before create.** Rows are matched on SKU, then barcode, then exact name plus strength,
 *    so re-submitting a corrected sheet updates rather than duplicating. Creating a duplicate
 *    medicine is the failure mode that actually damages a pharmacy's records.
 * 4. **Reuse the single-product rules.** Every row is validated by `productInputSchema` and written
 *    through `createProduct`/`updateProduct`, so an imported product is indistinguishable from one
 *    entered by hand — same audit rows, same below-cost rule, same uniqueness checks.
 * 5. **Bounded work.** At most 5 000 rows per request (enforced by the contract) and it runs in one
 *    transaction, so a failure leaves the catalogue exactly as it was.
 */

const MAX_EXISTING_CHECKS = 5_000;

/** A client idempotency key normalised to the fixed-width fingerprint the column stores. */
async function importKeyHash(key: string) {
  return sha256(`product-import-v1\n${key}`);
}

type Resolution = {
  row: number;
  input: ProductInput;
  name: string;
  matchedOn: 'sku' | 'barcode' | 'name' | null;
  existingId: string | null;
  issues: ProductImportIssue[];
};

/** Maps a spreadsheet's loose text onto the closed vocabularies the catalogue enforces. */
function normaliseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  aliases: Record<string, T>,
): T | null {
  if (!value) return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if ((allowed as readonly string[]).includes(key)) return key as T;
  return aliases[key] ?? null;
}

const productTypeAliases: Record<string, (typeof productTypes)[number]> = {
  drug: 'medicine',
  drugs: 'medicine',
  pharma: 'medicine',
  pharmacy: 'medicine',
  medication: 'medicine',
  food: 'foodstuff',
  groceries: 'foodstuff',
  grocery: 'foodstuff',
  drink: 'drinks',
  beverage: 'drinks',
  beverages: 'drinks',
  snack: 'snacks',
  general_merchandise: 'general',
  general_merchandise_: 'general' as (typeof productTypes)[number],
  merchandise: 'general',
  household: 'general',
};

const dosageFormAliases: Record<string, (typeof dosageForms)[number]> = {
  tabs: 'tablet',
  tab: 'tablet',
  tablets: 'tablet',
  caps: 'capsule',
  cap: 'capsule',
  capsules: 'capsule',
  susp: 'suspension',
  sol: 'solution',
  inj: 'injection',
  injections: 'injection',
  drip: 'infusion',
  creams: 'cream',
  ointments: 'ointment',
  eye_drops: 'drops',
  ear_drops: 'drops',
  oral_drops: 'drops',
  inhalers: 'inhaler',
  suppositories: 'suppository',
  sachets: 'sachet',
  patches: 'patch',
  sprays: 'spray',
  lozenges: 'lozenge',
};

/**
 * Money arrives from a spreadsheet as naira ("1,250.50", "₦1250"), never as kobo. Parsing it with
 * string arithmetic keeps the integer-kobo rule intact; `Number('1.005') * 100` would not.
 */
export function parseNairaToKobo(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined || raw.trim() === '') return null;
  const cleaned = raw
    .replace(/[₦,\s]/g, '')
    .replace(/^NGN/i, '')
    .trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return 'invalid';
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function parsePositiveInt(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined || raw.trim() === '') return null;
  const cleaned = raw.trim().replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return 'invalid';
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : 'invalid';
}

/**
 * Resolve a unit or category by code, symbol or name. Import spreadsheets carry human labels
 * ("tablet", "Analgesics"), not internal UUIDs, and asking a shopkeeper to type UUIDs would make
 * the feature unusable.
 */
async function resolveReference(
  tx: SqlExecutor,
  table: 'units' | 'categories',
  label: string | undefined,
  cache: Map<string, string | null>,
) {
  if (!label) return null;
  const needle = label.trim().toLowerCase();
  const key = `${table}:${needle}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // Units are matched on code, name or symbol ("tablet", "Tablet", "tab"); categories have no code.
  const sql =
    table === 'units'
      ? 'SELECT id FROM units WHERE lower(code)=? OR lower(name)=? OR lower(symbol)=? ORDER BY id LIMIT 1'
      : 'SELECT id FROM categories WHERE lower(name)=? ORDER BY id LIMIT 1';
  const values = table === 'units' ? [needle, needle, needle] : [needle];
  const row = (await tx.all<{ id: string }>(sql, values))[0];
  const value = row ? row.id : null;
  cache.set(key, value);
  return value;
}

async function findExisting(tx: SqlExecutor, row: ProductImportRowInput) {
  if (row.sku) {
    const found = (
      await tx.all<{ id: string }>(
        'SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND deleted_at IS NULL',
        [row.sku],
      )
    )[0];
    if (found) return { id: found.id, matchedOn: 'sku' as const };
  }
  if (row.barcode) {
    const found = (
      await tx.all<{ id: string }>(
        'SELECT id FROM products WHERE barcode = ? COLLATE NOCASE AND deleted_at IS NULL',
        [row.barcode],
      )
    )[0];
    if (found) return { id: found.id, matchedOn: 'barcode' as const };
  }
  // Name plus strength: "Paracetamol 500 mg" and "Paracetamol 120 mg" are different products.
  const found = (
    await tx.all<{ id: string }>(
      `SELECT id FROM products
       WHERE deleted_at IS NULL AND lower(name) = lower(?)
       AND lower(COALESCE(strength,'')) = lower(?)
       ORDER BY created_at ASC LIMIT 1`,
      [row.name, row.strength ?? ''],
    )
  )[0];
  return found ? { id: found.id, matchedOn: 'name' as const } : { id: null, matchedOn: null };
}

const DEFAULT_UNIT_FALLBACK = ['piece', 'tablet', 'pack'];

async function resolveRow(
  tx: SqlExecutor,
  spreadsheetRow: number,
  row: ProductImportRowInput,
  caches: { units: Map<string, string | null>; categories: Map<string, string | null> },
): Promise<Resolution> {
  const issues: ProductImportIssue[] = [];
  const note = (field: string, message: string, severity: 'error' | 'warning' = 'error') =>
    issues.push({ row: spreadsheetRow, field, message, severity });

  const productType =
    normaliseEnum(row.productType, productTypes, productTypeAliases) ??
    (row.productType ? null : ('medicine' as const));
  if (!productType) note('productType', `Unknown product type "${row.productType}".`);

  let dosageForm: (typeof dosageForms)[number] | null = null;
  if (row.dosageForm) {
    dosageForm = normaliseEnum(row.dosageForm, dosageForms, dosageFormAliases);
    if (!dosageForm) note('dosageForm', `Unknown dosage form "${row.dosageForm}".`);
  }

  const purchaseCostKobo = parseNairaToKobo(row.purchaseCostKobo);
  if (purchaseCostKobo === 'invalid')
    note('purchaseCostKobo', 'Purchase cost must be an amount in naira, e.g. 120.50.');
  const sellingPriceKobo = parseNairaToKobo(row.sellingPriceKobo);
  if (sellingPriceKobo === 'invalid')
    note('sellingPriceKobo', 'Selling price must be an amount in naira, e.g. 220.00.');
  const reorderLevel = parsePositiveInt(row.reorderLevel);
  if (reorderLevel === 'invalid') note('reorderLevel', 'Reorder level must be a whole number.');
  const packSize = parsePositiveInt(row.packSize);
  if (packSize === 'invalid') note('packSize', 'Pack size must be a whole number.');

  const baseUnitLabel = row.baseUnit || (productType === 'medicine' ? 'tablet' : 'piece');
  let baseUnitId = await resolveReference(tx, 'units', baseUnitLabel, caches.units);
  if (!baseUnitId) {
    for (const fallback of DEFAULT_UNIT_FALLBACK) {
      baseUnitId = await resolveReference(tx, 'units', fallback, caches.units);
      if (baseUnitId) break;
    }
    if (baseUnitId)
      note(
        'baseUnit',
        `Unit "${baseUnitLabel}" was not found; falling back to the default base unit.`,
        'warning',
      );
    else note('baseUnit', 'No base unit is available. Add a unit before importing.');
  }

  const categoryId = row.category
    ? await resolveReference(tx, 'categories', row.category, caches.categories)
    : null;
  if (row.category && !categoryId)
    note(
      'category',
      `Category "${row.category}" was not found; the product will be uncategorised.`,
      'warning',
    );

  const expiryTracked =
    row.expiryTracked === undefined || row.expiryTracked.trim() === ''
      ? productType === 'medicine'
      : /^(yes|y|true|1)$/i.test(row.expiryTracked.trim());
  if (!/^(yes|y|no|n|true|false|1|0)?$/i.test(row.expiryTracked?.trim() ?? ''))
    note('expiryTracked', 'Expiry tracking must be yes or no.');

  const status =
    row.status && /^(inactive|disabled|no)$/i.test(row.status.trim()) ? 'inactive' : 'active';
  if (row.status && !/^(active|inactive|disabled|yes|no|enabled)$/i.test(row.status.trim()))
    note('status', `Unknown status "${row.status}"; the product will be active.`, 'warning');

  const existing = await findExisting(tx, row);

  const candidate = {
    name: row.name,
    genericName: row.genericName ?? null,
    brand: row.brand ?? null,
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    productType: productType ?? 'medicine',
    categoryId,
    description: null,
    manufacturer: row.manufacturer ?? null,
    dosageForm,
    strength: row.strength ?? null,
    packSize: packSize === 'invalid' ? null : packSize,
    purchaseCostKobo: purchaseCostKobo === 'invalid' ? 0 : (purchaseCostKobo ?? 0),
    sellingPriceKobo: sellingPriceKobo === 'invalid' ? 0 : (sellingPriceKobo ?? 0),
    reorderLevel: reorderLevel === 'invalid' ? 0 : (reorderLevel ?? 0),
    baseUnitId: baseUnitId ?? '00000000-0000-4000-8000-000000000000',
    isExpiryTracked: expiryTracked,
    status: status as 'active' | 'inactive',
    units: [],
    allowBelowCost: false,
  };

  const parsed = productInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) note(issue.path.join('.') || 'row', issue.message);
  }

  return {
    row: spreadsheetRow,
    input: parsed.success ? parsed.data : (candidate as ProductInput),
    name: row.name,
    matchedOn: existing.matchedOn,
    existingId: existing.id,
    issues,
  };
}

export async function importProducts(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: {
    rows: ProductImportRowInput[];
    preview: boolean;
    idempotencyKey?: string;
    fileName?: string;
    updateExisting: boolean;
  },
): Promise<ProductImportReport> {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'products.import');

    if (input.idempotencyKey) {
      const prior = (
        await tx.all<{ report_json: string }>(
          'SELECT report_json FROM product_import_runs WHERE idempotency_key = ?',
          [await importKeyHash(input.idempotencyKey)],
        )
      )[0];
      // A repeat submission returns the recorded run: no second write, no duplicated products.
      if (prior) return JSON.parse(prior.report_json) as ProductImportReport;
    }

    const caches = { units: new Map(), categories: new Map() };
    const resolutions: Resolution[] = [];
    for (const [index, row] of input.rows.entries())
      resolutions.push(await resolveRow(tx, index + 2, row, caches));

    const issues = resolutions.flatMap((resolution) => resolution.issues);
    const blocked = issues.some((issue) => issue.severity === 'error');
    const rows: ProductImportRowResult[] = resolutions.map((resolution) => {
      const errors = resolution.issues.filter((issue) => issue.severity === 'error');
      const warnings = resolution.issues.filter((issue) => issue.severity === 'warning');
      const action: ProductImportRowResult['action'] = errors.length
        ? 'error'
        : resolution.existingId
          ? input.updateExisting
            ? 'update'
            : 'skip'
          : 'create';
      return {
        row: resolution.row,
        name: resolution.name,
        action,
        productId: resolution.existingId,
        matchedOn: resolution.matchedOn,
        messages: [...errors, ...warnings].map((issue) => `${issue.field}: ${issue.message}`),
      };
    });

    const counts = {
      createCount: rows.filter((row) => row.action === 'create').length,
      updateCount: rows.filter((row) => row.action === 'update').length,
      skipCount: rows.filter((row) => row.action === 'skip').length,
      errorCount: rows.filter((row) => row.action === 'error').length,
    };
    const report: ProductImportReport = {
      id: null,
      preview: input.preview,
      totalRows: input.rows.length,
      ...counts,
      issues,
      rows,
      blocked: blocked && !input.preview,
      createdAt: null,
    };

    if (input.preview) {
      await audit(tx, {
        action: 'product.import_previewed',
        actorId: auth.user.id,
        deviceId: auth.deviceId,
        requestId,
        entityType: 'product_import',
        metadata: {
          totalRows: report.totalRows,
          createCount: counts.createCount,
          updateCount: counts.updateCount,
          errorCount: counts.errorCount,
        },
      });
      return report;
    }

    // Nothing is written when any row is invalid: a partial catalogue is worse than a rejection.
    if (blocked)
      throw new ApiError(
        400,
        'IMPORT_HAS_ERRORS',
        `This import was not applied because ${counts.errorCount} row${counts.errorCount === 1 ? '' : 's'} need attention. Fix them and try again — nothing was saved.`,
      );

    const runId = crypto.randomUUID();
    for (const resolution of resolutions) {
      /**
       * The per-row writers take the transaction that is already open. Opening a nested
       * transaction on the serialized connection would deadlock, and re-validating the session for
       * every one of thousands of rows would be needless work — the authority was checked once, at
       * the top of this transaction, and the row rules still run in full.
       */
      if (rows.find((row) => row.row === resolution.row)?.action === 'create')
        await createProductIn(tx, auth, requestId, resolution.input);
      else if (resolution.existingId && input.updateExisting)
        await updateProductIn(tx, auth, requestId, resolution.existingId, resolution.input);
    }

    report.id = runId;
    report.createdAt = new Date().toISOString();
    await tx.run(
      `INSERT INTO product_import_runs
        (id,idempotency_key,file_name,total_rows,created_rows,updated_rows,skipped_rows,failed_rows,dry_run,status,report_json,created_by,device_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,0,'completed',?,?,?,?)`,
      [
        runId,
        /**
         * The database stores the key as a fixed-width SHA-256 of whatever the client sent, so the
         * contract can accept a short human key while the column keeps a uniform fingerprint. The
         * lookup above hashes the same way, so a repeat submission still matches.
         */
        await importKeyHash(input.idempotencyKey ?? `run-${runId}`),
        input.fileName ?? null,
        report.totalRows,
        counts.createCount,
        counts.updateCount,
        counts.skipCount,
        0,
        JSON.stringify(report),
        auth.user.id,
        auth.deviceId,
        report.createdAt,
      ],
    );
    await audit(tx, {
      action: 'product.imported',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'product_import',
      entityId: runId,
      metadata: {
        totalRows: report.totalRows,
        created: counts.createCount,
        updated: counts.updateCount,
        skipped: counts.skipCount,
      },
    });
    return report;
  });
}

/** Recent import runs, so a shopkeeper can see what was applied and when. */
export async function listImportRuns(db: SqlExecutor): Promise<ProductImportRun[]> {
  const rows = await db.all<{
    id: string;
    file_name: string | null;
    total_rows: number;
    created_rows: number;
    updated_rows: number;
    skipped_rows: number;
    dry_run: number;
    status: string;
    created_at: string;
    created_by_name: string | null;
  }>(
    `SELECT r.id,r.file_name,r.total_rows,r.created_rows,r.updated_rows,r.skipped_rows,r.dry_run,r.status,r.created_at,u.full_name AS created_by_name
     FROM product_import_runs r LEFT JOIN users u ON u.id = r.created_by
     ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
  );
  return rows.map<ProductImportRun>((row) => ({
    id: row.id,
    fileName: row.file_name,
    totalRows: Number(row.total_rows),
    createdRows: Number(row.created_rows),
    updatedRows: Number(row.updated_rows),
    skippedRows: Number(row.skipped_rows),
    dryRun: row.dry_run === 1,
    status: row.status,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }));
}

/**
 * Recompute `search_text` for a whole catalogue. Exposed because an import, a restore or a future
 * migration must be able to rebuild derived data without touching a single business field.
 */
export async function rebuildSearchText(tx: SqlExecutor) {
  const rows = await tx.all<{
    id: string;
    name: string;
    generic_name: string | null;
    brand: string | null;
    sku: string | null;
    barcode: string | null;
    manufacturer: string | null;
    dosage_form: string | null;
    strength: string | null;
  }>(
    'SELECT id,name,generic_name,brand,sku,barcode,manufacturer,dosage_form,strength FROM products',
  );
  for (const row of rows)
    await tx.run('UPDATE products SET search_text = ? WHERE id = ?', [
      productSearchText({
        name: row.name,
        genericName: row.generic_name,
        brand: row.brand,
        sku: row.sku,
        barcode: row.barcode,
        manufacturer: row.manufacturer,
        dosageForm: row.dosage_form,
        strength: row.strength,
      }),
      row.id,
    ]);
  return rows.length;
}

export const importRowLimit = MAX_EXISTING_CHECKS;
