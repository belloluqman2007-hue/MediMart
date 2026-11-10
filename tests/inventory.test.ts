import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';
import type { SessionResponse } from '@medimart/shared';

const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: ':memory:',
  bootstrapToken: 'f'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
};
const origin = 'https://trusted.medimart.test';
const ownerBody = {
  fullName: 'Inventory Owner',
  email: 'owner@inventory.test',
  password: 'A long private inventory passphrase',
  bootstrapToken: config.bootstrapToken,
};

let db: Database;
let app: ReturnType<typeof createApp>;
let owner: ReturnType<typeof request.agent>;
let ownerSession: SessionResponse;

type Agent = ReturnType<typeof request.agent>;

async function bootstrap() {
  const response = await owner
    .post('/api/auth/register-owner')
    .set('Origin', origin)
    .send(ownerBody);
  expect(response.status).toBe(201);
  ownerSession = response.body;
}
function auth(agent: Agent, session: SessionResponse) {
  return {
    get: (path: string) => agent.get(path),
    post: (path: string, body: object = {}) =>
      agent.post(path).set('X-CSRF-Token', session.csrfToken!).send(body),
    put: (path: string, body: object) =>
      agent.put(path).set('X-CSRF-Token', session.csrfToken!).send(body),
    delete: (path: string) => agent.delete(path).set('X-CSRF-Token', session.csrfToken!).send({}),
  };
}
async function unit(code: string) {
  const row = (await db.all<{ id: string }>('SELECT id FROM units WHERE code = ?', [code]))[0];
  if (!row) throw new Error(`Missing unit ${code}`);
  return row.id;
}
async function category(name: string) {
  const row = (
    await db.all<{ id: string }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [name])
  )[0];
  if (!row) throw new Error(`Missing category ${name}`);
  return row.id;
}
async function productBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Paracetamol 500mg',
    genericName: 'Paracetamol',
    brand: 'Emzor',
    sku: `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `BAR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    productType: 'medicine',
    categoryId: await category('Analgesics'),
    description: 'Pain relief tablets',
    manufacturer: 'Emzor Pharmaceuticals',
    purchaseCostKobo: 5_000,
    sellingPriceKobo: 10_000,
    reorderLevel: 20,
    baseUnitId: await unit('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: await unit('pack'), factor: 10 }],
    ...overrides,
  };
}
async function createProduct(overrides: Record<string, unknown> = {}) {
  const body = await productBody(overrides);
  const response = await auth(owner, ownerSession).post('/api/products', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { id: string; name: string; stockQuantity: number };
}
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function receive(productId: string, overrides: Record<string, unknown> = {}) {
  return auth(owner, ownerSession).post('/api/stock/receive', {
    productId,
    quantity: 1,
    unitId: await unit('pack'),
    unitCostKobo: 4_500,
    supplierId: null,
    reason: 'Delivery from supplier',
    batchNumber: `BATCH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    manufacturingDate: past(30),
    expiryDate: future(365),
    movementType: 'stock_received',
    ...overrides,
  });
}
async function staff(roles: string[], email = `${roles.join('-')}@inventory.test`) {
  const response = await auth(owner, ownerSession).post('/api/staff', {
    fullName: 'Inventory Staff',
    email,
    password: 'A long individual staff passphrase',
    roles,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({
    email,
    password: 'A long individual staff passphrase',
  });
  expect(login.status).toBe(200);
  return auth(agent, login.body as SessionResponse);
}

beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db);
  app = createApp(db, config);
  owner = request.agent(app);
  await bootstrap();
});
afterEach(async () => {
  await db.close();
});

describe('inventory schema and migrations', () => {
  it('creates the inventory tables, indexes, and reference data', async () => {
    const tables = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
    ).map((row) => row.name);
    for (const table of [
      'categories',
      'product_batches',
      'product_units',
      'products',
      'stock_adjustments',
      'stock_balances',
      'stock_movements',
      'suppliers',
      'units',
    ])
      expect(tables).toContain(table);
    expect(Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM units'))[0]!.c)).toBe(11);
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM categories'))[0]!.c),
    ).toBe(11);
    const inventoryPermissions = await db.all<{ code: string }>(
      "SELECT code FROM permissions WHERE code LIKE 'stock.%' OR code LIKE 'products.%' OR code IN ('categories.manage','batches.view','batches.manage','inventory.reports.view','units.manage','suppliers.manage')",
    );
    expect(inventoryPermissions.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        'stock.view',
        'stock.receive',
        'stock.adjust',
        'stock.write_off',
        'products.create',
        'products.edit',
        'products.deactivate',
        'categories.manage',
        'batches.view',
        'batches.manage',
        'inventory.reports.view',
        'suppliers.manage',
      ]),
    );
    const indexes = (
      await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_products_barcode',
        'idx_products_sku',
        'idx_batches_expiry',
        'idx_movements_product_created',
      ]),
    );
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c),
    ).toBe(0);
  });

  it('rolls back an entire migration plan that fails part-way', async () => {
    const fresh = openNodeDatabase(':memory:');
    try {
      await expect(
        migrate(fresh, [
          ...migrations,
          {
            version: migrations.length + 1,
            name: 'deliberately_broken',
            statements: ['CREATE TABLE rollback_probe (id INTEGER)', 'CREATE TABLE broken ()'],
          },
        ]),
      ).rejects.toThrow();
      const tables = (
        await fresh.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      ).map((row) => row.name);
      expect(tables).not.toContain('rollback_probe');
      // The migration ledger itself is created in the same transaction, so a full rollback
      // leaves no partially applied schema behind.
      expect(tables).not.toContain('database_migrations');
    } finally {
      await fresh.close();
    }
  });

  it('keeps stock ledgers append-only', async () => {
    const product = await createProduct();
    const receipt = await receive(product.id);
    expect(receipt.status).toBe(201);
    await expect(db.run("UPDATE stock_movements SET reason='tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.run('DELETE FROM stock_movements')).rejects.toThrow(/append-only/);
  });
});

describe('product management', () => {
  it('creates, lists, and reads a product with unit conversions', async () => {
    const product = await createProduct();
    const list = await auth(owner, ownerSession).get('/api/products?search=Paracetamol');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      id: product.id,
      name: 'Paracetamol 500mg',
      categoryName: 'Analgesics',
      stockQuantity: 0,
      baseUnitSymbol: 'tab',
    });
    const detail = await auth(owner, ownerSession).get(`/api/products/${product.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.units).toEqual([expect.objectContaining({ code: 'pack', factor: 10 })]);
    expect(detail.body.isExpiryTracked).toBe(true);
  });

  it('rejects duplicate barcodes and SKUs case-insensitively', async () => {
    const first = await createProduct();
    const detail = (await auth(owner, ownerSession).get(`/api/products/${first.id}`)).body;
    const duplicateBarcode = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ barcode: String(detail.barcode).toLowerCase() }),
    );
    expect(duplicateBarcode.status).toBe(409);
    expect(duplicateBarcode.body.error.code).toBe('BARCODE_IN_USE');
    const duplicateSku = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ sku: String(detail.sku).toLowerCase() }),
    );
    expect(duplicateSku.status).toBe(409);
    expect(duplicateSku.body.error.code).toBe('SKU_IN_USE');
  });

  it('accepts the form payload when the optional SKU and barcode are blank', async () => {
    const created = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ sku: null, barcode: null, categoryId: null }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sku: null, barcode: null, categoryId: null });
    const reloaded = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ sku: '', barcode: '', categoryId: '' }),
    );
    expect(reloaded.status).toBe(201);
    expect(reloaded.body.sku).toBeNull();
  });

  it('validates prices, categories, units, and conversion factors', async () => {
    const invalidPrice = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ purchaseCostKobo: 20_000, sellingPriceKobo: 5_000 }),
    );
    expect(invalidPrice.status).toBe(400);
    expect(invalidPrice.body.error.fields).toBeTruthy();
    const fractional = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({ purchaseCostKobo: 10.5 }),
    );
    expect(fractional.status).toBe(400);
    const baseUnitConversion = await auth(owner, ownerSession).post('/api/products', {
      ...(await productBody()),
      units: [{ unitId: await unit('tablet'), factor: 5 }],
    });
    expect(baseUnitConversion.status).toBe(400);
    expect(baseUnitConversion.body.error.code).toBe('UNIT_DUPLICATE');
    const zeroFactor = await auth(owner, ownerSession).post('/api/products', {
      ...(await productBody()),
      units: [{ unitId: await unit('carton'), factor: 0 }],
    });
    expect(zeroFactor.status).toBe(400);
  });

  it('edits products and blocks the base-unit change while stock exists', async () => {
    const product = await createProduct();
    const body = await productBody({ name: 'Paracetamol 1g', sellingPriceKobo: 12_000 });
    const edited = await auth(owner, ownerSession).put(`/api/products/${product.id}`, body);
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('Paracetamol 1g');
    expect(edited.body.sellingPriceKobo).toBe(12_000);
    await receive(product.id);
    const locked = await auth(owner, ownerSession).put(`/api/products/${product.id}`, {
      ...body,
      baseUnitId: await unit('piece'),
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('BASE_UNIT_LOCKED');
  });

  it('searches, filters, sorts, and paginates products', async () => {
    await createProduct({ name: 'Ampicillin 250mg', productType: 'medicine', sku: 'AMP-1' });
    await createProduct({
      name: 'Bottled Water',
      productType: 'drinks',
      isExpiryTracked: false,
      categoryId: await category('Drinks'),
    });
    const filtered = await auth(owner, ownerSession).get('/api/products?type=drinks');
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].name).toBe('Bottled Water');
    const sorted = await auth(owner, ownerSession).get('/api/products?sort=name&order=asc');
    expect(sorted.body.items.map((item: { name: string }) => item.name)).toEqual([
      'Ampicillin 250mg',
      'Bottled Water',
    ]);
    const paged = await auth(owner, ownerSession).get('/api/products?pageSize=1&page=2');
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.totalPages).toBe(2);
    const byCategory = await auth(owner, ownerSession).get(
      `/api/products?categoryId=${await category('Drinks')}`,
    );
    expect(byCategory.body.total).toBe(1);
  });

  it('activates and deactivates products, auditing each change', async () => {
    const product = await createProduct();
    const off = await auth(owner, ownerSession).post(`/api/products/${product.id}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('inactive');
    const blockedReceipt = await receive(product.id);
    expect(blockedReceipt.status).toBe(409);
    expect(blockedReceipt.body.error.code).toBe('PRODUCT_INACTIVE');
    const on = await auth(owner, ownerSession).post(`/api/products/${product.id}/activate`);
    expect(on.body.status).toBe('active');
    const actions = await db.all<{ action: string }>(
      'SELECT action FROM audit_logs ORDER BY created_at ASC',
    );
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['product.created', 'product.deactivated', 'product.activated']),
    );
  });
});

describe('categories and units', () => {
  it('creates child categories, inherits kind, and refuses duplicates', async () => {
    const parentId = await category('Antibiotics');
    const created = await auth(owner, ownerSession).post('/api/categories', {
      name: 'Penicillins',
      parentId,
      kind: 'general',
      description: '',
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('pharmacy');
    expect(created.body.parentName).toBe('Antibiotics');
    const duplicate = await auth(owner, ownerSession).post('/api/categories', {
      name: 'penicillins',
      parentId,
      kind: 'pharmacy',
    });
    expect(duplicate.status).toBe(409);
    const search = await auth(owner, ownerSession).get('/api/categories?search=Penicillin');
    expect(search.body.categories).toHaveLength(1);
  });

  it('refuses category cycles and unsafe deletes', async () => {
    const parentId = await category('Antibiotics');
    const child = await auth(owner, ownerSession).post('/api/categories', {
      name: 'Penicillins',
      parentId,
      kind: 'pharmacy',
    });
    const cycle = await auth(owner, ownerSession).put(`/api/categories/${parentId}`, {
      name: 'Antibiotics',
      parentId: child.body.id,
      kind: 'pharmacy',
    });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.code).toBe('CATEGORY_CYCLE');
    await createProduct({ categoryId: parentId });
    const inUse = await auth(owner, ownerSession).delete(`/api/categories/${parentId}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('CATEGORY_IN_USE');
    const unused = await auth(owner, ownerSession).post('/api/categories', {
      name: 'Temporary',
      parentId: null,
      kind: 'general',
    });
    expect(
      (await auth(owner, ownerSession).delete(`/api/categories/${unused.body.id}`)).status,
    ).toBe(204);
  });

  it('manages custom units but protects built-in units', async () => {
    const created = await auth(owner, ownerSession).post('/api/units', {
      code: 'crate',
      name: 'Crate',
      symbol: 'crt',
    });
    expect(created.status).toBe(201);
    const uppercase = await auth(owner, ownerSession).post('/api/units', {
      code: 'CRATE',
      name: 'Crate',
      symbol: 'crt',
    });
    expect(uppercase.status).toBe(400);
    const duplicate = await auth(owner, ownerSession).post('/api/units', {
      code: 'crate',
      name: 'Crate',
      symbol: 'crt',
    });
    expect(duplicate.status).toBe(409);
    const renamed = await auth(owner, ownerSession).put(`/api/units/${created.body.id}`, {
      code: 'crate',
      name: 'Wooden crate',
      symbol: 'crt',
    });
    expect(renamed.body.name).toBe('Wooden crate');
    expect((await auth(owner, ownerSession).delete(`/api/units/${created.body.id}`)).status).toBe(
      204,
    );
    const builtIn = await unit('tablet');
    expect((await auth(owner, ownerSession).delete(`/api/units/${builtIn}`)).status).toBe(409);
  });
});

