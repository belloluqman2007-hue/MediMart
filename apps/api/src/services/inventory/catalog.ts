import type { Database, SqlExecutor } from '@medimart/database';
import type {
  CategoryInput,
  CategorySummary,
  Paginated,
  SupplierDetail,
  SupplierInput,
  SupplierSummary,
  UnitInput,
} from '@medimart/shared';
import type { AuthContext } from '../auth';
import { ApiError } from '../../errors';
import { audit } from '../audit';
import { assertPermission, likePattern, paginate } from './common';

const categorySelect = `
  SELECT c.*, parent.name AS parent_name,
    (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count,
    (SELECT COUNT(*) FROM categories child WHERE child.parent_id = c.id) AS child_count
  FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id`;

type CategoryRow = {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  kind: CategorySummary['kind'];
  description: string | null;
  product_count: number;
  child_count: number;
};

function mapCategory(row: CategoryRow): CategorySummary {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    parentName: row.parent_name,
    kind: row.kind,
    description: row.description,
    productCount: Number(row.product_count),
    childCount: Number(row.child_count),
  };
}

export async function listCategories(db: SqlExecutor, search?: string): Promise<CategorySummary[]> {
  const rows = search
    ? await db.all<CategoryRow>(
        `${categorySelect} WHERE c.name LIKE ? ESCAPE '\\' ORDER BY c.kind ASC, c.name ASC`,
        [likePattern(search)],
      )
    : await db.all<CategoryRow>(`${categorySelect} ORDER BY c.kind ASC, c.name ASC`);
  return rows.map(mapCategory);
}

async function assertParent(tx: SqlExecutor, parentId: string | null, selfId?: string) {
  if (!parentId) return null;
  if (parentId === selfId)
    throw new ApiError(409, 'CATEGORY_CYCLE', 'A category cannot be its own parent.');
  const parent = (
    await tx.all<{ id: string; kind: CategorySummary['kind'] }>(
      'SELECT id,kind FROM categories WHERE id = ?',
      [parentId],
    )
  )[0];
  if (!parent) throw new ApiError(400, 'CATEGORY_NOT_FOUND', 'Select a valid parent category.');
  if (!selfId) return parent;
  // Walk upwards from the prospective parent: it must never reach this category.
  const all = await tx.all<{ id: string; parent_id: string | null }>(
    'SELECT id,parent_id FROM categories',
  );
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === selfId)
      throw new ApiError(
        409,
        'CATEGORY_CYCLE',
        'A category cannot be moved beneath one of its own children.',
      );
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = all.find((row) => row.id === cursor)?.parent_id ?? null;
  }
  return parent;
}

async function assertSiblingNameUnique(
  tx: SqlExecutor,
  name: string,
  parentId: string | null,
  excludeId?: string,
) {
  const rows = parentId
    ? await tx.all<{ id: string }>(
        'SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND parent_id = ?',
        [name, parentId],
      )
    : await tx.all<{ id: string }>(
        'SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND parent_id IS NULL',
        [name],
      );
  if (rows.some((row) => row.id !== excludeId))
    throw new ApiError(
      409,
      'CATEGORY_EXISTS',
      'A category with this name already exists at this level.',
    );
}

export async function createCategory(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: CategoryInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'categories.manage');
    const parent = await assertParent(tx, input.parentId);
    await assertSiblingNameUnique(tx, input.name, input.parentId);
    const id = crypto.randomUUID();
    await tx.run(
      'INSERT INTO categories (id,name,parent_id,kind,description,created_by,updated_by,device_id) VALUES (?,?,?,?,?,?,?,?)',
      [
        id,
        input.name,
        input.parentId,
        parent ? parent.kind : input.kind,
        input.description ?? null,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
      ],
    );
    await audit(tx, {
      action: 'category.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'category',
      entityId: id,
      metadata: { hasParent: Boolean(input.parentId) },
    });
    return mapCategory((await tx.all<CategoryRow>(`${categorySelect} WHERE c.id = ?`, [id]))[0]!);
  });
}

