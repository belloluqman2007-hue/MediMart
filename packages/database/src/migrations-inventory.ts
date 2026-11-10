import type { Migration } from './migrations';
import { kobo, optionalUuid, timestamp, uuid } from './schema-helpers';

/**
 * Phase 2 inventory schema. Released migrations are immutable: add version 6+ for
 * changes. Money is INTEGER kobo; quantities are INTEGER base units (no REAL).
 */
const audited = `created_at ${timestamp}, updated_at ${timestamp}`;
const actor = `created_by TEXT REFERENCES users(id) ON DELETE RESTRICT, updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT`;

const movementTypes = `'opening_stock','stock_received','adjustment_increase','adjustment_decrease','damaged','expired','correction'`;
const decreaseOnly = `'adjustment_decrease','damaged','expired'`;
const increaseOnly = `'opening_stock','stock_received','adjustment_increase'`;

const inventoryCore: Migration = {
  version: 4,
  name: 'inventory_core',
  statements: [
    `CREATE TABLE units (
      ${uuid('id')} PRIMARY KEY,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(code) BETWEEN 2 AND 32 AND code NOT GLOB '*[^a-z0-9_]*' AND substr(code,1,1) GLOB '[a-z]'),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
      symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 12),
      is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      ${audited}, created_by TEXT REFERENCES users(id) ON DELETE RESTRICT
    ) STRICT`,
    `CREATE TABLE categories (
      ${uuid('id')} PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 2 AND 80),
      parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('pharmacy','mini_mart','general')),
      description TEXT CHECK (description IS NULL OR length(description) <= 400),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor},
      CHECK (parent_id IS NULL OR parent_id != id)
    ) STRICT`,
    `CREATE UNIQUE INDEX idx_categories_root_name ON categories(name) WHERE parent_id IS NULL`,
    `CREATE UNIQUE INDEX idx_categories_parent_name ON categories(parent_id, name) WHERE parent_id IS NOT NULL`,
    `CREATE INDEX idx_categories_parent ON categories(parent_id)`,
    `CREATE TABLE suppliers (
      ${uuid('id')} PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 2 AND 120),
      contact_person TEXT CHECK (contact_person IS NULL OR length(contact_person) <= 120),
      phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
      email TEXT CHECK (email IS NULL OR length(email) <= 254),
      address TEXT CHECK (address IS NULL OR length(address) <= 400),
      business_info TEXT CHECK (business_info IS NULL OR length(business_info) <= 400),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor}, deleted_at TEXT
    ) STRICT`,
    `CREATE UNIQUE INDEX idx_suppliers_name ON suppliers(name) WHERE deleted_at IS NULL`,
    `CREATE INDEX idx_suppliers_status ON suppliers(status, name)`,
    `CREATE TABLE products (
      ${uuid('id')} PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
      generic_name TEXT CHECK (generic_name IS NULL OR length(generic_name) <= 160),
      brand TEXT CHECK (brand IS NULL OR length(brand) <= 120),
      sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 2 AND 64),
      barcode TEXT CHECK (barcode IS NULL OR length(barcode) BETWEEN 2 AND 64),
      product_type TEXT NOT NULL CHECK (product_type IN ('medicine','foodstuff','drinks','snacks','general')),
      category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
      description TEXT CHECK (description IS NULL OR length(description) <= 2000),
      manufacturer TEXT CHECK (manufacturer IS NULL OR length(manufacturer) <= 160),
      ${kobo('purchase_cost_kobo')},
      ${kobo('selling_price_kobo')},
      reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reorder_level) = 'integer' AND reorder_level >= 0),
      base_unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      is_expiry_tracked INTEGER NOT NULL DEFAULT 0 CHECK (is_expiry_tracked IN (0,1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor}, deleted_at TEXT,
      CHECK (selling_price_kobo >= purchase_cost_kobo)
    ) STRICT`,
    `CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND deleted_at IS NULL`,
    `CREATE UNIQUE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL`,
    `CREATE INDEX idx_products_name ON products(name)`,
    `CREATE INDEX idx_products_category ON products(category_id)`,
    `CREATE INDEX idx_products_type_status ON products(product_type, status)`,
    `CREATE INDEX idx_products_created ON products(created_at, id)`,
    `CREATE TABLE product_units (
      ${uuid('id')} PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      factor INTEGER NOT NULL CHECK (typeof(factor) = 'integer' AND factor >= 1 AND factor <= 1000000),
      ${audited},
      UNIQUE (product_id, unit_id)
    ) STRICT`,
    `CREATE INDEX idx_product_units_unit ON product_units(unit_id)`,
    `CREATE TABLE product_batches (
      ${uuid('id')} PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      batch_number TEXT NOT NULL COLLATE NOCASE CHECK (length(batch_number) BETWEEN 1 AND 64),
      manufacturing_date TEXT CHECK (manufacturing_date IS NULL OR manufacturing_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      expiry_date TEXT CHECK (expiry_date IS NULL OR expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      quantity_received INTEGER NOT NULL CHECK (typeof(quantity_received) = 'integer' AND quantity_received >= 0),
      quantity_remaining INTEGER NOT NULL CHECK (typeof(quantity_remaining) = 'integer' AND quantity_remaining >= 0),
      purchase_cost_kobo INTEGER NOT NULL DEFAULT 0 CHECK (typeof(purchase_cost_kobo) = 'integer' AND purchase_cost_kobo >= 0 AND purchase_cost_kobo <= 1000000000000),
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
      recorded_at ${timestamp},
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor},
      CHECK (manufacturing_date IS NULL OR expiry_date IS NULL OR expiry_date >= manufacturing_date)
    ) STRICT`,
    `CREATE UNIQUE INDEX idx_batches_product_number ON product_batches(product_id, batch_number)`,
    `CREATE INDEX idx_batches_expiry ON product_batches(expiry_date) WHERE quantity_remaining > 0`,
    `CREATE INDEX idx_batches_product_expiry ON product_batches(product_id, expiry_date)`,
    `CREATE INDEX idx_batches_supplier ON product_batches(supplier_id)`,
    `CREATE TABLE stock_balances (
      product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity) = 'integer' AND quantity >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      updated_at ${timestamp}
    ) STRICT`,
    `CREATE INDEX idx_stock_balances_quantity ON stock_balances(quantity)`,
    `CREATE TABLE stock_movements (
      ${uuid('id')} PRIMARY KEY,
      ${optionalUuid('operation_id')} UNIQUE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      batch_id TEXT REFERENCES product_batches(id) ON DELETE RESTRICT,
      movement_type TEXT NOT NULL CHECK (movement_type IN (${movementTypes})),
      quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity != 0),
      previous_balance INTEGER NOT NULL CHECK (typeof(previous_balance) = 'integer' AND previous_balance >= 0),
      new_balance INTEGER NOT NULL CHECK (typeof(new_balance) = 'integer' AND new_balance >= 0),
      unit_cost_kobo INTEGER CHECK (unit_cost_kobo IS NULL OR (typeof(unit_cost_kobo) = 'integer' AND unit_cost_kobo >= 0 AND unit_cost_kobo <= 1000000000000)),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
      reference_id TEXT CHECK (reference_id IS NULL OR length(reference_id) <= 64),
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
      user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (new_balance = previous_balance + quantity),
      CHECK ((movement_type IN (${decreaseOnly}) AND quantity < 0) OR (movement_type IN (${increaseOnly}) AND quantity > 0) OR movement_type = 'correction')
    ) STRICT`,
    `CREATE INDEX idx_movements_product_created ON stock_movements(product_id, created_at, id)`,
    `CREATE INDEX idx_movements_created ON stock_movements(created_at, id)`,
    `CREATE INDEX idx_movements_batch ON stock_movements(batch_id, created_at)`,
    `CREATE INDEX idx_movements_type ON stock_movements(movement_type, created_at)`,
    `CREATE INDEX idx_movements_supplier ON stock_movements(supplier_id, created_at)`,
    `CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END`,
    `CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END`,
    `CREATE TABLE stock_adjustments (
      ${uuid('id')} PRIMARY KEY,
      movement_id TEXT NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      batch_id TEXT REFERENCES product_batches(id) ON DELETE RESTRICT,
      adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('adjustment_increase','adjustment_decrease','damaged','expired','correction')),
      quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
      reference_id TEXT CHECK (reference_id IS NULL OR length(reference_id) <= 64),
      user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp}
    ) STRICT`,
    `CREATE INDEX idx_adjustments_product ON stock_adjustments(product_id, created_at)`,
    `CREATE TRIGGER stock_adjustments_no_update BEFORE UPDATE ON stock_adjustments BEGIN SELECT RAISE(ABORT, 'stock adjustments are append-only'); END`,
    `CREATE TRIGGER stock_adjustments_no_delete BEFORE DELETE ON stock_adjustments BEGIN SELECT RAISE(ABORT, 'stock adjustments are append-only'); END`,
  ],
};