describe('batches, expiry, and receiving', () => {
  it('records a batch, ledger entry, and balance atomically', async () => {
    const product = await createProduct();
    const response = await receive(product.id, {
      quantity: 2,
      unitCostKobo: 50_000,
      batchNumber: 'LOT-001',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.movement).toMatchObject({
      movementType: 'stock_received',
      quantity: 20,
      previousBalance: 0,
      newBalance: 20,
      batchNumber: 'LOT-001',
    });
    expect(response.body.product.stockQuantity).toBe(20);
    const batch = (await db.all<Record<string, number>>('SELECT * FROM product_batches'))[0]!;
    expect(batch.quantity_received).toBe(20);
    expect(batch.quantity_remaining).toBe(20);
    // ₦500.00 per pack ÷ 10 tablets = ₦50.00 per tablet = 5,000 kobo
    expect(batch.purchase_cost_kobo).toBe(5_000);
  });

  it('requires expiry dates for expiry-tracked products and rejects past dates', async () => {
    const product = await createProduct();
    const missing = await receive(product.id, { expiryDate: null });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('EXPIRY_REQUIRED');
    const expired = await receive(product.id, { expiryDate: past(2) });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('EXPIRY_IN_PAST');
    const reversed = await receive(product.id, {
      manufacturingDate: future(30),
      expiryDate: future(10),
    });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.code).toBe('EXPIRY_BEFORE_MANUFACTURE');
  });

  it('supports products without expiry dates and duplicate-batch protection', async () => {
    const drink = await createProduct({
      name: 'Bottled Water',
      productType: 'drinks',
      isExpiryTracked: false,
      categoryId: await category('Drinks'),
    });
    const noBatch = await auth(owner, ownerSession).post('/api/stock/receive', {
      productId: drink.id,
      quantity: 3,
      unitId: await unit('tablet'),
      unitCostKobo: 10_000,
      supplierId: null,
      reason: 'Opening delivery',
      batchNumber: null,
      manufacturingDate: null,
      expiryDate: null,
      movementType: 'opening_stock',
    });
    expect(noBatch.status, JSON.stringify(noBatch.body)).toBe(201);
    expect(noBatch.body.movement.batchId).toBeNull();
    const product = await createProduct();
    expect((await receive(product.id, { batchNumber: 'LOT-9' })).status).toBe(201);
    const duplicate = await receive(product.id, { batchNumber: 'lot-9' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('BATCH_EXISTS');
  });

  it('orders batches first-expired-first-out and excludes expired stock', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, batchNumber: 'LATE', expiryDate: future(300) });
    await receive(product.id, { quantity: 1, batchNumber: 'SOON', expiryDate: future(30) });
    await receive(product.id, { quantity: 1, batchNumber: 'STALE', expiryDate: future(10) });
    // Simulate time passing: this batch is now expired but still holds stock.
    await db.run(
      "UPDATE product_batches SET manufacturing_date = '2019-06-01', expiry_date = '2020-01-01' WHERE product_id = ? AND batch_number = 'STALE'",
      [product.id],
    );
    const fefo = await auth(owner, ownerSession).get(
      `/api/products/${product.id}/fefo?quantity=20`,
    );
    expect(fefo.status).toBe(200);
    expect(fefo.body.allocations.map((row: { batchNumber: string }) => row.batchNumber)).toEqual([
      'SOON',
      'LATE',
    ]);
    expect(fefo.body.allocatableQuantity).toBe(20);
    const batches = await auth(owner, ownerSession).get(`/api/batches?filter=expired`);
    expect(batches.body.items).toHaveLength(1);
    expect(batches.body.items[0].status).toBe('expired');
    const alerts = await auth(owner, ownerSession).get('/api/inventory/alerts');
    expect(alerts.body.expired.items[0].batchNumber).toBe('STALE');
    expect(
      alerts.body.expiring.items.map((row: { batchNumber: string }) => row.batchNumber),
    ).toEqual(['SOON']);
  });

  it('allows configuring expiry alert windows', async () => {
    const product = await createProduct();
    await receive(product.id, { batchNumber: 'SOON', expiryDate: future(30) });
    expect(
      (await auth(owner, ownerSession).get('/api/inventory/alerts')).body.expiring.items,
    ).toHaveLength(1);
    const saved = await auth(owner, ownerSession).put('/api/inventory/settings', {
      expiryAlertDays: 10,
    });
    expect(saved.body.expiryAlertDays).toBe(10);
    expect(
      (await auth(owner, ownerSession).get('/api/inventory/alerts')).body.expiring.items,
    ).toHaveLength(0);
    expect(
      (await auth(owner, ownerSession).put('/api/inventory/settings', { expiryAlertDays: 0 }))
        .status,
    ).toBe(400);
  });
});