export async function updateCategory(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: CategoryInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'categories.manage');
    const existing = (await tx.all<CategoryRow>(`${categorySelect} WHERE c.id = ?`, [id]))[0];
    if (!existing) throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'This category does not exist.');
    const parent = await assertParent(tx, input.parentId, id);
    await assertSiblingNameUnique(tx, input.name, input.parentId, id);
    await tx.run(
      `UPDATE categories SET name=?,parent_id=?,kind=?,description=?,updated_by=?,device_id=?,
        version=version+1,updated_at=? WHERE id=?`,
      [
        input.name,
        input.parentId,
        parent ? parent.kind : input.kind,
        input.description ?? null,
        auth.user.id,
        auth.deviceId,
        new Date().toISOString(),
        id,
      ],
    );
    await audit(tx, {
      action: 'category.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'category',
      entityId: id,
    });
    return mapCategory((await tx.all<CategoryRow>(`${categorySelect} WHERE c.id = ?`, [id]))[0]!);
  });
}

export async function deleteCategory(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
) {
  await db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'categories.manage');
    const existing = await tx.all('SELECT id FROM categories WHERE id = ?', [id]);
    if (!existing.length)
      throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'This category does not exist.');
    const products = (
      await tx.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM products WHERE category_id = ? AND deleted_at IS NULL',
        [id],
      )
    )[0]!.count;
    const children = (
      await tx.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM categories WHERE parent_id = ?',
        [id],
      )
    )[0]!.count;
    if (Number(products) > 0 || Number(children) > 0)
      throw new ApiError(
        409,
        'CATEGORY_IN_USE',
        'Move or remove this category’s products and child categories first.',
      );
    await tx.run('DELETE FROM categories WHERE id = ?', [id]);
    await audit(tx, {
      action: 'category.deleted',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'category',
      entityId: id,
    });
  });
}

export async function createUnit(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: UnitInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'units.manage');
    const duplicate = await tx.all('SELECT id FROM units WHERE code = ? COLLATE NOCASE', [
      input.code,
    ]);
    if (duplicate.length)
      throw new ApiError(409, 'UNIT_EXISTS', 'A unit with this code already exists.');
    const id = crypto.randomUUID();
    await tx.run(
      'INSERT INTO units (id,code,name,symbol,is_system,created_by) VALUES (?,?,?,?,0,?)',
      [id, input.code, input.name, input.symbol, auth.user.id],
    );
    await audit(tx, {
      action: 'unit.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'unit',
      entityId: id,
    });
    return (
      await tx.all<{
        id: string;
        code: string;
        name: string;
        symbol: string;
        is_system: number;
      }>('SELECT id,code,name,symbol,is_system FROM units WHERE id = ?', [id])
    )[0]!;
  });
}

export async function updateUnit(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: UnitInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'units.manage');
    const existing = (
      await tx.all<{ id: string; is_system: number; code: string }>(
        'SELECT id,is_system,code FROM units WHERE id = ?',
        [id],
      )
    )[0];
    if (!existing) throw new ApiError(404, 'UNIT_NOT_FOUND', 'This unit does not exist.');
    if (existing.is_system === 1) {
      if (input.code !== existing.code)
        throw new ApiError(409, 'UNIT_LOCKED', 'A built-in unit code cannot be changed.');
    } else {
      const duplicate = await tx.all<{ id: string }>(
        'SELECT id FROM units WHERE code = ? COLLATE NOCASE',
        [input.code],
      );
      if (duplicate.some((row) => row.id !== id))
        throw new ApiError(409, 'UNIT_EXISTS', 'A unit with this code already exists.');
    }
    const code = existing.is_system === 1 ? existing.code : input.code;
    await tx.run('UPDATE units SET code=?,name=?,symbol=?,updated_at=? WHERE id=?', [
      code,
      input.name,
      input.symbol,
      new Date().toISOString(),
      id,
    ]);
    await audit(tx, {
      action: 'unit.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'unit',
      entityId: id,
    });
    return (
      await tx.all<{
        id: string;
        code: string;
        name: string;
        symbol: string;
        is_system: number;
      }>('SELECT id,code,name,symbol,is_system FROM units WHERE id = ?', [id])
    )[0]!;
  });
}

