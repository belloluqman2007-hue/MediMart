import type { Migration } from './migrations';

/**
 * Phase 8 is additive. Released migrations v1–v13 are never edited: this version only adds columns
 * (as `<TABLE>_v14` rebuilds where a CHECK constraint must change), new tables, new indexes and new
 * capability grants.
 *
 * What it adds, and why:
 *
 * 1. **Pharmacy identity.** `dosage_form` and `strength` turn free text into a searchable, filterable
 *    attribute so "Paracetamol 500 mg tablet" and "Paracetamol 120 mg/5 ml syrup" are different
 *    catalogue entries, not two similar names. `pack_size` records how many base units a retail pack
 *    contains (a useful display and a bulk-import column).
 * 2. **Catalogue scale.** A single normalised `search_text` column plus a covering index gives
 *    `LIKE '%term%'` a much narrower scan than six ORed columns, and `products.import` is a separate
 *    capability because a bulk write must not ride on `products.create`.
 * 3. **Clinical records.** `clinical_addenda` lets an authorized professional attach a dated,
 *    attributed correction to a consultation or prescription without rewriting the original note.
 * 4. **Product deactivation audit.** Nothing structural; the existing `products.deactivate` grant is
 *    unchanged and stays the authority.
 *
 * Every statement is written so it can only ever add: no DROP of a live object beyond the temporary
 * rebuild tables that the plan copies back from, and no row is deleted.
 */

/**
 * `products` gains nullable columns. Adding columns does not require a rebuild, but SQLite cannot add
 * a column with a CHECK that references another column, so the new constraints are enforced in the
 * API (and mirrored in the shared zod schema).
 */
const dosageForms = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'solution',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'gel',
  'drops',
  'inhaler',
  'suppository',
  'powder',
  'sachet',
  'patch',
  'spray',
  'lozenge',
  'other',
] as const;

const capabilityGrants: Array<{ id: string; role: string; permission: string }> = [
  { id: '40000000-0000-4000-8000-000000000101', role: 'owner', permission: 'products.import' },
  {
    id: '40000000-0000-4000-8000-000000000102',
    role: 'administrator',
    permission: 'products.import',
  },
  { id: '40000000-0000-4000-8000-000000000103', role: 'manager', permission: 'products.import' },
  {
    id: '40000000-0000-4000-8000-000000000104',
    role: 'storekeeper',
    permission: 'products.import',
  },
  // A pharmacist maintains the medicine catalogue, including bulk onboarding of new lines.
  { id: '40000000-0000-4000-8000-000000000105', role: 'pharmacist', permission: 'products.import' },
  // Clinical addenda: the professional who may write a note may correct it, never silently replace it.
  {
    id: '40000000-0000-4000-8000-000000000111',
    role: 'owner',
    permission: 'consultations.amend',
  },
  {
    id: '40000000-0000-4000-8000-000000000112',
    role: 'administrator',
    permission: 'consultations.amend',
  },
  {
    id: '40000000-0000-4000-8000-000000000113',
    role: 'healthcare_professional',
    permission: 'consultations.amend',
  },
];

const newPermissions: Array<{ index: number; code: string; description: string }> = [
  { index: 130, code: 'products.import', description: 'Catalogue: bulk import products' },
  { index: 131, code: 'consultations.amend', description: 'Healthcare: record clinical addenda' },
  { index: 132, code: 'staff.deactivate', description: 'Staff: disable a staff account' },
  { index: 133, code: 'staff.reset_password', description: 'Staff: reset a staff password' },
  { index: 134, code: 'permissions.manage', description: 'Permissions: change role grants' },
];

const staffGrants: Array<{ id: string; role: string; permission: string }> = [
  // Disabling an account and resetting a password are owner/administrator duties only.
  {
    id: '40000000-0000-4000-8000-000000000121',
    role: 'owner',
    permission: 'staff.deactivate',
  },
  {
    id: '40000000-0000-4000-8000-000000000122',
    role: 'administrator',
    permission: 'staff.deactivate',
  },
  {
    id: '40000000-0000-4000-8000-000000000123',
    role: 'owner',
    permission: 'staff.reset_password',
  },
  {
    id: '40000000-0000-4000-8000-000000000124',
    role: 'administrator',
    permission: 'staff.reset_password',
  },
];

const permissionRows = newPermissions.map(
  (permission) =>
    `INSERT OR IGNORE INTO permissions (id,code,description) VALUES ('4a000000-0000-4000-8000-${String(permission.index).padStart(12, '0')}','${permission.code}','${permission.description}')`,
);

const grantRows = (grants: typeof capabilityGrants) =>
  grants.map(
    (grant) => `INSERT OR IGNORE INTO role_permissions (id,role_id,permission_id)
      SELECT '${grant.id}', r.id, p.id FROM roles r, permissions p
      WHERE r.code='${grant.role}' AND p.code='${grant.permission}'`,
  );

