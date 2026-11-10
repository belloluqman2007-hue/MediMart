import type { Migration } from './migrations';
import { kobo, timestamp, uuid } from './schema-helpers';

/**
 * Phase 5 schema: purchasing, goods receiving, supplier payments, expenses and the
 * append-only financial history that the reports are built from.
 *
 * Financial invariants:
 * - A purchase order never changes stock and never counts as cash paid.
 * - A supplier payable arises only when goods are actually received.
 * - Payments and reversals are append-only; allocations are never deleted.
 * - Every amount is INTEGER kobo; every quantity is INTEGER base units.
 *
 * Released migrations v1–v8 are never edited. This module adds v9 and v10.
 */
const audited = `created_at ${timestamp}, updated_at ${timestamp}`;
const actor = `created_by TEXT REFERENCES users(id) ON DELETE RESTRICT, updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT`;
const hexFingerprint = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'))`;
const datePattern = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;

const financeCore: Migration = {
  version: 9,
  name: 'purchasing_receiving_supplier_payments_and_expenses',
  statements: [
    // --- Purchase orders (a commercial intent; never a stock or cash movement) ----
    `CREATE TABLE purchase_orders (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      reference_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(reference_number) BETWEEN 4 AND 40),
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      supplier_name_snapshot TEXT NOT NULL CHECK (length(supplier_name_snapshot) BETWEEN 1 AND 120),
      supplier_phone_snapshot TEXT CHECK (supplier_phone_snapshot IS NULL OR length(supplier_phone_snapshot) <= 40),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partially_received','received','cancelled')),
      ${datePattern('expected_delivery_date')},
      ${kobo('subtotal_kobo')},
      ${kobo('line_discount_total_kobo')},
      ${kobo('order_discount_kobo')},
      ${kobo('discount_total_kobo')},
      discount_reason TEXT CHECK (discount_reason IS NULL OR length(discount_reason) <= 300),
      ${kobo('additional_charges_kobo')},
      additional_charges_reason TEXT CHECK (additional_charges_reason IS NULL OR length(additional_charges_reason) <= 300),
      ${kobo('total_kobo')},
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
      ordered_at TEXT,
      ordered_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      cancelled_at TEXT,
      cancelled_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor},
      CHECK (discount_total_kobo = line_discount_total_kobo + order_discount_kobo),
      CHECK (discount_total_kobo <= subtotal_kobo),
      CHECK (order_discount_kobo <= subtotal_kobo - line_discount_total_kobo),
      CHECK (total_kobo = subtotal_kobo - discount_total_kobo + additional_charges_kobo),
      CHECK (discount_total_kobo = 0 OR discount_reason IS NOT NULL),
      CHECK (additional_charges_kobo = 0 OR additional_charges_reason IS NOT NULL),
      CHECK (status NOT IN ('ordered','partially_received','received') OR ordered_at IS NOT NULL),
      CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL) OR (status != 'cancelled' AND cancelled_at IS NULL AND cancel_reason IS NULL))
    ) STRICT`,
    'CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id, created_at)',
    'CREATE INDEX idx_purchase_orders_status ON purchase_orders(status, created_at)',
    'CREATE INDEX idx_purchase_orders_created ON purchase_orders(created_at, id)',
    "CREATE INDEX idx_purchase_orders_expected ON purchase_orders(expected_delivery_date) WHERE status IN ('ordered','partially_received')",
    `CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders BEGIN SELECT RAISE(ABORT, 'purchase orders cannot be deleted; cancel instead'); END`,

    `CREATE TABLE purchase_order_items (
      ${uuid('id')} PRIMARY KEY,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      product_name_snapshot TEXT NOT NULL CHECK (length(product_name_snapshot) BETWEEN 1 AND 160),
      product_sku_snapshot TEXT CHECK (product_sku_snapshot IS NULL OR length(product_sku_snapshot) <= 64),
      product_type_snapshot TEXT NOT NULL CHECK (product_type_snapshot IN ('medicine','foodstuff','drinks','snacks','general')),
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      unit_name_snapshot TEXT NOT NULL CHECK (length(unit_name_snapshot) BETWEEN 1 AND 40),
      unit_symbol_snapshot TEXT NOT NULL CHECK (length(unit_symbol_snapshot) BETWEEN 1 AND 12),
      conversion_factor INTEGER NOT NULL CHECK (typeof(conversion_factor) = 'integer' AND conversion_factor >= 1),
      quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
      base_quantity INTEGER NOT NULL CHECK (typeof(base_quantity) = 'integer' AND base_quantity = quantity * conversion_factor),
      ${kobo('unit_cost_kobo')},
      ${kobo('line_subtotal_kobo')},
      ${kobo('line_discount_kobo')},
      ${kobo('line_total_kobo')},
      received_base_quantity INTEGER NOT NULL DEFAULT 0 CHECK (typeof(received_base_quantity) = 'integer' AND received_base_quantity >= 0 AND received_base_quantity <= base_quantity),
      created_at ${timestamp},
      CHECK (line_subtotal_kobo = unit_cost_kobo * quantity),
      CHECK (line_discount_kobo <= line_subtotal_kobo),
      CHECK (line_total_kobo = line_subtotal_kobo - line_discount_kobo),
      UNIQUE (purchase_order_id, product_id, unit_id)
    ) STRICT`,
    'CREATE INDEX idx_purchase_items_order ON purchase_order_items(purchase_order_id)',
    'CREATE INDEX idx_purchase_items_product ON purchase_order_items(product_id)',

    // --- Goods receipts (the only way a purchase increases stock) -----------------
    `CREATE TABLE goods_receipts (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      receipt_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(receipt_number) BETWEEN 4 AND 40),
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      received_date TEXT NOT NULL CHECK (received_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
      ${kobo('received_value_kobo')},
      total_rejected_base_quantity INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total_rejected_base_quantity) = 'integer' AND total_rejected_base_quantity >= 0),
      received_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_goods_receipts_order ON goods_receipts(purchase_order_id, created_at)',
    'CREATE INDEX idx_goods_receipts_supplier ON goods_receipts(supplier_id, received_date)',
    'CREATE INDEX idx_goods_receipts_date ON goods_receipts(received_date, id)',
    `CREATE TRIGGER goods_receipts_no_update BEFORE UPDATE ON goods_receipts BEGIN SELECT RAISE(ABORT, 'goods receipts are append-only'); END`,
    `CREATE TRIGGER goods_receipts_no_delete BEFORE DELETE ON goods_receipts BEGIN SELECT RAISE(ABORT, 'goods receipts are append-only'); END`,

    `CREATE TABLE goods_receipt_items (
      ${uuid('id')} PRIMARY KEY,
      goods_receipt_id TEXT NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
      purchase_order_item_id TEXT NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      unit_name_snapshot TEXT NOT NULL CHECK (length(unit_name_snapshot) BETWEEN 1 AND 40),
      unit_symbol_snapshot TEXT NOT NULL CHECK (length(unit_symbol_snapshot) BETWEEN 1 AND 12),
      conversion_factor INTEGER NOT NULL CHECK (typeof(conversion_factor) = 'integer' AND conversion_factor >= 1),
      quantity_received INTEGER NOT NULL CHECK (typeof(quantity_received) = 'integer' AND quantity_received >= 0),
      base_quantity_received INTEGER NOT NULL CHECK (typeof(base_quantity_received) = 'integer' AND base_quantity_received = quantity_received * conversion_factor),
      quantity_rejected INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_rejected) = 'integer' AND quantity_rejected >= 0),
      base_quantity_rejected INTEGER NOT NULL CHECK (typeof(base_quantity_rejected) = 'integer' AND base_quantity_rejected = quantity_rejected * conversion_factor),
      rejection_reason TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 300),
      ${kobo('unit_cost_kobo')},
      ${kobo('total_cost_kobo')},
      ${kobo('base_unit_cost_kobo')},
      batch_id TEXT REFERENCES product_batches(id) ON DELETE RESTRICT,
      batch_number_snapshot TEXT CHECK (batch_number_snapshot IS NULL OR length(batch_number_snapshot) <= 64),
      ${datePattern('manufacturing_date')},
      ${datePattern('expiry_date')},
      stock_movement_id TEXT UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (quantity_received + quantity_rejected > 0),
      CHECK (quantity_rejected = 0 OR rejection_reason IS NOT NULL),
      CHECK (total_cost_kobo = unit_cost_kobo * quantity_received),
      CHECK (base_unit_cost_kobo = 0 OR quantity_received > 0),
      UNIQUE (goods_receipt_id, purchase_order_item_id)
    ) STRICT`,
    'CREATE INDEX idx_goods_receipt_items_receipt ON goods_receipt_items(goods_receipt_id)',
    'CREATE INDEX idx_goods_receipt_items_order_item ON goods_receipt_items(purchase_order_item_id)',
    'CREATE INDEX idx_goods_receipt_items_product ON goods_receipt_items(product_id)',
    'CREATE INDEX idx_goods_receipt_items_batch ON goods_receipt_items(batch_id)',
    `CREATE TRIGGER goods_receipt_items_no_update BEFORE UPDATE ON goods_receipt_items BEGIN SELECT RAISE(ABORT, 'goods receipt lines are append-only'); END`,
    `CREATE TRIGGER goods_receipt_items_no_delete BEFORE DELETE ON goods_receipt_items BEGIN SELECT RAISE(ABORT, 'goods receipt lines are append-only'); END`,

    // --- Supplier payments (append-only money out; reversals are new records) -----
    `CREATE TABLE supplier_payments (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      payment_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(payment_number) BETWEEN 4 AND 40),
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      payment_kind TEXT NOT NULL DEFAULT 'payment' CHECK (payment_kind IN ('payment','reversal')),
      method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','pos_terminal')),
      ${kobo('amount_kobo')},
      paid_at TEXT NOT NULL CHECK (paid_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      reference TEXT CHECK (reference IS NULL OR length(reference) <= 100),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
      reversal_of_payment_id TEXT REFERENCES supplier_payments(id) ON DELETE RESTRICT,
      reversal_reason TEXT CHECK (reversal_reason IS NULL OR length(reversal_reason) <= 500),
      recorded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (amount_kobo > 0),
      CHECK ((payment_kind = 'payment' AND reversal_of_payment_id IS NULL AND reversal_reason IS NULL) OR (payment_kind = 'reversal' AND reversal_of_payment_id IS NOT NULL AND reversal_reason IS NOT NULL))
    ) STRICT`,
    'CREATE UNIQUE INDEX idx_supplier_payments_reversal_of ON supplier_payments(reversal_of_payment_id) WHERE reversal_of_payment_id IS NOT NULL',
    "CREATE UNIQUE INDEX idx_supplier_payments_reference ON supplier_payments(supplier_id, method, reference) WHERE reference IS NOT NULL AND payment_kind = 'payment'",
    'CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id, paid_at)',
    'CREATE INDEX idx_supplier_payments_paid ON supplier_payments(paid_at, id)',
    'CREATE INDEX idx_supplier_payments_method ON supplier_payments(method, paid_at)',
    `CREATE TRIGGER supplier_payments_no_update BEFORE UPDATE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are append-only'); END`,
    `CREATE TRIGGER supplier_payments_no_delete BEFORE DELETE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'supplier payments are append-only'); END`,

    `CREATE TABLE supplier_payment_allocations (
      ${uuid('id')} PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES supplier_payments(id) ON DELETE RESTRICT,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL DEFAULT 'apply' CHECK (direction IN ('apply','reverse')),
      ${kobo('amount_kobo')},
      created_at ${timestamp},
      CHECK (amount_kobo > 0),
      UNIQUE (payment_id, purchase_order_id)
    ) STRICT`,
    'CREATE INDEX idx_supplier_allocations_payment ON supplier_payment_allocations(payment_id)',
    'CREATE INDEX idx_supplier_allocations_order ON supplier_payment_allocations(purchase_order_id)',
    `CREATE TRIGGER supplier_payment_allocations_no_update BEFORE UPDATE ON supplier_payment_allocations BEGIN SELECT RAISE(ABORT, 'supplier payment allocations are append-only'); END`,
    `CREATE TRIGGER supplier_payment_allocations_no_delete BEFORE DELETE ON supplier_payment_allocations BEGIN SELECT RAISE(ABORT, 'supplier payment allocations are append-only'); END`,

    // --- Expense categories and expenses ------------------------------------------
    `CREATE TABLE expense_categories (
      ${uuid('id')} PRIMARY KEY,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(code) BETWEEN 2 AND 32 AND code NOT GLOB '*[^a-z0-9_]*' AND substr(code,1,1) GLOB '[a-z]'),
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 2 AND 80),
      description TEXT CHECK (description IS NULL OR length(description) <= 300),
      is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      ${audited}
    ) STRICT`,

    `CREATE TABLE expenses (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      expense_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(expense_number) BETWEEN 4 AND 40),
      category_id TEXT NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
      category_name_snapshot TEXT NOT NULL CHECK (length(category_name_snapshot) BETWEEN 1 AND 80),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 3 AND 500),
      ${kobo('amount_kobo')},
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank_transfer','pos_terminal')),
      expense_date TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      payee TEXT CHECK (payee IS NULL OR length(payee) <= 160),
      reference TEXT CHECK (reference IS NULL OR length(reference) <= 100),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
      attachment_name TEXT CHECK (attachment_name IS NULL OR length(attachment_name) <= 160),
      attachment_mime TEXT CHECK (attachment_mime IS NULL OR length(attachment_mime) <= 100),
      attachment_data TEXT CHECK (attachment_data IS NULL OR length(attachment_data) <= 48000),
      status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('draft','recorded','reversed')),
      recorded_at TEXT,
      recorded_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      reversed_at TEXT,
      reversed_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      reversal_reason TEXT CHECK (reversal_reason IS NULL OR length(reversal_reason) <= 500),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor},
      CHECK (amount_kobo > 0),
      CHECK ((attachment_name IS NULL AND attachment_mime IS NULL AND attachment_data IS NULL) OR (attachment_name IS NOT NULL AND attachment_mime IS NOT NULL AND attachment_data IS NOT NULL)),
      CHECK ((status = 'draft' AND recorded_at IS NULL AND recorded_by IS NULL) OR (status IN ('recorded','reversed') AND recorded_at IS NOT NULL AND recorded_by IS NOT NULL)),
      CHECK ((status = 'reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL) OR (status != 'reversed' AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL))
    ) STRICT`,
    'CREATE INDEX idx_expenses_date ON expenses(expense_date, id)',
    'CREATE INDEX idx_expenses_category ON expenses(category_id, expense_date)',
    'CREATE INDEX idx_expenses_status ON expenses(status, expense_date)',
    'CREATE INDEX idx_expenses_method ON expenses(payment_method, expense_date)',
    `CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT, 'expenses cannot be deleted; reverse instead'); END`,

    `CREATE TABLE expense_reversals (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
      ${kobo('amount_kobo')},
      reversed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (amount_kobo > 0)
    ) STRICT`,
    'CREATE INDEX idx_expense_reversals_created ON expense_reversals(created_at, id)',
    `CREATE TRIGGER expense_reversals_no_update BEFORE UPDATE ON expense_reversals BEGIN SELECT RAISE(ABORT, 'expense reversals are append-only'); END`,
    `CREATE TRIGGER expense_reversals_no_delete BEFORE DELETE ON expense_reversals BEGIN SELECT RAISE(ABORT, 'expense reversals are append-only'); END`,
  ],
};