describe('stock ledger and adjustments', () => {
  it('converts cartons to packs to tablets using integer factors', async () => {
    const product = await createProduct({
      units: [
        { unitId: await unit('pack'), factor: 10 },
        { unitId: await unit('carton'), factor: 120 },
      ],
    });
    const carton = await receive(product.id, {
      quantity: 1,
      unitId: await unit('carton'),
      unitCostKobo: 900_000,
      batchNumber: 'CARTON-1',
    });
    expect(carton.body.movement.quantity).toBe(120);
    const batch = (await db.all<Record<string, number>>('SELECT * FROM product_batches'))[0]!;
    expect(batch.purchase_cost_kobo).toBe(7_500);
    const wrongUnit = await receive(product.id, {
      quantity: 1,
      unitId: await unit('bottle'),
      batchNumber: 'BOTTLE-1',
    });
    expect(wrongUnit.status).toBe(400);
    expect(wrongUnit.body.error.code).toBe('UNIT_NOT_CONFIGURED');
  });

  it('prevents negative stock and leaves the ledger untouched', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, batchNumber: 'LOT-1' });
    const batch = (await db.all<{ id: string }>('SELECT id FROM product_batches'))[0]!;
    const tooMany = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      batchId: batch.id,
      movementType: 'adjustment_decrease',
      quantity: 11,
      unitId: await unit('pack'),
      reason: 'Recount found fewer packs',
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_BATCH_STOCK');
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c),
    ).toBe(1);
    expect(
      Number(
        (await db.all<{ quantity: number }>('SELECT quantity FROM stock_balances'))[0]!.quantity,
      ),
    ).toBe(10);
  });

  it('requires a reason, a batch for reductions, and records adjustments separately', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, batchNumber: 'LOT-1' });
    const batch = (await db.all<{ id: string }>('SELECT id FROM product_batches'))[0]!;
    const noReason = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      batchId: batch.id,
      movementType: 'damaged',
      quantity: 1,
      unitId: await unit('pack'),
      reason: ' ',
    });
    expect(noReason.status).toBe(400);
    const noBatch = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      movementType: 'damaged',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Broken during a delivery inspection',
    });
    expect(noBatch.status).toBe(400);
    expect(noBatch.body.error.code).toBe('BATCH_REQUIRED');
    const damaged = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      batchId: batch.id,
      movementType: 'damaged',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Water-damaged packs',
      referenceId: 'INC-42',
    });
    expect(damaged.status).toBe(201);
    expect(damaged.body.movement).toMatchObject({
      movementType: 'damaged',
      quantity: -10,
      previousBalance: 10,
      newBalance: 0,
    });
    const adjustment = (
      await db.all<Record<string, unknown>>('SELECT * FROM stock_adjustments')
    )[0]!;
    expect(adjustment.adjustment_type).toBe('damaged');
    expect(adjustment.quantity).toBe(10);
    expect(adjustment.reference_id).toBe('INC-42');
    const batches = await auth(owner, ownerSession).get(`/api/products/${product.id}/batches`);
    expect(batches.body.batches[0].quantityRemaining).toBe(0);
    expect(batches.body.batches[0].status).toBe('depleted');
  });

  it('handles corrections in either direction and rejects a missing direction', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, batchNumber: 'LOT-1' });
    const missingDirection = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      movementType: 'correction',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Recount correction',
    });
    expect(missingDirection.status).toBe(400);
    const batchId = (await db.all<{ id: string }>('SELECT id FROM product_batches'))[0]!.id;
    const increase = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      batchId,
      movementType: 'correction',
      direction: 'increase',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Recount found an extra pack',
    });
    expect(increase.status).toBe(201);
    expect(increase.body.movement.quantity).toBe(10);
    const decrease = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      batchId,
      movementType: 'correction',
      direction: 'decrease',
      quantity: 2,
      unitId: await unit('pack'),
      reason: 'Recount found fewer packs',
    });
    expect(decrease.status).toBe(201);
    expect(decrease.body.product.stockQuantity).toBe(0);
  });

  it('replays idempotent operations once and rejects conflicting reuse', async () => {
    const product = await createProduct();
    const operationId = crypto.randomUUID();
    const first = await receive(product.id, { operationId, batchNumber: 'LOT-IDEM' });
    expect(first.status).toBe(201);
    const replay = await auth(owner, ownerSession).post('/api/stock/receive', {
      productId: product.id,
      quantity: 1,
      unitId: await unit('pack'),
      unitCostKobo: 4_500,
      supplierId: null,
      reason: 'Delivery from supplier',
      batchNumber: 'LOT-IDEM',
      manufacturingDate: past(30),
      expiryDate: future(365),
      movementType: 'stock_received',
      operationId,
    });
    expect(replay.status).toBe(201);
    expect(replay.body.movement.id).toBe(first.body.movement.id);
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c),
    ).toBe(1);
    const conflict = await auth(owner, ownerSession).post('/api/stock/adjust', {
      productId: product.id,
      movementType: 'adjustment_increase',
      quantity: 3,
      unitId: await unit('pack'),
      reason: 'Different operation with the same id',
      operationId,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');
  });

  it('records device-neutral movement details and lists history with filters', async () => {
    const product = await createProduct();
    await receive(product.id, { batchNumber: 'LOT-1', referenceId: 'INV-77' });
    const movements = await auth(owner, ownerSession).get(
      `/api/stock/movements?productId=${product.id}&type=stock_received`,
    );
    expect(movements.body.total).toBe(1);
    const movement = movements.body.items[0];
    expect(movement).toMatchObject({
      referenceId: 'INV-77',
      previousBalance: 0,
      newBalance: 10,
      deviceId: null,
    });
    expect(movement.userName).toBe('Inventory Owner');
    expect(
      (await auth(owner, ownerSession).get(`/api/stock/movements/${movement.id}`)).status,
    ).toBe(200);
    expect(
      (await auth(owner, ownerSession).get('/api/stock/movements?from=2099-01-01')).body.total,
    ).toBe(0);
  });
});