/**
 * The same expression `productSearchText` builds in TypeScript, so the backfill of an existing
 * catalogue produces byte-identical text to a row the API writes tomorrow. Unaliased on purpose: an
 * `UPDATE` cannot introduce a table alias, and copying an aliased expression here would silently
 * break the upgrade.
 */
export const productSearchExpression = `lower(
  name || ' ' ||
  COALESCE(generic_name,'') || ' ' ||
  COALESCE(brand,'') || ' ' ||
  COALESCE(sku,'') || ' ' ||
  COALESCE(barcode,'') || ' ' ||
  COALESCE(manufacturer,'') || ' ' ||
  COALESCE(dosage_form,'') || ' ' ||
  COALESCE(strength,'')
)`;

export const phase8Migrations: readonly Migration[] = [
  {
    version: 14,
    name: 'pharmacy_catalogue_clinical_addenda_and_staff_administration',
    statements: [
      // --- 1. Pharmacy identity on the catalogue -------------------------------------------
      `ALTER TABLE products ADD COLUMN dosage_form TEXT CHECK (dosage_form IS NULL OR dosage_form IN (${dosageForms.map((form) => `'${form}'`).join(',')}))`,
      `ALTER TABLE products ADD COLUMN strength TEXT CHECK (strength IS NULL OR length(strength) <= 60)`,
      `ALTER TABLE products ADD COLUMN pack_size INTEGER CHECK (pack_size IS NULL OR (typeof(pack_size) = 'integer' AND pack_size BETWEEN 1 AND 1000000))`,
      /**
       * A single normalised column that the catalogue search reads instead of six ORed LIKE terms.
       * It is derived data: the API keeps it in step with every insert and update, and this
       * statement backfills existing rows so an upgraded database searches correctly immediately.
       */
      `ALTER TABLE products ADD COLUMN search_text TEXT`,
      `UPDATE products SET search_text = ${productSearchExpression}`,
      `CREATE INDEX idx_products_search_text ON products(search_text)`,
      // Filtering by expiry status is a pharmacy requirement; support it with the batch index.
      `CREATE INDEX idx_products_dosage_form ON products(dosage_form) WHERE deleted_at IS NULL`,
      `CREATE INDEX idx_products_strength ON products(strength) WHERE strength IS NOT NULL`,

      // --- 2. Bulk import bookkeeping -------------------------------------------------------
      /**
       * One row per import run. Failures are reported per row and never silently skipped, so the
       * shopkeeper can fix the spreadsheet and re-run it. `idempotency_key` makes a double-submit
       * return the original run instead of importing twice.
       */
      `CREATE TABLE product_import_runs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),
        file_name TEXT,
        total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
        created_rows INTEGER NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
        updated_rows INTEGER NOT NULL DEFAULT 0 CHECK (updated_rows >= 0),
        skipped_rows INTEGER NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
        failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
        dry_run INTEGER NOT NULL CHECK (dry_run IN (0,1)),
        status TEXT NOT NULL CHECK (status IN ('completed','failed')),
        report_json TEXT NOT NULL CHECK (json_valid(report_json)),
        created_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
        device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX idx_product_import_runs_created ON product_import_runs(created_at DESC)`,

      // --- 3. Clinical addenda --------------------------------------------------------------
      /**
       * A consultation or prescription note is never rewritten once it has been saved. A correction
       * is a new, attributed, dated entry that points at the record it amends. `entity_type` keeps
       * this one table usable by both clinical records and future ones.
       */
      `CREATE TABLE clinical_addenda (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('consultation','prescription','patient')),
        entity_id TEXT NOT NULL,
        patient_id TEXT REFERENCES patients(id) ON DELETE RESTRICT,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 3 AND 4000),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX idx_clinical_addenda_entity ON clinical_addenda(entity_type,entity_id,created_at DESC)`,
      `CREATE INDEX idx_clinical_addenda_patient ON clinical_addenda(patient_id,created_at DESC)`,
      // Addenda are an appendix to the record, so they are append-only like the stock ledger.
      `CREATE TRIGGER clinical_addenda_no_update BEFORE UPDATE ON clinical_addenda BEGIN SELECT RAISE(ABORT, 'clinical addenda are append-only'); END`,
      `CREATE TRIGGER clinical_addenda_no_delete BEFORE DELETE ON clinical_addenda BEGIN SELECT RAISE(ABORT, 'clinical addenda are append-only'); END`,

      // --- 4. Administration capabilities ----------------------------------------------------
      ...permissionRows,
      ...grantRows(capabilityGrants),
      ...grantRows(staffGrants),
      /**
       * `permissions.manage` already exists in the catalogue (it is deliberately absent from the
       * administrator role so only the owner can re-map role grants). The row above is
       * INSERT OR IGNORE, so this does not change the ownership model for existing databases; it
       * only documents the capability in an environment where the row was missing.
       */
      `INSERT OR IGNORE INTO role_permissions (id,role_id,permission_id)
        SELECT '40000000-0000-4000-8000-000000000125', r.id, p.id FROM roles r, permissions p
        WHERE r.code='owner' AND p.code='permissions.manage'`,
    ],
  },
];