export async function deleteUnit(db: Database, auth: AuthContext, requestId: string, id: string) {
  await db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'units.manage');
    const existing = (
      await tx.all<{ is_system: number }>('SELECT is_system FROM units WHERE id = ?', [id])
    )[0];
    if (!existing) throw new ApiError(404, 'UNIT_NOT_FOUND', 'This unit does not exist.');
    if (existing.is_system === 1)
      throw new ApiError(409, 'UNIT_LOCKED', 'Built-in units cannot be deleted.');
    const used = (
      await tx.all<{ count: number }>(
        `SELECT (SELECT COUNT(*) FROM products WHERE base_unit_id = ?)
          + (SELECT COUNT(*) FROM product_units WHERE unit_id = ?) AS count`,
        [id, id],
      )
    )[0]!.count;
    if (Number(used) > 0)
      throw new ApiError(409, 'UNIT_IN_USE', 'Remove this unit from products before deleting it.');
    await tx.run('DELETE FROM units WHERE id = ?', [id]);
    await audit(tx, {
      action: 'unit.deleted',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'unit',
      entityId: id,
    });
  });
}

type SupplierRow = {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  business_info: string | null;
  notes: string | null;
  status: SupplierSummary['status'];
  product_count: number;
  created_at: string;
  updated_at: string;
};

function mapSupplier(row: SupplierRow): SupplierSummary {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    businessInfo: row.business_info,
    notes: row.notes,
    status: row.status,
    productCount: Number(row.product_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const supplierSelect = `
  SELECT s.*, (SELECT COUNT(DISTINCT b.product_id) FROM product_batches b WHERE b.supplier_id = s.id) AS product_count
  FROM suppliers s`;

export async function listSuppliers(
  db: SqlExecutor,
  query: { search?: string; status?: string; page: number; pageSize: number },
): Promise<Paginated<SupplierSummary>> {
  const where: string[] = ['s.deleted_at IS NULL'];
  const values: Array<string | number> = [];
  if (query.search) {
    where.push(
      "(s.name LIKE ? ESCAPE '\\' OR s.contact_person LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(query.search);
    values.push(pattern, pattern, pattern, pattern);
  }
  if (query.status) {
    where.push('s.status = ?');
    values.push(query.status);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (
    await db.all<{ count: number }>(`SELECT COUNT(*) AS count FROM suppliers s ${clause}`, values)
  )[0]!.count;
  const rows = await db.all<SupplierRow>(
    `${supplierSelect} ${clause} ORDER BY s.name ASC LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return paginate(rows.map(mapSupplier), query.page, query.pageSize, Number(total));
}

export async function getSupplierDetail(db: SqlExecutor, id: string): Promise<SupplierDetail> {
  const row = (await db.all<SupplierRow>(`${supplierSelect} WHERE s.id = ?`, [id]))[0];
  if (!row) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'This supplier does not exist.');
  const products = await db.all<{
    id: string;
    name: string;
    sku: string | null;
    stock_quantity: number;
  }>(
    `SELECT DISTINCT p.id, p.name, p.sku, COALESCE(b.quantity, 0) AS stock_quantity
    FROM product_batches pb JOIN products p ON p.id = pb.product_id
    LEFT JOIN stock_balances b ON b.product_id = p.id
    WHERE pb.supplier_id = ? AND p.deleted_at IS NULL ORDER BY p.name ASC LIMIT 100`,
    [id],
  );
  const receipts = await db.all<{
    id: string;
    product_id: string;
    product_name: string;
    batch_number: string | null;
    quantity: number;
    unit_cost_kobo: number | null;
    created_at: string;
    user_name: string | null;
  }>(
    `SELECT m.id, m.product_id, p.name AS product_name, b.batch_number, m.quantity, m.unit_cost_kobo,
      m.created_at, u.full_name AS user_name
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN product_batches b ON b.id = m.batch_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.supplier_id = ? AND m.movement_type IN ('stock_received','opening_stock')
    ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
    [id],
  );
  return {
    ...mapSupplier(row),
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      stockQuantity: Number(product.stock_quantity),
    })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      productId: receipt.product_id,
      productName: receipt.product_name,
      batchNumber: receipt.batch_number,
      quantity: Number(receipt.quantity),
      unitCostKobo: receipt.unit_cost_kobo === null ? null : Number(receipt.unit_cost_kobo),
      createdAt: receipt.created_at,
      userName: receipt.user_name,
    })),
  };
}