describe('suppliers', () => {
  it('creates suppliers, links receipts, and deactivates them', async () => {
    const created = await auth(owner, ownerSession).post('/api/suppliers', {
      name: 'Lagos Pharma Distribution',
      contactPerson: 'Ada Obi',
      phone: '+234 801 234 5678',
      email: 'sales@lagospharma.test',
      address: '12 Marina Road, Lagos',
      businessInfo: 'Wholesale medicines',
      notes: '',
      status: 'active',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const duplicate = await auth(owner, ownerSession).post('/api/suppliers', {
      name: 'lagos pharma distribution',
      contactPerson: '',
      phone: '',
      email: '',
      address: '',
      businessInfo: '',
      notes: '',
      status: 'active',
    });
    expect(duplicate.status).toBe(409);
    const product = await createProduct();
    await receive(product.id, { supplierId: created.body.id, batchNumber: 'SUP-1' });
    const detail = await auth(owner, ownerSession).get(`/api/suppliers/${created.body.id}`);
    expect(detail.body.products).toHaveLength(1);
    expect(detail.body.receipts).toHaveLength(1);
    expect(detail.body.receipts[0].batchNumber).toBe('SUP-1');
    const search = await auth(owner, ownerSession).get('/api/suppliers?search=Lagos');
    expect(search.body.total).toBe(1);
    const off = await auth(owner, ownerSession).post(
      `/api/suppliers/${created.body.id}/deactivate`,
    );
    expect(off.body.status).toBe('inactive');
  });
});

describe('dashboard, reporting, and reconciliation', () => {
  it('separates inventory cost value from retail value', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, unitCostKobo: 4_500, batchNumber: 'LOT-1' });
    const dashboard = await auth(owner, ownerSession).get('/api/inventory/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.totalActiveProducts).toBe(1);
    expect(dashboard.body.totalStockQuantity).toBe(10);
    expect(dashboard.body.stockValueCostKobo).toBe(50_000); // 10 tablets × ₦50 cost
    expect(dashboard.body.retailValueKobo).toBe(100_000); // 10 × ₦100 selling
    expect(dashboard.body.lowStockCount).toBe(1);
    expect(dashboard.body.recentMovements).toHaveLength(1);
    expect(dashboard.body.recentlyAddedProducts).toHaveLength(1);
  });

  it('reconciles cached balances against the ledger and detects drift', async () => {
    const product = await createProduct();
    await receive(product.id, { quantity: 1, batchNumber: 'LOT-1' });
    const clean = await auth(owner, ownerSession).get('/api/inventory/reconciliation');
    expect(clean.status).toBe(200);
    expect(clean.body.inconsistentCount).toBe(0);
    await db.run('UPDATE stock_balances SET quantity = 999');
    const drifted = await auth(owner, ownerSession).get('/api/inventory/reconciliation');
    expect(drifted.body.inconsistentCount).toBe(1);
    expect(drifted.body.rows[0]).toMatchObject({
      balanceQuantity: 999,
      ledgerQuantity: 10,
      consistent: false,
    });
  });
});

