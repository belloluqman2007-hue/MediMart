import type { Migration } from './migrations';
import { kobo, optionalUuid, timestamp, uuid } from './schema-helpers';

/**
 * Phase 3 schema: Point of Sale, Sales, Receipts, Payments, Customers & Debts.
 *
 * Released migrations (v1–v6) are never edited. Migration 7 rebuilds `stock_movements`
 * safely to add `sale`, `sale_void`, and `sale_return` ledger types while preserving
 * every existing movement row, index, and append-only trigger, and adds the Phase 3
 * sales, payment, reversal, customer, and debt tables.
 */
const audited = `created_at ${timestamp}, updated_at ${timestamp}`;
const actor = `created_by TEXT REFERENCES users(id) ON DELETE RESTRICT, updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT`;

const movementTypesV7 = `'opening_stock','stock_received','adjustment_increase','adjustment_decrease','damaged','expired','correction','sale','sale_void','sale_return'`;
const decreaseOnlyV7 = `'adjustment_decrease','damaged','expired','sale'`;
const increaseOnlyV7 = `'opening_stock','stock_received','adjustment_increase','sale_void','sale_return'`;

const stockMovementColumns = [
  'id',
  'operation_id',
  'operation_fingerprint',
  'product_id',
  'batch_id',
  'movement_type',
  'quantity',
  'previous_balance',
  'new_balance',
  'unit_cost_kobo',
  'reason',
  'reference_id',
  'supplier_id',
  'user_id',
  'device_id',
  'created_at',
].join(',');

const stockMovementsRebuilt = `CREATE TABLE stock_movements_v7 (
      ${uuid('id')} PRIMARY KEY,
      ${optionalUuid('operation_id')} UNIQUE,
      operation_fingerprint TEXT CHECK (operation_fingerprint IS NULL OR (length(operation_fingerprint) = 64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*')),
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      batch_id TEXT REFERENCES product_batches(id) ON DELETE RESTRICT,
      movement_type TEXT NOT NULL CHECK (movement_type IN (${movementTypesV7})),
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
      CHECK ((movement_type IN (${decreaseOnlyV7}) AND quantity < 0) OR (movement_type IN (${increaseOnlyV7}) AND quantity > 0) OR movement_type = 'correction')
    ) STRICT`;

const hexFingerprint = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'))`;