const permissionId = (index: number) =>
  `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const roleId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const grantId = (index: number) => `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const expenseCategoryId = (index: number) =>
  `61000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const roleIndex = {
  owner: 1,
  administrator: 2,
  manager: 3,
  pharmacist: 4,
  healthcare_professional: 5,
  cashier: 6,
  storekeeper: 7,
} as const;

/** Permission indexes continue after migration 8 (which ended at 48). */
const phase5Permissions: Array<{ index: number; code: string; description: string }> = [
  { index: 49, code: 'purchases.create', description: 'purchases: create purchase orders' },
  { index: 50, code: 'purchases.edit', description: 'purchases: edit and order purchases' },
  { index: 51, code: 'purchases.cancel', description: 'purchases: cancel purchase orders' },
  { index: 52, code: 'purchases.receive', description: 'purchases: receive goods against orders' },
  {
    index: 53,
    code: 'supplier_payments.view',
    description: 'supplier payments: view payment history',
  },
  {
    index: 54,
    code: 'supplier_payments.record',
    description: 'supplier payments: record payments',
  },
  {
    index: 55,
    code: 'supplier_payments.reverse',
    description: 'supplier payments: reverse payments',
  },
  {
    index: 56,
    code: 'supplier_debts.view',
    description: 'suppliers: view balances and statements',
  },
  { index: 57, code: 'expenses.create', description: 'expenses: record expenses' },
  { index: 58, code: 'expenses.edit', description: 'expenses: edit drafts and post them' },
  { index: 59, code: 'expenses.reverse', description: 'expenses: reverse recorded expenses' },
  { index: 60, code: 'reports.export', description: 'reports: export financial reports as CSV' },
];

const phase5Grants: Record<keyof typeof roleIndex, string[]> = {
  owner: phase5Permissions.map((entry) => entry.code),
  administrator: phase5Permissions.map((entry) => entry.code),
  manager: phase5Permissions.map((entry) => entry.code),
  pharmacist: [],
  healthcare_professional: [],
  cashier: [],
  // Storekeepers execute purchasing and receiving, but never handle money or expenses.
  storekeeper: ['purchases.create', 'purchases.edit', 'purchases.receive'],
};

const expenseCategories: Array<{ index: number; code: string; name: string }> = [
  { index: 1, code: 'rent', name: 'Rent' },
  { index: 2, code: 'electricity', name: 'Electricity' },
  { index: 3, code: 'water', name: 'Water' },
  { index: 4, code: 'internet_communication', name: 'Internet and communication' },
  { index: 5, code: 'transportation', name: 'Transportation' },
  { index: 6, code: 'staff_salaries', name: 'Staff salaries' },
  { index: 7, code: 'repairs_maintenance', name: 'Repairs and maintenance' },
  { index: 8, code: 'packaging', name: 'Packaging' },
  { index: 9, code: 'cleaning_materials', name: 'Cleaning materials' },
  { index: 10, code: 'security', name: 'Security' },
  { index: 11, code: 'licences_permits', name: 'Licences and permits' },
  { index: 12, code: 'other_operating', name: 'Other operating expenses' },
];

const statements: string[] = [];
for (const permission of phase5Permissions) {
  statements.push(
    `INSERT INTO permissions (id,code,description) VALUES ('${permissionId(permission.index)}','${permission.code}','${permission.description}')`,
  );
}
// Migration 8 ended at grantId(96).
let grantCounter = 96;
for (const [role, codes] of Object.entries(phase5Grants) as Array<
  [keyof typeof roleIndex, string[]]
>) {
  for (const code of codes) {
    const permission = phase5Permissions.find((entry) => entry.code === code);
    if (!permission) continue;
    statements.push(
      `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('${grantId(++grantCounter)}','${roleId(roleIndex[role])}','${permissionId(permission.index)}')`,
    );
  }
}
for (const category of expenseCategories) {
  statements.push(
    `INSERT INTO expense_categories (id,code,name,is_system,sort_order) VALUES ('${expenseCategoryId(category.index)}','${category.code}','${category.name}',1,${category.index})`,
  );
}

const financePermissionsAndExpenseCategories: Migration = {
  version: 10,
  name: 'finance_permissions_and_expense_categories',
  statements,
};

export const financeMigrations: readonly Migration[] = [
  financeCore,
  financePermissionsAndExpenseCategories,
];