describe('inventory permissions', () => {
  it('requires authentication and rejects accounts without inventory access', async () => {
    expect((await request(app).get('/api/products')).status).toBe(401);
    const cashier = await staff(['cashier']);
    expect((await cashier.get('/api/products')).status).toBe(403);
    expect((await cashier.get('/api/inventory/dashboard')).status).toBe(403);
    expect(
      (await cashier.post('/api/stock/receive', { productId: crypto.randomUUID() })).status,
    ).toBe(403);
    expect((await cashier.get('/api/suppliers')).status).toBe(403);
  });

  it('enforces capability granularity for write-offs and settings', async () => {
    const pharmacist = await staff(['pharmacist']);
    const product = await createProduct();
    const receipt = await pharmacist.post('/api/stock/receive', {
      productId: product.id,
      quantity: 1,
      unitId: await unit('pack'),
      unitCostKobo: 4_500,
      supplierId: null,
      reason: 'Pharmacist receipt',
      batchNumber: 'PH-1',
      manufacturingDate: past(10),
      expiryDate: future(200),
      movementType: 'stock_received',
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const batch = (await db.all<{ id: string }>('SELECT id FROM product_batches'))[0]!;
    expect(
      (
        await pharmacist.post('/api/stock/adjust', {
          productId: product.id,
          batchId: batch.id,
          movementType: 'expired',
          quantity: 1,
          unitId: await unit('pack'),
          reason: 'Reached expiry date',
        })
      ).status,
    ).toBe(201);
    await db.run(
      "DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='pharmacist') AND permission_id=(SELECT id FROM permissions WHERE code='stock.write_off')",
    );
    const denied = await pharmacist.post('/api/stock/adjust', {
      productId: product.id,
      batchId: batch.id,
      movementType: 'damaged',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Damaged in storage',
    });
    expect(denied.status).toBe(403);
    expect((await pharmacist.post(`/api/products/${product.id}/deactivate`, {})).status).toBe(403);
    expect((await pharmacist.put('/api/inventory/settings', { expiryAlertDays: 30 })).status).toBe(
      403,
    );
    const storekeeper = await staff(['storekeeper'], 'store@inventory.test');
    expect((await storekeeper.put('/api/inventory/settings', { expiryAlertDays: 30 })).status).toBe(
      403,
    );
  });

  it('audits inventory changes without leaking sensitive payloads', async () => {
    const product = await createProduct();
    await receive(product.id, { batchNumber: 'AUDIT-1' });
    const logs = await auth(owner, ownerSession).get('/api/audit-logs?limit=100');
    const actions = logs.body.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['product.created', 'stock.stock_received']));
    const serialized = JSON.stringify(logs.body);
    expect(serialized).not.toMatch(/password|token|secret/i);
  });
});