/** Deterministic identifiers so re-running an empty database yields the same reference data. */
const permissionId = (index: number) =>
  `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const roleId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const grantId = (index: number) => `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const unitId = (index: number) => `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const categoryId = (index: number) => `51000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Index positions continue migration 3 (which seeded 25 permissions) and its roles 1–7. */
const roleIndex = {
  owner: 1,
  administrator: 2,
  manager: 3,
  pharmacist: 4,
  healthcare_professional: 5,
  cashier: 6,
  storekeeper: 7,
} as const;

const newPermissions: Array<{ index: number; code: string }> = [
  { index: 26, code: 'inventory.reports.view' },
  { index: 27, code: 'inventory.settings.manage' },
  { index: 28, code: 'products.create' },
  { index: 29, code: 'products.edit' },
  { index: 30, code: 'products.deactivate' },
  { index: 31, code: 'categories.manage' },
  { index: 32, code: 'units.manage' },
  { index: 33, code: 'batches.view' },
  { index: 34, code: 'batches.manage' },
  { index: 35, code: 'stock.view' },
  { index: 36, code: 'stock.receive' },
  { index: 37, code: 'stock.adjust' },
  { index: 38, code: 'stock.write_off' },
  { index: 39, code: 'suppliers.manage' },
];

const grants: Record<keyof typeof roleIndex, string[]> = {
  owner: newPermissions.map((permission) => permission.code),
  administrator: newPermissions.map((permission) => permission.code),
  manager: newPermissions.map((permission) => permission.code),
  pharmacist: [
    'products.create',
    'products.edit',
    'batches.view',
    'batches.manage',
    'stock.view',
    'stock.receive',
    'stock.adjust',
    'stock.write_off',
  ],
  healthcare_professional: [],
  cashier: [],
  storekeeper: [
    'inventory.reports.view',
    'products.create',
    'products.edit',
    'categories.manage',
    'units.manage',
    'batches.view',
    'batches.manage',
    'stock.view',
    'stock.receive',
    'stock.adjust',
    'stock.write_off',
    'suppliers.manage',
  ],
};

