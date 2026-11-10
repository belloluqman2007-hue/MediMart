/**
 * Phase 7 regression tests for stock valuation.
 *
 * Phase 6 found `/api/inventory/dashboard` valuing stock at product cost prices while
 * `/api/reports/finance` valued it at actual batch acquisition costs. These tests pin the Phase 7
 * rule: **actual batch acquisition cost wherever batch cost data exists, product cost price only
 * for quantities with no batch data**, on every surface, with historical COGS left untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { migrate, type Database } from '@medimart/database';
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
  backupDir: '.artifacts/backups',
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
};
const origin = 'https://trusted.medimart.test';
const ownerBody = {
  fullName: 'Valuation Owner',
  email: 'owner@valuation.test',
  password: 'A long private valuation passphrase',
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
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function createProduct(overrides: Record<string, unknown> = {}) {
  const response = await auth(owner, ownerSession).post('/api/products', {
    name: 'Valuation Test Product',
    genericName: '',
    brand: '',
    sku: `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `BAR-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    productType: 'medicine',
    categoryId: await category('Analgesics'),
    description: '',
    manufacturer: '',
    purchaseCostKobo: 1_000,
    sellingPriceKobo: 2_000,
    reorderLevel: 0,
    baseUnitId: await unit('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: await unit('pack'), factor: 10 }],
    ...overrides,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { id: string; name: string; stockValueCostKobo: number };
}

async function receive(
  productId: string,
  body: {
    quantity: number;
    unitCode: string;
    unitCostKobo: number;
    batchNumber?: string;
    expiryDate?: string;
    movementType?: 'stock_received' | 'opening_stock';
  },
) {
  return auth(owner, ownerSession).post('/api/stock/receive', {
    productId,
    quantity: body.quantity,
    unitId: await unit(body.unitCode),
    unitCostKobo: body.unitCostKobo,
    supplierId: null,
    reason: 'Delivery from supplier',
    batchNumber: body.batchNumber ?? null,
    manufacturingDate: past(30),
    expiryDate: body.expiryDate ?? future(365),
    movementType: body.movementType ?? 'stock_received',
  });
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

describe('stock valuation (Phase 7: batch acquisition cost is authoritative)', () => {
  it('values batched stock at actual acquisition cost, unbatched stock at product cost, on every surface', async () => {
    // Product A: product cost price ₦10.00/tablet, but the shop really paid ₦7.00 and ₦13.00.
    const productA = await createProduct({ name: 'Amoxil 500mg Valuation' });
    const recvA1 = await receive(productA.id, {
      quantity: 2,
      unitCode: 'pack',
      unitCostKobo: 7_000,
      batchNumber: 'VAL-A1',
      expiryDate: future(200),
    });
    expect(recvA1.status, JSON.stringify(recvA1.body)).toBe(201); // 20 tablets at ₦7.00 = ₦140.00
    const recvA2 = await receive(productA.id, {
      quantity: 1,
      unitCode: 'pack',
      unitCostKobo: 13_000,
      batchNumber: 'VAL-A2',
      expiryDate: future(400),
    });
    expect(recvA2.status, JSON.stringify(recvA2.body)).toBe(201); // 10 tablets at ₦13.00 = ₦130.00

    // Product B: general merchandise with no batch data at all — falls back to product cost ₦5.00
    // even though the last delivery note said ₦4.00, because there is no batch record to prove it.
    const productB = await createProduct({
      name: 'Bournvita 500g Valuation',
      productType: 'general',
      baseUnitId: await unit('piece'),
      isExpiryTracked: false,
      units: [],
      purchaseCostKobo: 500,
      sellingPriceKobo: 900,
    });
    const recvB = await receive(productB.id, {
      quantity: 20,
      unitCode: 'piece',
      unitCostKobo: 400,
    });
    expect(recvB.status, JSON.stringify(recvB.body)).toBe(201); // unbatched: 20 × ₦5.00 product cost = ₦100.00

    // Product C: mixed — 5 batched pieces really cost ₦3.00 each, 5 pieces of legacy opening
    // stock have no batch record and fall back to the ₦10.00 product cost price.
    const productC = await createProduct({
      name: 'Milo Sachet Valuation',
      productType: 'snacks',
      baseUnitId: await unit('piece'),
      isExpiryTracked: false,
      units: [],
      purchaseCostKobo: 1_000,
      sellingPriceKobo: 1_500,
    });
    const openingC = await receive(productC.id, {
      quantity: 5,
      unitCode: 'piece',
      unitCostKobo: 1_000,
      movementType: 'opening_stock',
    });
    expect(openingC.status, JSON.stringify(openingC.body)).toBe(201);
    const recvC = await receive(productC.id, {
      quantity: 5,
      unitCode: 'piece',
      unitCostKobo: 300,
      batchNumber: 'VAL-C1',
    });
    expect(recvC.status, JSON.stringify(recvC.body)).toBe(201);

    // Hand-computed expectations in kobo.
    const expectA = 20 * 700 + 10 * 1_300; // 27,000 — not 30 × 1,000 = 30,000
    const expectB = 20 * 500; // 10,000 — product-cost fallback
    const expectC = 5 * 300 + 5 * 1_000; // 6,500 — mixed batched and unbatched
    const expectTotal = expectA + expectB + expectC; // 43,500
    const expectRetail = 30 * 2_000 + 20 * 900 + 10 * 1_500; // 93,000

    const dashboard = await auth(owner, ownerSession).get('/api/inventory/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.totalStockQuantity).toBe(60);
    expect(dashboard.body.stockValueCostKobo).toBe(expectTotal);
    expect(dashboard.body.retailValueKobo).toBe(expectRetail);

    const finance = (await auth(owner, ownerSession).get('/api/reports/finance')).body;
    expect(finance.inventory.stockValueCostKobo).toBe(expectTotal);
    expect(finance.inventory.stockValueRetailKobo).toBe(expectRetail);
    expect(finance.inventory.stockUnits).toBe(60);
    expect(finance.inventoryValuation.totalCostKobo).toBe(expectTotal);

    const rows = finance.inventoryValuation.rows as Array<{
      productId: string;
      costValueKobo: number;
      retailValueKobo: number;
    }>;
    const byId = new Map(rows.map((row) => [row.productId, row]));
    expect(byId.get(productA.id)!.costValueKobo).toBe(expectA);
    expect(byId.get(productB.id)!.costValueKobo).toBe(expectB);
    expect(byId.get(productC.id)!.costValueKobo).toBe(expectC);
    expect(rows.reduce((sum, row) => sum + row.costValueKobo, 0)).toBe(expectTotal);

    // The product list's cost-value column uses the same rule per product.
    const products = await auth(owner, ownerSession).get('/api/products?pageSize=50');
    expect(products.status).toBe(200);
    const listed = new Map(
      (products.body.items as Array<{ id: string; stockValueCostKobo: number }>).map((row) => [
        row.id,
        row.stockValueCostKobo,
      ]),
    );
    expect(listed.get(productA.id)).toBe(expectA);
    expect(listed.get(productB.id)).toBe(expectB);
    expect(listed.get(productC.id)).toBe(expectC);
  });

  it('costs sales at the batch acquisition cost of the moment, without restating history', async () => {
    const product = await createProduct({ name: 'Paracetamol Valuation COGS' });
    // Two batches with different real costs; FEFO sells the earlier-expiring one first.
    await receive(product.id, {
      quantity: 1,
      unitCode: 'pack',
      unitCostKobo: 7_000,
      batchNumber: 'COGS-B1',
      expiryDate: future(120),
    }); // 10 tablets at ₦7.00
    await receive(product.id, {
      quantity: 1,
      unitCode: 'pack',
      unitCostKobo: 13_000,
      batchNumber: 'COGS-B2',
      expiryDate: future(360),
    }); // 10 tablets at ₦13.00

    const sale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [
        {
          productId: product.id,
          unitId: await unit('tablet'),
          quantity: 5,
          lineDiscountKobo: 0,
        },
      ],
      cartDiscountKobo: 0,
      payments: [{ method: 'cash', amountKobo: 10_000 }],
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);

    // COGS is 5 × ₦7.00 from the FEFO batch — not 5 × ₦10.00 product cost.
    const finance = (await auth(owner, ownerSession).get('/api/reports/finance')).body;
    expect(finance.cogsRows[0].cogsKobo).toBe(3_500);
    expect(finance.sales.costOfGoodsSoldKobo).toBe(3_500);
    expect(finance.profitability.grossProfitKobo).toBe(10_000 - 3_500);

    // Remaining stock: 5 × ₦7.00 + 10 × ₦13.00 = 16,500, and every surface agrees.
    const dashboard = await auth(owner, ownerSession).get('/api/inventory/dashboard');
    expect(dashboard.body.stockValueCostKobo).toBe(5 * 700 + 10 * 1_300);
    expect(finance.inventory.stockValueCostKobo).toBe(5 * 700 + 10 * 1_300);
    expect(finance.inventoryValuation.totalCostKobo).toBe(5 * 700 + 10 * 1_300);
  });

  it('values stock with no batch data at the product cost price even after the cost price is edited', async () => {
    const product = await createProduct({
      name: 'Infant Formula Valuation',
      productType: 'general',
      baseUnitId: await unit('piece'),
      isExpiryTracked: false,
      units: [],
      purchaseCostKobo: 2_000,
      sellingPriceKobo: 3_000,
    });
    await receive(product.id, { quantity: 10, unitCode: 'piece', unitCostKobo: 1_800 });

    const before = await auth(owner, ownerSession).get('/api/inventory/dashboard');
    expect(before.body.stockValueCostKobo).toBe(20_000);

    // Editing the cost price moves the fallback valuation: unbatched stock has no acquisition
    // record, so the product cost price is the best available evidence. (Direct update to isolate
    // the valuation rule from the product-update route; both surfaces must follow it.)
    await db.run('UPDATE products SET purchase_cost_kobo = 2_500 WHERE id = ?', [product.id]);

    const after = await auth(owner, ownerSession).get('/api/inventory/dashboard');
    expect(after.body.stockValueCostKobo).toBe(25_000);
    const finance = (await auth(owner, ownerSession).get('/api/reports/finance')).body;
    expect(finance.inventory.stockValueCostKobo).toBe(25_000);
  });
});