describe('phase 2 corrections', () => {
  async function adjust(productId: string, overrides: Record<string, unknown> = {}) {
    return auth(owner, ownerSession).post('/api/stock/adjust', {
      productId,
      movementType: 'adjustment_increase',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Recount found an extra pack',
      ...overrides,
    });
  }
  async function batchOf(productId: string) {
    return (
      await db.all<{ id: string; batch_number: string }>(
        'SELECT id,batch_number FROM product_batches WHERE product_id = ? ORDER BY batch_number',
        [productId],
      )
    )[0]!;
  }
  async function batchRow(id: string) {
    return (
      await db.all<{ quantity_received: number; quantity_remaining: number }>(
        'SELECT quantity_received,quantity_remaining FROM product_batches WHERE id = ?',
        [id],
      )
    )[0]!;
  }

  it('replays an identical operation without duplicating stock', async () => {
    const product = await createProduct();
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      batchNumber: 'IDEM-1',
      supplierId: null,
      unitCostKobo: 4_500,
      referenceId: 'INV-IDEM',
    };
    const first = await receive(product.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await receive(product.id, body);
    expect(again.status).toBe(201);
    expect(again.body.movement.id).toBe(first.body.movement.id);
    expect(again.body.product.stockQuantity).toBe(10);
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c),
    ).toBe(1);
    expect(Number((await batchRow((await batchOf(product.id)).id)).quantity_received)).toBe(10);
  });

  it('rejects reusing an operation ID for a different batch', async () => {
    const product = await createProduct();
    const operationId = crypto.randomUUID();
    expect((await receive(product.id, { operationId, batchNumber: 'BATCH-A' })).status).toBe(201);
    const conflict = await receive(product.id, { operationId, batchNumber: 'BATCH-B' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');
    expect(
      Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c),
    ).toBe(1);
    const adjusted = await adjust(product.id, {
      operationId,
      batchId: (await batchOf(product.id)).id,
    });
    expect(adjusted.status).toBe(409);
    expect(adjusted.body.error.code).toBe('OPERATION_CONFLICT');
  });

  it('rejects a different supplier or cost for the same operation ID', async () => {
    const supplier = await auth(owner, ownerSession).post('/api/suppliers', {
      name: 'Idempotency Wholesale',
      contactPerson: '',
      phone: '',
      email: '',
      address: '',
      businessInfo: '',
      notes: '',
      status: 'active',
    });
    expect(supplier.status).toBe(201);
    const product = await createProduct();
    const operationId = crypto.randomUUID();
    expect(
      (
        await receive(product.id, {
          operationId,
          batchNumber: 'COST-1',
          supplierId: supplier.body.id,
        })
      ).status,
    ).toBe(201);
    const otherSupplier = await auth(owner, ownerSession).post('/api/suppliers', {
      name: 'Second Idempotency Wholesale',
      contactPerson: '',
      phone: '',
      email: '',
      address: '',
      businessInfo: '',
      notes: '',
      status: 'active',
    });
    const supplierConflict = await receive(product.id, {
      operationId,
      batchNumber: 'COST-1',
      supplierId: otherSupplier.body.id,
    });
    expect(supplierConflict.status).toBe(409);
    expect(supplierConflict.body.error.code).toBe('OPERATION_CONFLICT');
    const costConflict = await receive(product.id, {
      operationId,
      batchNumber: 'COST-1',
      supplierId: supplier.body.id,
      unitCostKobo: 4_600,
    });
    expect(costConflict.status).toBe(409);
    expect(costConflict.body.error.code).toBe('OPERATION_CONFLICT');
  });

  it('does not inflate quantity received for positive adjustments or corrections', async () => {
    const product = await createProduct();
    expect((await receive(product.id, { batchNumber: 'RECV-1' })).status).toBe(201);
    const batch = await batchOf(product.id);
    expect(Number((await batchRow(batch.id)).quantity_received)).toBe(10);
    expect(
      (
        await adjust(product.id, {
          batchId: batch.id,
          movementType: 'adjustment_increase',
          quantity: 2,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await adjust(product.id, {
          batchId: batch.id,
          movementType: 'correction',
          direction: 'increase',
          quantity: 1,
        })
      ).status,
    ).toBe(201);
    const after = await batchRow(batch.id);
    expect(Number(after.quantity_received)).toBe(10);
    expect(Number(after.quantity_remaining)).toBe(40);
    const detail = await auth(owner, ownerSession).get(`/api/products/${product.id}`);
    expect(detail.body.stockQuantity).toBe(40);
    expect(detail.body.batches[0].quantityReceived).toBe(10);
    const report = await auth(owner, ownerSession).get('/api/inventory/reconciliation');
    expect(report.body.inconsistentCount).toBe(0);
  });

  it('increases quantity received for a genuine receiving operation', async () => {
    const product = await createProduct();
    const body = { batchNumber: 'RECV-2' };
    expect((await receive(product.id, body)).status).toBe(201);
    const batch = await batchOf(product.id);
    expect(Number((await batchRow(batch.id)).quantity_received)).toBe(10);
    // Opening stock is a genuine receiving movement too, but only before any other movement.
    expect((await receive(product.id, { ...body })).status).toBe(409);
    const other = await createProduct({ name: 'Opening Stock Product', isExpiryTracked: false });
    const opening = await auth(owner, ownerSession).post('/api/stock/receive', {
      productId: other.id,
      quantity: 5,
      unitId: await unit('pack'),
      unitCostKobo: 3_000,
      supplierId: null,
      reason: 'Opening stock count',
      batchNumber: 'OPEN-1',
      movementType: 'opening_stock',
    });
    expect(opening.status, JSON.stringify(opening.body)).toBe(201);
    const openingBatch = await batchOf(other.id);
    expect(Number((await batchRow(openingBatch.id)).quantity_received)).toBe(50);
  });

  it('requires permission before a selling price may go below cost', async () => {
    const product = await createProduct();
    const pharmacist = await staff(['pharmacist'], 'below-cost@inventory.test');
    const belowCost = async (overrides: Record<string, unknown> = {}) =>
      productBody({
        name: 'Loss Leader',
        purchaseCostKobo: 20_000,
        sellingPriceKobo: 5_000,
        ...overrides,
      });
    // The acknowledgement alone is not enough to accept the price.
    const unconfirmed = await auth(owner, ownerSession).put(
      `/api/products/${product.id}`,
      await belowCost(),
    );
    expect(unconfirmed.status).toBe(400);
    // A user who may edit products but lacks the pricing permission is refused by the API.
    const denied = await pharmacist.put(
      `/api/products/${product.id}`,
      await belowCost({ allowBelowCost: true }),
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const stillPriced = await auth(owner, ownerSession).get(`/api/products/${product.id}`);
    expect(stillPriced.body.sellingPriceKobo).toBe(10_000);
    // The owner may authorise it, and the database no longer forbids the stored price.
    const allowed = await auth(owner, ownerSession).put(
      `/api/products/${product.id}`,
      await belowCost({ allowBelowCost: true }),
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.sellingPriceKobo).toBe(5_000);
    expect(
      (
        await db.all<{ selling_price_kobo: number }>(
          'SELECT selling_price_kobo FROM products WHERE id = ?',
          [product.id],
        )
      )[0]!.selling_price_kobo,
    ).toBe(5_000);
  });

  it('audits below-cost pricing decisions', async () => {
    const created = await auth(owner, ownerSession).post(
      '/api/products',
      await productBody({
        name: 'Audited Loss Leader',
        purchaseCostKobo: 30_000,
        sellingPriceKobo: 9_000,
        allowBelowCost: true,
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const logs = await auth(owner, ownerSession).get('/api/audit-logs?limit=100');
    const entries = logs.body.entries.filter(
      (entry: { action: string }) => entry.action === 'product.below_cost_pricing',
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].entity_id).toBe(created.body.id);
    expect(JSON.parse(entries[0].metadata_json).shortfallKobo).toBe(21_000);
    // Raising the price later above cost is not a below-cost decision.
    const raised = await auth(owner, ownerSession).put(
      `/api/products/${created.body.id}`,
      await productBody({
        name: 'Audited Loss Leader',
        purchaseCostKobo: 30_000,
        sellingPriceKobo: 40_000,
        allowBelowCost: false,
      }),
    );
    expect(raised.status).toBe(200);
  });
});

/**
 * Movements written before migration 6 carry operation_fingerprint = NULL, so a retry has to
 * rebuild the fingerprint from the ledger row itself (and still match an identical request).
 */
describe('legacy operations without a stored fingerprint', () => {
  /**
   * Movements written before migration 6 carry operation_fingerprint = NULL, so retries fall back
   * to rebuilding the fingerprint from the ledger row itself. The ledger is append-only, so these
   * fixtures are inserted directly in the shape Phase 2 wrote.
   */
  async function legacyReceipt(
    productId: string,
    operationId: string,
    options: { quantity?: number; unitCostKobo?: number; reason?: string } = {},
  ) {
    const quantity = options.quantity ?? 1;
    const unitCostKobo = options.unitCostKobo ?? 4_500;
    const reason = options.reason ?? 'Legacy delivery from supplier';
    const batchNumber = `LEGACY-${operationId.slice(0, 8)}`;
    const batchId = crypto.randomUUID();
    const baseQuantity = quantity * 10;
    await db.run(
      `INSERT INTO product_batches (id,product_id,batch_number,quantity_received,quantity_remaining,purchase_cost_kobo,supplier_id)
      VALUES (?,?,?,?,?,?,?)`,
      [batchId, productId, batchNumber, baseQuantity, baseQuantity, unitCostKobo, null],
    );
    await db.run('INSERT INTO stock_balances (product_id,quantity,version) VALUES (?,?,1)', [
      productId,
      baseQuantity,
    ]);
    await db.run(
      `INSERT INTO stock_movements (id,operation_id,operation_fingerprint,product_id,batch_id,movement_type,quantity,previous_balance,new_balance,unit_cost_kobo,reason,reference_id)
      VALUES (?,?,NULL,?,?,'stock_received',?,0,?,?,?,?)`,
      [
        crypto.randomUUID(),
        operationId,
        productId,
        batchId,
        baseQuantity,
        baseQuantity,
        unitCostKobo,
        reason,
        'INV-LEGACY',
      ],
    );
    return { batchId, baseQuantity, batchNumber, unitCostKobo, reason };
  }
  const movementCount = async () =>
    Number((await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM stock_movements'))[0]!.c);
  const legacyRequest = async (
    productId: string,
    operationId: string,
    fixture: { unitCostKobo: number; reason: string; batchNumber: string },
    overrides: Record<string, unknown> = {},
  ) => ({
    productId,
    quantity: 1,
    unitId: await unit('pack'),
    unitCostKobo: fixture.unitCostKobo,
    supplierId: null,
    reason: fixture.reason,
    referenceId: 'INV-LEGACY',
    // A genuine retry of the original delivery names the same batch again.
    batchNumber: fixture.batchNumber,
    manufacturingDate: null,
    expiryDate: null,
    movementType: 'stock_received',
    operationId,
    ...overrides,
  });

  it('replays an identical legacy retry without changing stock', async () => {
    const product = await createProduct({ isExpiryTracked: false });
    const operationId = crypto.randomUUID();
    const fixture = await legacyReceipt(product.id, operationId);
    const request = await legacyRequest(product.id, operationId, fixture);
    const retry = await auth(owner, ownerSession).post('/api/stock/receive', request);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.movement.operationId).toBe(operationId);
    expect(retry.body.movement.quantity).toBe(10);
    expect(retry.body.product.stockQuantity).toBe(10);
    expect(await movementCount()).toBe(1);
    const batch = (
      await db.all<{ quantity_received: number; quantity_remaining: number }>(
        'SELECT quantity_received,quantity_remaining FROM product_batches WHERE product_id = ?',
        [product.id],
      )
    )[0]!;
    expect(Number(batch.quantity_received)).toBe(10);
    expect(Number(batch.quantity_remaining)).toBe(10);
    // The original row stays append-only: a replay never rewrites it.
    const stored = (
      await db.all<{ operation_fingerprint: string | null }>(
        'SELECT operation_fingerprint FROM stock_movements WHERE operation_id = ?',
        [operationId],
      )
    )[0]!;
    expect(stored.operation_fingerprint).toBeNull();
  });

  it('rejects a changed legacy request for the same operation ID', async () => {
    const product = await createProduct({ isExpiryTracked: false });
    const operationId = crypto.randomUUID();
    const fixture = await legacyReceipt(product.id, operationId);
    const changes: Array<Record<string, unknown>> = [
      { unitCostKobo: 4_600 },
      { reason: 'A different reason entirely' },
      { referenceId: 'INV-CHANGED' },
      { quantity: 2 },
    ];
    for (const change of changes) {
      const conflict = await auth(owner, ownerSession).post(
        '/api/stock/receive',
        await legacyRequest(product.id, operationId, fixture, change),
      );
      expect(conflict.status, JSON.stringify(change)).toBe(409);
      expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');
    }
    expect(await movementCount()).toBe(1);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id = ?',
          [product.id],
        )
      )[0]!.quantity,
    ).toBe(10);
  });

  it('replays identical legacy reductions and rejects a changed one', async () => {
    const product = await createProduct({ isExpiryTracked: false });
    const batchId = crypto.randomUUID();
    await db.run(
      `INSERT INTO product_batches (id,product_id,batch_number,quantity_received,quantity_remaining,purchase_cost_kobo,supplier_id)
      VALUES (?,?,?,?,?,?,NULL)`,
      [batchId, product.id, 'LEGACY-REDUCE', 50, 40, 4_500],
    );
    await db.run('INSERT INTO stock_balances (product_id,quantity,version) VALUES (?,?,1)', [
      product.id,
      40,
    ]);
    await db.run(
      `INSERT INTO stock_movements (id,product_id,batch_id,movement_type,quantity,previous_balance,new_balance,reason)
      VALUES (?,?,?,'stock_received',50,0,50,'Legacy delivery')`,
      [crypto.randomUUID(), product.id, batchId],
    );
    const operationId = crypto.randomUUID();
    await db.run(
      `INSERT INTO stock_movements (id,operation_id,operation_fingerprint,product_id,batch_id,movement_type,quantity,previous_balance,new_balance,reason)
      VALUES (?,?,NULL,?,?,'correction',-10,50,40,'Recount found fewer packs')`,
      [crypto.randomUUID(), operationId, product.id, batchId],
    );
    const request = {
      productId: product.id,
      batchId,
      movementType: 'correction',
      direction: 'decrease',
      quantity: 1,
      unitId: await unit('pack'),
      reason: 'Recount found fewer packs',
      operationId,
    };
    const retry = await auth(owner, ownerSession).post('/api/stock/adjust', request);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.movement.operationId).toBe(operationId);
    expect(retry.body.movement.quantity).toBe(-10);
    expect(retry.body.product.stockQuantity).toBe(40);
    expect(await movementCount()).toBe(2);
    const changed = await auth(owner, ownerSession).post('/api/stock/adjust', {
      ...request,
      quantity: 2,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('OPERATION_CONFLICT');
    const wrongDirection = await auth(owner, ownerSession).post('/api/stock/adjust', {
      ...request,
      direction: 'increase',
    });
    expect(wrongDirection.status).toBe(409);
    expect(wrongDirection.body.error.code).toBe('OPERATION_CONFLICT');
    expect(await movementCount()).toBe(2);
  });
});