const units: Array<{ index: number; code: string; name: string; symbol: string }> = [
  { index: 1, code: 'piece', name: 'Piece', symbol: 'pc' },
  { index: 2, code: 'pack', name: 'Pack', symbol: 'pack' },
  { index: 3, code: 'carton', name: 'Carton', symbol: 'ctn' },
  { index: 4, code: 'bottle', name: 'Bottle', symbol: 'btl' },
  { index: 5, code: 'sachet', name: 'Sachet', symbol: 'sch' },
  { index: 6, code: 'tablet', name: 'Tablet', symbol: 'tab' },
  { index: 7, code: 'capsule', name: 'Capsule', symbol: 'cap' },
  { index: 8, code: 'kilogram', name: 'Kilogram', symbol: 'kg' },
  { index: 9, code: 'gram', name: 'Gram', symbol: 'g' },
  { index: 10, code: 'litre', name: 'Litre', symbol: 'L' },
  { index: 11, code: 'millilitre', name: 'Millilitre', symbol: 'ml' },
];

const categories: Array<{ index: number; name: string; kind: 'pharmacy' | 'mini_mart' }> = [
  { index: 1, name: 'Antibiotics', kind: 'pharmacy' },
  { index: 2, name: 'Analgesics', kind: 'pharmacy' },
  { index: 3, name: 'Antimalarials', kind: 'pharmacy' },
  { index: 4, name: 'Vitamins', kind: 'pharmacy' },
  { index: 5, name: 'Antihistamines', kind: 'pharmacy' },
  { index: 6, name: 'First Aid', kind: 'pharmacy' },
  { index: 7, name: 'Drinks', kind: 'mini_mart' },
  { index: 8, name: 'Snacks', kind: 'mini_mart' },
  { index: 9, name: 'Foodstuff', kind: 'mini_mart' },
  { index: 10, name: 'Household Items', kind: 'mini_mart' },
  { index: 11, name: 'Personal Care', kind: 'mini_mart' },
];

const statements: string[] = [];
for (const permission of newPermissions)
  statements.push(
    `INSERT INTO permissions (id,code,description) VALUES ('${permissionId(permission.index)}','${permission.code}','${permission.code.replace('.', ': ')}')`,
  );