const salesCore: Migration = {
  version: 7,
  name: 'sales_pos_payments_and_debts',
  requiresForeignKeysOff: true,
  statements: [
    // Rebuild stock_movements with Phase 3 movement types while preserving all rows and invariants.
    stockMovementsRebuilt,
    `INSERT INTO stock_movements_v7 (${stockMovementColumns}) SELECT ${stockMovementColumns} FROM stock_movements`,
    'DROP TABLE stock_movements',
    'ALTER TABLE stock_movements_v7 RENAME TO stock_movements',
    'CREATE INDEX idx_movements_product_created ON stock_movements(product_id, created_at, id)',
    'CREATE INDEX idx_movements_created ON stock_movements(created_at, id)',
    'CREATE INDEX idx_movements_batch ON stock_movements(batch_id, created_at)',
    'CREATE INDEX idx_movements_type ON stock_movements(movement_type, created_at)',
    'CREATE INDEX idx_movements_supplier ON stock_movements(supplier_id, created_at)',
    `CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END`,
    `CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END`,

    // Atomic sequence counters for receipt numbers, reversals, debt payments, and customer codes.
    `CREATE TABLE receipt_counters (
      prefix TEXT NOT NULL CHECK (length(prefix) BETWEEN 2 AND 16),
      counter_date TEXT NOT NULL CHECK (length(counter_date) BETWEEN 6 AND 16),
      last_number INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_number) = 'integer' AND last_number >= 0),
      updated_at ${timestamp},
      PRIMARY KEY (prefix, counter_date)
    ) STRICT`,

    // Customers
    `CREATE TABLE customers (
      ${uuid('id')} PRIMARY KEY,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(code) BETWEEN 3 AND 32),
      full_name TEXT NOT NULL COLLATE NOCASE CHECK (length(full_name) BETWEEN 2 AND 160),
      phone TEXT CHECK (phone IS NULL OR length(phone) <= 40),
      email TEXT COLLATE NOCASE CHECK (email IS NULL OR length(email) <= 254),
      address TEXT CHECK (address IS NULL OR length(address) <= 400),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
      credit_limit_kobo INTEGER CHECK (credit_limit_kobo IS NULL OR (typeof(credit_limit_kobo) = 'integer' AND credit_limit_kobo >= 0 AND credit_limit_kobo <= 1000000000000)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited}, ${actor}, deleted_at TEXT
    ) STRICT`,
    'CREATE INDEX idx_customers_name ON customers(full_name)',
    'CREATE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL',
    'CREATE INDEX idx_customers_status ON customers(status, full_name)',

    // Sales header (never deleted; reversals use void/refund status + sale_reversals)
    `CREATE TABLE sales (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      receipt_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(receipt_number) BETWEEN 4 AND 40),
      customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
      customer_name_snapshot TEXT NOT NULL CHECK (length(customer_name_snapshot) BETWEEN 1 AND 160),
      customer_phone_snapshot TEXT CHECK (customer_phone_snapshot IS NULL OR length(customer_phone_snapshot) <= 40),
      ${kobo('subtotal_kobo')},
      ${kobo('line_discount_total_kobo')},
      ${kobo('cart_discount_kobo')},
      ${kobo('discount_total_kobo')},
      discount_reason TEXT CHECK (discount_reason IS NULL OR length(discount_reason) <= 300),
      discount_authorized_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      ${kobo('total_kobo')},
      ${kobo('cogs_kobo')},
      ${kobo('tendered_kobo')},
      ${kobo('change_due_kobo')},
      ${kobo('amount_paid_kobo')},
      ${kobo('initial_outstanding_kobo')},
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','partially_refunded','refunded')),
      payment_status TEXT NOT NULL CHECK (payment_status IN ('paid','partial','credit','voided','refunded')),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
      sold_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      voided_at TEXT,
      voided_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
      void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited},
      CHECK (discount_total_kobo = line_discount_total_kobo + cart_discount_kobo),
      CHECK (discount_total_kobo <= subtotal_kobo),
      CHECK (total_kobo = subtotal_kobo - discount_total_kobo),
      CHECK (amount_paid_kobo <= total_kobo),
      CHECK (tendered_kobo - change_due_kobo = amount_paid_kobo),
      CHECK (initial_outstanding_kobo = total_kobo - amount_paid_kobo),
      CHECK (discount_total_kobo = 0 OR (discount_reason IS NOT NULL AND discount_authorized_by IS NOT NULL)),
      CHECK (initial_outstanding_kobo = 0 OR customer_id IS NOT NULL)
    ) STRICT`,
    'CREATE INDEX idx_sales_created ON sales(created_at, id)',
    'CREATE INDEX idx_sales_customer ON sales(customer_id, created_at)',
    'CREATE INDEX idx_sales_status ON sales(status, created_at)',
    'CREATE INDEX idx_sales_payment_status ON sales(payment_status, created_at)',
    'CREATE INDEX idx_sales_sold_by ON sales(sold_by, created_at)',
    `CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'completed sales cannot be deleted; use void or refund reversals'); END`,

    // Sale line items
    `CREATE TABLE sale_items (
      ${uuid('id')} PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
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
      ${kobo('unit_price_kobo')},
      ${kobo('line_subtotal_kobo')},
      ${kobo('line_discount_kobo')},
      ${kobo('line_total_kobo')},
      ${kobo('net_total_kobo')},
      ${kobo('cogs_kobo')},
      quantity_refunded_base INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_refunded_base) = 'integer' AND quantity_refunded_base >= 0 AND quantity_refunded_base <= base_quantity),
      ${kobo('amount_refunded_kobo')},
      created_at ${timestamp},
      CHECK (line_subtotal_kobo = unit_price_kobo * quantity),
      CHECK (line_discount_kobo <= line_subtotal_kobo),
      CHECK (line_total_kobo = line_subtotal_kobo - line_discount_kobo),
      CHECK (net_total_kobo <= line_total_kobo),
      CHECK (amount_refunded_kobo <= net_total_kobo)
    ) STRICT`,
    'CREATE INDEX idx_sale_items_sale ON sale_items(sale_id)',
    'CREATE INDEX idx_sale_items_product ON sale_items(product_id)',
    `CREATE TRIGGER sale_items_no_delete BEFORE DELETE ON sale_items BEGIN SELECT RAISE(ABORT, 'sale items cannot be deleted'); END`,

    // FEFO batch allocations per sale item
    `CREATE TABLE sale_item_allocations (
      ${uuid('id')} PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      batch_id TEXT REFERENCES product_batches(id) ON DELETE RESTRICT,
      batch_number_snapshot TEXT CHECK (batch_number_snapshot IS NULL OR length(batch_number_snapshot) <= 64),
      expiry_date_snapshot TEXT CHECK (expiry_date_snapshot IS NULL OR length(expiry_date_snapshot) = 10),
      movement_id TEXT NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
      base_quantity INTEGER NOT NULL CHECK (typeof(base_quantity) = 'integer' AND base_quantity >= 1),
      ${kobo('unit_cost_kobo')},
      quantity_reversed INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity_reversed) = 'integer' AND quantity_reversed >= 0 AND quantity_reversed <= base_quantity),
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_sale_allocations_sale ON sale_item_allocations(sale_id)',
    'CREATE INDEX idx_sale_allocations_item ON sale_item_allocations(sale_item_id)',
    'CREATE INDEX idx_sale_allocations_batch ON sale_item_allocations(batch_id)',
    `CREATE TRIGGER sale_item_allocations_no_delete BEFORE DELETE ON sale_item_allocations BEGIN SELECT RAISE(ABORT, 'sale allocations cannot be deleted'); END`,

    // Append-only sale payments & payment reversals
    `CREATE TABLE sale_payments (
      ${uuid('id')} PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      ${optionalUuid('operation_id')} UNIQUE,
      payment_kind TEXT NOT NULL CHECK (payment_kind IN ('sale_payment','void_reversal','refund_payout')),
      method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','pos_terminal','credit_reduction')),
      ${kobo('tendered_kobo')},
      ${kobo('change_kobo')},
      ${kobo('net_amount_kobo')},
      reference TEXT CHECK (reference IS NULL OR length(reference) <= 100),
      recorded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (change_kobo <= tendered_kobo),
      CHECK (net_amount_kobo = tendered_kobo - change_kobo),
      CHECK (payment_kind != 'sale_payment' OR (method IN ('cash','bank_transfer','pos_terminal') AND net_amount_kobo > 0))
    ) STRICT`,
    'CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id, created_at)',
    'CREATE INDEX idx_sale_payments_created ON sale_payments(created_at, method, payment_kind)',
    `CREATE TRIGGER sale_payments_no_update BEFORE UPDATE ON sale_payments BEGIN SELECT RAISE(ABORT, 'sale payments are append-only'); END`,
    `CREATE TRIGGER sale_payments_no_delete BEFORE DELETE ON sale_payments BEGIN SELECT RAISE(ABORT, 'sale payments are append-only'); END`,

    // Append-only void & refund headers
    `CREATE TABLE sale_reversals (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      reversal_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(reversal_number) BETWEEN 4 AND 40),
      reversal_type TEXT NOT NULL CHECK (reversal_type IN ('void','refund')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
      restock_items INTEGER NOT NULL DEFAULT 1 CHECK (restock_items IN (0,1)),
      ${kobo('total_reversed_kobo')},
      ${kobo('cogs_reversed_kobo')},
      ${kobo('cash_refunded_kobo')},
      ${kobo('debt_reduced_kobo')},
      refund_method TEXT CHECK (refund_method IS NULL OR refund_method IN ('cash','bank_transfer','pos_terminal')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_sale_reversals_sale ON sale_reversals(sale_id, created_at)',
    'CREATE INDEX idx_sale_reversals_created ON sale_reversals(created_at, reversal_type)',
    `CREATE TRIGGER sale_reversals_no_update BEFORE UPDATE ON sale_reversals BEGIN SELECT RAISE(ABORT, 'sale reversals are append-only'); END`,
    `CREATE TRIGGER sale_reversals_no_delete BEFORE DELETE ON sale_reversals BEGIN SELECT RAISE(ABORT, 'sale reversals are append-only'); END`,

    // Append-only void & refund line items
    `CREATE TABLE sale_reversal_items (
      ${uuid('id')} PRIMARY KEY,
      reversal_id TEXT NOT NULL REFERENCES sale_reversals(id) ON DELETE RESTRICT,
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
      base_quantity INTEGER NOT NULL CHECK (typeof(base_quantity) = 'integer' AND base_quantity >= 1),
      ${kobo('amount_kobo')},
      ${kobo('cogs_reversed_kobo')},
      restocked INTEGER NOT NULL CHECK (restocked IN (0,1)),
      created_at ${timestamp}
    ) STRICT`,
    'CREATE INDEX idx_sale_reversal_items_reversal ON sale_reversal_items(reversal_id)',
    `CREATE TRIGGER sale_reversal_items_no_update BEFORE UPDATE ON sale_reversal_items BEGIN SELECT RAISE(ABORT, 'sale reversal items are append-only'); END`,
    `CREATE TRIGGER sale_reversal_items_no_delete BEFORE DELETE ON sale_reversal_items BEGIN SELECT RAISE(ABORT, 'sale reversal items are append-only'); END`,

    // Customer debts (never deleted)
    `CREATE TABLE customer_debts (
      ${uuid('id')} PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
      ${kobo('original_amount_kobo')},
      ${kobo('amount_paid_kobo')},
      ${kobo('amount_cancelled_kobo')},
      ${kobo('outstanding_kobo')},
      due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      status TEXT NOT NULL CHECK (status IN ('open','partial','settled','cancelled')),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      ${audited},
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      CHECK (original_amount_kobo > 0),
      CHECK (outstanding_kobo = original_amount_kobo - amount_paid_kobo - amount_cancelled_kobo)
    ) STRICT`,
    'CREATE INDEX idx_debts_customer_status ON customer_debts(customer_id, status, created_at)',
    'CREATE INDEX idx_debts_status_created ON customer_debts(status, created_at)',
    'CREATE INDEX idx_debts_due ON customer_debts(due_date) WHERE outstanding_kobo > 0',
    `CREATE TRIGGER customer_debts_no_delete BEFORE DELETE ON customer_debts BEGIN SELECT RAISE(ABORT, 'customer debts cannot be deleted'); END`,

    // Append-only debt repayments
    `CREATE TABLE debt_payments (
      ${uuid('id')} PRIMARY KEY,
      ${uuid('operation_id')} UNIQUE,
      ${hexFingerprint('operation_fingerprint')},
      receipt_number TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(receipt_number) BETWEEN 4 AND 40),
      debt_id TEXT NOT NULL REFERENCES customer_debts(id) ON DELETE RESTRICT,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
      ${kobo('amount_kobo')},
      method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','pos_terminal')),
      reference TEXT CHECK (reference IS NULL OR length(reference) <= 100),
      notes TEXT CHECK (notes IS NULL OR length(notes) <= 400),
      ${kobo('balance_before_kobo')},
      ${kobo('balance_after_kobo')},
      recorded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
      created_at ${timestamp},
      CHECK (amount_kobo > 0),
      CHECK (balance_before_kobo >= amount_kobo),
      CHECK (balance_after_kobo = balance_before_kobo - amount_kobo)
    ) STRICT`,
    'CREATE INDEX idx_debt_payments_debt ON debt_payments(debt_id, created_at)',
    'CREATE INDEX idx_debt_payments_customer ON debt_payments(customer_id, created_at)',
    'CREATE INDEX idx_debt_payments_created ON debt_payments(created_at, method)',
    `CREATE TRIGGER debt_payments_no_update BEFORE UPDATE ON debt_payments BEGIN SELECT RAISE(ABORT, 'debt payments are append-only'); END`,
    `CREATE TRIGGER debt_payments_no_delete BEFORE DELETE ON debt_payments BEGIN SELECT RAISE(ABORT, 'debt payments are append-only'); END`,
  ],
};

const permissionId = (index: number) =>
  `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const roleId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const grantId = (index: number) => `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const roleIndex = {
  owner: 1,
  administrator: 2,
  manager: 3,
  pharmacist: 4,
  healthcare_professional: 5,
  cashier: 6,
  storekeeper: 7,
} as const;

const phase3Permissions: Array<{ index: number; code: string; description: string }> = [
  { index: 41, code: 'sales.view', description: 'sales: view' },
  { index: 42, code: 'sales.create', description: 'sales: create' },
  { index: 43, code: 'sales.discount', description: 'sales: apply discounts' },
  { index: 44, code: 'sales.void', description: 'sales: void completed sales' },
  { index: 45, code: 'sales.refund', description: 'sales: process refunds' },
  { index: 46, code: 'payments.record', description: 'payments: record sale payments' },
  { index: 47, code: 'customers.manage', description: 'customers: create and edit' },
  { index: 48, code: 'debts.repay', description: 'debts: record repayments' },
];

const phase3Grants: Record<keyof typeof roleIndex, string[]> = {
  owner: phase3Permissions.map((entry) => entry.code),
  administrator: phase3Permissions.map((entry) => entry.code),
  manager: phase3Permissions.map((entry) => entry.code),
  pharmacist: ['sales.view', 'sales.create', 'payments.record', 'customers.manage'],
  healthcare_professional: [],
  cashier: ['sales.view', 'sales.create', 'payments.record', 'customers.manage'],
  storekeeper: [],
};

const seedStatements: string[] = [];
for (const permission of phase3Permissions) {
  seedStatements.push(
    `INSERT INTO permissions (id,code,description) VALUES ('${permissionId(permission.index)}','${permission.code}','${permission.description}')`,
  );
}
// Migration 6 ended at grantId(64).
let grantCounter = 64;
for (const [role, codes] of Object.entries(phase3Grants) as Array<
  [keyof typeof roleIndex, string[]]
>) {
  for (const code of codes) {
    const permission = phase3Permissions.find((entry) => entry.code === code);
    if (!permission) continue;
    seedStatements.push(
      `INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('${grantId(++grantCounter)}','${roleId(roleIndex[role])}','${permissionId(permission.index)}')`,
    );
  }
}

const salesPermissionsAndRoleGrants: Migration = {
  version: 8,
  name: 'sales_permissions_and_role_grants',
  statements: seedStatements,
};

export const salesMigrations: readonly Migration[] = [salesCore, salesPermissionsAndRoleGrants];