async function assertSupplierNameUnique(tx: SqlExecutor, name: string, excludeId?: string) {
  const rows = await tx.all<{ id: string }>(
    'SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL',
    [name],
  );
  if (rows.some((row) => row.id !== excludeId))
    throw new ApiError(409, 'SUPPLIER_EXISTS', 'A supplier with this name already exists.');
}

const supplierColumns = 'name,contact_person,phone,email,address,business_info,notes,status';

export async function createSupplier(
  db: Database,
  auth: AuthContext,
  requestId: string,
  input: SupplierInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'suppliers.manage');
    await assertSupplierNameUnique(tx, input.name);
    const id = crypto.randomUUID();
    await tx.run(
      `INSERT INTO suppliers (id,${supplierColumns},created_by,updated_by,device_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.name,
        input.contactPerson ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.businessInfo ?? null,
        input.notes ?? null,
        input.status,
        auth.user.id,
        auth.user.id,
        auth.deviceId,
      ],
    );
    await audit(tx, {
      action: 'supplier.created',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'supplier',
      entityId: id,
    });
    return getSupplierDetail(tx, id);
  });
}

export async function updateSupplier(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  input: SupplierInput,
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'suppliers.manage');
    const existing = await tx.all('SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL', [
      id,
    ]);
    if (!existing.length)
      throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'This supplier does not exist.');
    await assertSupplierNameUnique(tx, input.name, id);
    await tx.run(
      `UPDATE suppliers SET name=?,contact_person=?,phone=?,email=?,address=?,business_info=?,notes=?,
        status=?,updated_by=?,device_id=?,version=version+1,updated_at=? WHERE id=?`,
      [
        input.name,
        input.contactPerson ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.address ?? null,
        input.businessInfo ?? null,
        input.notes ?? null,
        input.status,
        auth.user.id,
        auth.deviceId,
        new Date().toISOString(),
        id,
      ],
    );
    await audit(tx, {
      action: 'supplier.updated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'supplier',
      entityId: id,
    });
    return getSupplierDetail(tx, id);
  });
}

export async function setSupplierStatus(
  db: Database,
  auth: AuthContext,
  requestId: string,
  id: string,
  status: SupplierSummary['status'],
) {
  return db.transaction(async (tx) => {
    await assertPermission(tx, auth, 'suppliers.manage');
    const existing = await tx.all('SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL', [
      id,
    ]);
    if (!existing.length)
      throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'This supplier does not exist.');
    await tx.run(
      'UPDATE suppliers SET status=?,updated_by=?,device_id=?,version=version+1,updated_at=? WHERE id=?',
      [status, auth.user.id, auth.deviceId, new Date().toISOString(), id],
    );
    await audit(tx, {
      action: status === 'active' ? 'supplier.activated' : 'supplier.deactivated',
      actorId: auth.user.id,
      deviceId: auth.deviceId,
      requestId,
      entityType: 'supplier',
      entityId: id,
    });
    return getSupplierDetail(tx, id);
  });
}