let grantIndex = 0;
for (const [role, codes] of Object.entries(grants) as Array<[keyof typeof roleIndex, string[]]>) {
  for (const code of codes) {
    const permission = newPermissions.find((entry) => entry.code === code);
    if (!permission) continue;
    statements.push(
      `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('${grantId(++grantIndex)}','${roleId(roleIndex[role])}','${permissionId(permission.index)}')`,
    );
  }
}
for (const unit of units)
  statements.push(
    `INSERT INTO units (id,code,name,symbol,is_system) VALUES ('${unitId(unit.index)}','${unit.code}','${unit.name}','${unit.symbol}',1)`,
  );
for (const category of categories)
  statements.push(
    `INSERT INTO categories (id,name,kind) VALUES ('${categoryId(category.index)}','${category.name}','${category.kind}')`,
  );

const inventoryPermissionsAndReferenceData: Migration = {
  version: 5,
  name: 'inventory_permissions_and_reference_data',
  statements,
};

/**
 * Version 6 replaces the released `selling_price_kobo >= purchase_cost_kobo` CHECK, which made
 * an authorised below-cost price impossible, with an authorisation-gated rule enforced by the API.
 * SQLite cannot drop a CHECK constraint, so `products` is rebuilt with the same columns and one
 * relaxed condition; every index is recreated and all rows are copied unchanged. Rebuilding
 * requires foreign-key enforcement to be suspended for the plan (see `migrate`), and integrity is
 * re-verified with `PRAGMA foreign_key_check` before the transaction commits.
 */
const productsRebuilt = `CREATE TABLE products_v6 (
      ${uuid('id')} PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
      generic_name TEXT CHECK (generic_name IS NULL OR length(generic_name) <= 160),
      brand TEXT CHECK (brand IS NULL OR length(brand) <= 120),
      sku TEXT CHECK (sku IS NULL OR length(sku) BETWEEN 2 AND 64),
      barcode TEXT CHECK (barcode IS NULL OR length(barcode) BETWEEN 2 AND 64),
      product_type TEXT NOT NULL CHECK (product_type IN ('medicine','foodstuff','drinks','snacks','general')),
      category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
      description TEXT CHECK (description IS NULL OR length(description) <= 2000),
      manufacturer TEXT CHECK (manufacturer IS NULL OR length(manufacturer) <= 160),
      ${kobo('purchase_cost_kobo')},
      ${kobo('selling_price_kobo')},
      reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reorder_level) = 'integer' AND reorder_level >= 0),
      base_unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      is_expiry_tracked INTEGER NOT NULL DEFAULT 0 CHECK (is_expiry_tracked IN (0,1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor}, deleted_at TEXT
    ) STRICT`;

const productColumnsInOrder = [
  'id',
  'name',
  'generic_name',
  'brand',
  'sku',
  'barcode',
  'product_type',
  'category_id',
  'description',
  'manufacturer',
  'purchase_cost_kobo',
  'selling_price_kobo',
  'reorder_level',
  'base_unit_id',
  'is_expiry_tracked',
  'status',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'device_id',
  'deleted_at',
].join(',');

const belowCostPricing: Migration = {
  version: 6,
  name: 'inventory_below_cost_pricing',
  requiresForeignKeysOff: true,
  statements: [
    // Idempotency beyond product/type/quantity: the canonical fingerprint of the whole movement.
    `ALTER TABLE stock_movements ADD COLUMN operation_fingerprint TEXT CHECK (operation_fingerprint IS NULL OR (length(operation_fingerprint) = 64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'))`,
    productsRebuilt,
    `INSERT INTO products_v6 (${productColumnsInOrder}) SELECT ${productColumnsInOrder} FROM products`,
    'DROP TABLE products',
    'ALTER TABLE products_v6 RENAME TO products',
    'CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND deleted_at IS NULL',
    'CREATE UNIQUE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL',
    'CREATE INDEX idx_products_name ON products(name)',
    'CREATE INDEX idx_products_category ON products(category_id)',
    'CREATE INDEX idx_products_type_status ON products(product_type, status)',
    'CREATE INDEX idx_products_created ON products(created_at, id)',
    `INSERT INTO permissions (id,code,description) VALUES ('${permissionId(40)}','products.price.below_cost','products: price below cost')`,
    // Grant identifiers continue after the 62 grants seeded by version 5.
    `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('${grantId(63)}','${roleId(roleIndex.owner)}','${permissionId(40)}')`,
    `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('${grantId(64)}','${roleId(roleIndex.administrator)}','${permissionId(40)}')`,
  ],
};

export const inventoryMigrations: readonly Migration[] = [
  inventoryCore,
  inventoryPermissionsAndReferenceData,
  belowCostPricing,
];
