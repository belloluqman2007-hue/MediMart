import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import type { SessionResponse } from '@medimart/shared';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';

const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: ':memory:',
  bootstrapToken: 'e'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
};
const origin = 'https://trusted.medimart.test';
const ownerCredentials = {
  fullName: 'Adaeze Okonkwo',
  email: 'owner@medimart.test',
  password: 'A long private pharmacy owner passphrase',
  bootstrapToken: config.bootstrapToken,
};

type Agent = ReturnType<typeof request.agent>;

let db: Database;
let app: ReturnType<typeof createApp>;
let owner: Agent;
let ownerSession: SessionResponse;

function auth(agent: Agent, session: SessionResponse) {
  return {
    get: (path: string) => agent.get(path),
    post: (path: string, body: object = {}) =>
      agent.post(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send(body),
    put: (path: string, body: object) =>
      agent.put(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send(body),
    delete: (path: string) =>
      agent.delete(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send({}),
  };
}

async function createStaffAndLogin(role: string, emailPrefix: string) {
  const email = `${emailPrefix}@medimart.test`;
  const password = `Strong ${emailPrefix} passphrase 2026!`;
  const created = await auth(owner, ownerSession).post('/api/staff', {
    fullName: `${emailPrefix.toUpperCase()} Staff`,
    email,
    password,
    roles: [role],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').set('Origin', origin).send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { agent, session: login.body as SessionResponse, email, password };
}

async function unitId(code: string) {
  const row = (await db.all<{ id: string }>('SELECT id FROM units WHERE code = ?', [code]))[0];
  if (!row) throw new Error(`Missing unit ${code}`);
  return row.id;
}

async function categoryId(name: string) {
  const row = (
    await db.all<{ id: string }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [name])
  )[0];
  if (!row) throw new Error(`Missing category ${name}`);
  return row.id;
}

const futureDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const pastDate = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function createMedicineWithPack(overrides: Record<string, unknown> = {}) {
  const tablet = await unitId('tablet');
  const pack = await unitId('pack');
  const res = await auth(owner, ownerSession).post('/api/products', {
    name: 'Amoxicillin 500mg',
    genericName: 'Amoxicillin',
    brand: 'GSK',
    sku: `MED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `890${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    productType: 'medicine',
    categoryId: await categoryId('Antibiotics'),
    description: 'Broad spectrum antibiotic capsules',
    manufacturer: 'GSK',
    purchaseCostKobo: 4_000,
    sellingPriceKobo: 10_000,
    reorderLevel: 20,
    baseUnitId: tablet,
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: pack, factor: 10 }],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    name: string;
    sku: string;
    barcode: string;
    baseUnitId: string;
    sellingPriceKobo: number;
    purchaseCostKobo: number;
  };
}

async function createRetailProduct(overrides: Record<string, unknown> = {}) {
  const bottle = await unitId('bottle');
  const carton = await unitId('carton');
  const res = await auth(owner, ownerSession).post('/api/products', {
    name: 'Eva Bottled Water 75cl',
    brand: 'Eva',
    sku: `RET-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `615${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    productType: 'drinks',
    categoryId: await categoryId('Drinks'),
    purchaseCostKobo: 15_000,
    sellingPriceKobo: 25_000,
    reorderLevel: 12,
    baseUnitId: bottle,
    isExpiryTracked: false,
    status: 'active',
    units: [{ unitId: carton, factor: 12 }],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    name: string;
    sku: string;
    barcode: string;
    baseUnitId: string;
    sellingPriceKobo: number;
    purchaseCostKobo: number;
  };
}

async function receiveBatch(input: {
  productId: string;
  unitId: string;
  quantity: number;
  unitCostKobo: number;
  batchNumber?: string;
  expiryDate?: string;
  movementType?: 'stock_received' | 'opening_stock';
}) {
  const res = await auth(owner, ownerSession).post('/api/stock/receive', {
    operationId: randomUUID(),
    productId: input.productId,
    unitId: input.unitId,
    quantity: input.quantity,
    unitCostKobo: input.unitCostKobo,
    reason: 'Initial supplier delivery',
    batchNumber: input.batchNumber,
    expiryDate: input.expiryDate,
    movementType: input.movementType ?? 'stock_received',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.movement as { id: string; batchId: string | null };
}

beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db, migrations);
  app = createApp(db, config);
  owner = request.agent(app);
  const res = await owner
    .post('/api/auth/register-owner')
    .set('Origin', origin)
    .send(ownerCredentials);
  expect(res.status).toBe(201);
  ownerSession = res.body;
});

afterEach(async () => {
  await db.close();
});

describe('Phase 3: POS catalog, barcode lookup, and cashier boundaries', () => {
  it('searches by name, SKU, and barcode, computes sellable stock, and hides purchase cost', async () => {
    const med = await createMedicineWithPack({
      name: 'Lonart DS Artemether',
      sku: 'SKU-LONART-01',
      barcode: '8901234567890',
    });
    const tablet = await unitId('tablet');
    await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 30,
      unitCostKobo: 4_000,
      batchNumber: 'BATCH-VALID',
      expiryDate: futureDate(90),
    });
    const expiredBatch = await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 15,
      unitCostKobo: 4_000,
      batchNumber: 'BATCH-OLD',
      expiryDate: futureDate(10),
    });
    // Age BATCH-OLD into the past so it becomes expired in storage.
    await db.run('UPDATE product_batches SET expiry_date = ? WHERE id = ?', [
      pastDate(2),
      expiredBatch.batchId,
    ]);

    const { agent: cashier, session: cashierSession } = await createStaffAndLogin(
      'cashier',
      'cashier-catalog',
    );

    // Cashier cannot read inventory management endpoints, but CAN use POS endpoints.
    expect((await auth(cashier, cashierSession).get('/api/products')).status).toBe(403);

    const listRes = await auth(cashier, cashierSession).get('/api/pos/products?search=Lonart');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    const posItem = listRes.body.items[0];
    expect(posItem.totalStockQuantity).toBe(45);
    expect(posItem.sellableQuantity).toBe(30);
    expect(posItem.expiredQuantity).toBe(15);
    expect(posItem.purchaseCostKobo).toBeUndefined();
    expect(posItem.units).toHaveLength(2);
    expect(posItem.units[1]).toMatchObject({
      code: 'pack',
      factor: 10,
      sellingPriceKobo: 100_000,
    });

    const lookupByBarcode = await auth(cashier, cashierSession).get(
      '/api/pos/lookup?code=8901234567890',
    );
    expect(lookupByBarcode.status).toBe(200);
    expect(lookupByBarcode.body.product.id).toBe(med.id);

    const lookupBySku = await auth(cashier, cashierSession).get(
      '/api/pos/lookup?code=SKU-LONART-01',
    );
    expect(lookupBySku.status).toBe(200);
    expect(lookupBySku.body.product.id).toBe(med.id);
  });
});

describe('Phase 3: Payment methods, split payments, credit sales, and change calculation', () => {
  it('completes cash, bank transfer, POS terminal, and split-payment sales with integer kobo change', async () => {
    const retail = await createRetailProduct();
    const bottle = await unitId('bottle');
    await receiveBatch({
      productId: retail.id,
      unitId: bottle,
      quantity: 40,
      unitCostKobo: 15_000,
      movementType: 'opening_stock',
    });

    // 1. Cash sale with overpayment (2 bottles = 50,000 kobo = ₦500; tendered ₦1,000 = 100,000 kobo)
    const cashSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 2, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 100_000 }],
    });
    expect(cashSale.status, JSON.stringify(cashSale.body)).toBe(201);
    expect(cashSale.body.receiptNumber).toMatch(/^MM-\d{8}-0001$/);
    expect(cashSale.body.totalKobo).toBe(50_000);
    expect(cashSale.body.tenderedKobo).toBe(100_000);
    expect(cashSale.body.amountPaidKobo).toBe(50_000);
    expect(cashSale.body.changeDueKobo).toBe(50_000);
    expect(cashSale.body.initialOutstandingKobo).toBe(0);
    expect(cashSale.body.payments[0]).toMatchObject({
      method: 'cash',
      tenderedKobo: 100_000,
      netAmountKobo: 50_000,
      changeKobo: 50_000,
    });

    // 2. Bank transfer sale
    const transferSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 }],
      payments: [{ method: 'bank_transfer', amountKobo: 25_000, reference: 'TRF-998811' }],
    });
    expect(transferSale.status).toBe(201);
    expect(transferSale.body.receiptNumber).toMatch(/^MM-\d{8}-0002$/);
    expect(transferSale.body.amountPaidKobo).toBe(25_000);
    expect(transferSale.body.payments[0].reference).toBe('TRF-998811');

    // Non-cash overpayment without cash leg is rejected
    const badTransferOverpay = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 }],
      payments: [{ method: 'pos_terminal', amountKobo: 30_000, reference: 'POS-OVER' }],
    });
    expect(badTransferOverpay.status).toBe(400);
    expect(badTransferOverpay.body.error.code).toBe('OVERPAYMENT_REQUIRES_CASH');

    // 3. Split payment across POS terminal + bank transfer + cash (with cash change)
    // 4 bottles = 100,000 kobo. POS 40,000 + Transfer 30,000 + Cash tendered 50,000 => net cash 30,000, change 20,000.
    const splitSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 4, lineDiscountKobo: 0 }],
      payments: [
        { method: 'pos_terminal', amountKobo: 40_000, reference: 'POS-4411' },
        { method: 'bank_transfer', amountKobo: 30_000, reference: 'NIP-7722' },
        { method: 'cash', amountKobo: 50_000 },
      ],
    });
    expect(splitSale.status, JSON.stringify(splitSale.body)).toBe(201);
    expect(splitSale.body.totalKobo).toBe(100_000);
    expect(splitSale.body.amountPaidKobo).toBe(100_000);
    expect(splitSale.body.changeDueKobo).toBe(20_000);
    expect(splitSale.body.payments).toHaveLength(3);
  });

  it('handles credit sales, partial payments, credit limits, and partial/full debt settlements without counting unpaid credit as cash', async () => {
    const retail = await createRetailProduct();
    const bottle = await unitId('bottle');
    await receiveBatch({
      productId: retail.id,
      unitId: bottle,
      quantity: 30,
      unitCostKobo: 15_000,
      movementType: 'opening_stock',
    });

    // Walk-in credit sale must be rejected
    const walkInCredit = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 2, lineDiscountKobo: 0 }],
      payments: [],
    });
    expect(walkInCredit.status).toBe(400);
    expect(walkInCredit.body.error.code).toBe('CUSTOMER_REQUIRED_FOR_CREDIT');

    // Register customer with ₦1,200 (120,000 kobo) credit limit
    const customerRes = await auth(owner, ownerSession).post('/api/customers', {
      fullName: 'Chinedu Okafor',
      phone: '08031234567',
      email: 'chinedu@customer.test',
      address: '14 Allen Avenue, Ikeja',
      creditLimitKobo: 120_000,
    });
    expect(customerRes.status, JSON.stringify(customerRes.body)).toBe(201);
    const customerId = customerRes.body.id as string;

    // Full credit sale: 2 bottles = 50,000 kobo (paid 0, outstanding 50,000)
    const creditSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      customerId,
      items: [{ productId: retail.id, unitId: bottle, quantity: 2, lineDiscountKobo: 0 }],
      payments: [],
      dueDate: futureDate(14),
    });
    expect(creditSale.status, JSON.stringify(creditSale.body)).toBe(201);
    expect(creditSale.body.amountPaidKobo).toBe(0);
    expect(creditSale.body.initialOutstandingKobo).toBe(50_000);
    expect(creditSale.body.paymentStatus).toBe('credit');
    expect(creditSale.body.debt.outstandingKobo).toBe(50_000);

    // Part-paid sale: 4 bottles = 100,000 kobo, cash 40,000, credit 60,000 (total debt = 110,000 <= 120,000 limit)
    const partialSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      customerId,
      items: [{ productId: retail.id, unitId: bottle, quantity: 4, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 40_000 }],
    });
    expect(partialSale.status, JSON.stringify(partialSale.body)).toBe(201);
    expect(partialSale.body.amountPaidKobo).toBe(40_000);
    expect(partialSale.body.initialOutstandingKobo).toBe(60_000);
    expect(partialSale.body.paymentStatus).toBe('partial');

    // Exceeding credit limit (remaining credit headroom is 10,000; trying another 25,000 unpaid)
    const overLimit = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      customerId,
      items: [{ productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 }],
      payments: [],
    });
    expect(overLimit.status).toBe(409);
    expect(overLimit.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');

    // Verify financial summary BEFORE debt repayment:
    // Revenue = 150,000 kobo, Cash received = ONLY 40,000 kobo (NOT 150,000!), Outstanding debt = 110,000 kobo
    const summaryBefore = await auth(owner, ownerSession).get('/api/sales/summary');
    expect(summaryBefore.status).toBe(200);
    expect(summaryBefore.body.todayFinancials.salesRevenueKobo).toBe(150_000);
    expect(summaryBefore.body.todayFinancials.cashMethodReceivedKobo).toBe(40_000);
    expect(summaryBefore.body.todayFinancials.cashActuallyReceivedKobo).toBe(40_000);
    expect(summaryBefore.body.todayFinancials.periodCreditSalesKobo).toBe(110_000);
    expect(summaryBefore.body.todayFinancials.outstandingCreditKobo).toBe(110_000);

    // Partial repayment on first debt (20,000 via bank transfer)
    const firstDebtId = creditSale.body.debt.id as string;
    const partialRepay = await auth(owner, ownerSession).post(
      `/api/debts/${firstDebtId}/repayments`,
      {
        operationId: randomUUID(),
        amountKobo: 20_000,
        method: 'bank_transfer',
        reference: 'DEBT-TRF-01',
      },
    );
    expect(partialRepay.status, JSON.stringify(partialRepay.body)).toBe(201);
    expect(partialRepay.body.debt.status).toBe('partial');
    expect(partialRepay.body.debt.outstandingKobo).toBe(30_000);

    // FIFO customer-level settlement across both open debts (remaining 30,000 + 60,000 = 90,000) with idempotent retry
    const settleOpId = randomUUID();
    const settlePayload = {
      operationId: settleOpId,
      amountKobo: 90_000,
      method: 'pos_terminal',
      reference: 'FIFO-SETTLE-01',
    };
    const fullSettle = await auth(owner, ownerSession).post(
      `/api/customers/${customerId}/repayments`,
      settlePayload,
    );
    expect(fullSettle.status, JSON.stringify(fullSettle.body)).toBe(201);
    expect(fullSettle.body.customer.outstandingBalanceKobo).toBe(0);
    expect(fullSettle.body.payments).toHaveLength(2);

    // Replay identical customer repayment — must NOT fail or double-charge
    const replayedSettle = await auth(owner, ownerSession).post(
      `/api/customers/${customerId}/repayments`,
      settlePayload,
    );
    expect(replayedSettle.status).toBe(201);
    expect(replayedSettle.body.customer.outstandingBalanceKobo).toBe(0);

    // Summary now shows 0 outstanding debt and 150,000 total money received (40k cash + 20k transfer + 90k POS)
    const summaryAfter = await auth(owner, ownerSession).get('/api/sales/summary');
    expect(summaryAfter.body.todayFinancials.outstandingCreditKobo).toBe(0);
    expect(summaryAfter.body.todayFinancials.cashMethodReceivedKobo).toBe(40_000);
    expect(summaryAfter.body.todayFinancials.bankTransferReceivedKobo).toBe(20_000);
    expect(summaryAfter.body.todayFinancials.posReceivedKobo).toBe(90_000);
    expect(summaryAfter.body.todayFinancials.debtRepaymentsReceivedKobo).toBe(110_000);
    expect(summaryAfter.body.todayFinancials.cashActuallyReceivedKobo).toBe(150_000);
  });
});

describe('Phase 3: Inventory FEFO, expired medicines, unit conversions, idempotency, and rollback', () => {
  it('allocates medicine batches by FEFO, blocks expired stock, converts pack units, and keeps ledger reconciled', async () => {
    const med = await createMedicineWithPack();
    const tablet = await unitId('tablet');
    const pack = await unitId('pack');

    // Receive 3 batches:
    // 1. Expired batch (15 tablets)
    // 2. Later valid batch (20 tablets, expires in 120 days, cost 4,500)
    // 3. Earlier valid batch (15 tablets, expires in 30 days, cost 4,000)
    const expiredRec = await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 15,
      unitCostKobo: 3_500,
      batchNumber: 'BATCH-EXPIRED',
      expiryDate: futureDate(5),
    });
    await db.run('UPDATE product_batches SET expiry_date = ? WHERE id = ?', [
      pastDate(3),
      expiredRec.batchId,
    ]);

    const laterRec = await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 20,
      unitCostKobo: 4_500,
      batchNumber: 'BATCH-LATER',
      expiryDate: futureDate(120),
    });
    const soonerRec = await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 15,
      unitCostKobo: 4_000,
      batchNumber: 'BATCH-SOONER',
      expiryDate: futureDate(30),
    });

    // Total physical stock is 50 tablets, but only 35 are non-expired!
    // Trying to sell 4 packs (40 tablets) MUST fail with EXPIRED_STOCK_UNAVAILABLE (never selling expired batch)
    const trySell40 = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: med.id, unitId: pack, quantity: 4, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 400_000 }],
    });
    expect(trySell40.status).toBe(409);
    expect(trySell40.body.error.code).toBe('EXPIRED_STOCK_UNAVAILABLE');

    // Trying to sell 6 packs (60 tablets > 50 total) MUST fail with INSUFFICIENT_STOCK
    const trySell60 = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: med.id, unitId: pack, quantity: 6, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 600_000 }],
    });
    expect(trySell60.status).toBe(409);
    expect(trySell60.body.error.code).toBe('INSUFFICIENT_STOCK');

    // Sell 2 packs (20 tablets = 200,000 kobo):
    // FEFO must take ALL 15 tablets from BATCH-SOONER + 5 tablets from BATCH-LATER, and 0 from BATCH-EXPIRED!
    const saleOpId = randomUUID();
    const salePayload = {
      operationId: saleOpId,
      items: [{ productId: med.id, unitId: pack, quantity: 2, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 200_000 }],
    };
    const sale = await auth(owner, ownerSession).post('/api/sales', salePayload);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.items[0].baseQuantity).toBe(20);
    expect(sale.body.items[0].allocations).toEqual([
      expect.objectContaining({
        batchId: soonerRec.batchId,
        batchNumber: 'BATCH-SOONER',
        baseQuantity: 15,
        unitCostKobo: 4_000,
      }),
      expect.objectContaining({
        batchId: laterRec.batchId,
        batchNumber: 'BATCH-LATER',
        baseQuantity: 5,
        unitCostKobo: 4_500,
      }),
    ]);
    const storedCogs = (
      await db.all<{ cogs_kobo: number }>('SELECT cogs_kobo FROM sales WHERE id = ?', [
        sale.body.id,
      ])
    )[0]!.cogs_kobo;
    expect(storedCogs).toBe(82_500);

    // Duplicate retry with identical operationId returns the exact same sale without deducting again
    const retry = await auth(owner, ownerSession).post('/api/sales', salePayload);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(sale.body.id);

    // Mutated retry with same operationId fails with 409 OPERATION_CONFLICT
    const conflict = await auth(owner, ownerSession).post('/api/sales', {
      ...salePayload,
      payments: [{ method: 'bank_transfer', amountKobo: 200_000 }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');

    // Verify quantity_received was NOT modified by sale deductions, and inventory reconciliation has 0 drift
    const batches = await db.all<{
      id: string;
      quantity_received: number;
      quantity_remaining: number;
    }>(
      'SELECT id, quantity_received, quantity_remaining FROM product_batches WHERE product_id = ?',
      [med.id],
    );
    const byId = new Map(batches.map((row) => [row.id, row]));
    expect(byId.get(expiredRec.batchId!)?.quantity_remaining).toBe(15);
    expect(byId.get(soonerRec.batchId!)).toEqual({
      id: soonerRec.batchId,
      quantity_received: 15,
      quantity_remaining: 0,
    });
    expect(byId.get(laterRec.batchId!)).toEqual({
      id: laterRec.batchId,
      quantity_received: 20,
      quantity_remaining: 15,
    });

    const recon = await auth(owner, ownerSession).get('/api/inventory/reconciliation');
    expect(recon.status).toBe(200);
    expect(recon.body.inconsistentCount).toBe(0);
  });

  it('rolls back sales, stock movements, and receipt numbers atomically when a multi-line checkout fails mid-transaction', async () => {
    const itemA = await createRetailProduct({ name: 'Peak Milk Tin' });
    const itemB = await createRetailProduct({ name: 'Milo Sachet Pack' });
    const bottle = await unitId('bottle');

    await receiveBatch({
      productId: itemA.id,
      unitId: bottle,
      quantity: 10,
      unitCostKobo: 15_000,
      movementType: 'opening_stock',
    });
    await receiveBatch({
      productId: itemB.id,
      unitId: bottle,
      quantity: 2,
      unitCostKobo: 15_000,
      movementType: 'opening_stock',
    });

    // Line 1 (itemA qty 3) succeeds, Line 2 (itemB qty 5 > 2) fails -> entire transaction must roll back!
    const failedSale = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [
        { productId: itemA.id, unitId: bottle, quantity: 3, lineDiscountKobo: 0 },
        { productId: itemB.id, unitId: bottle, quantity: 5, lineDiscountKobo: 0 },
      ],
      payments: [{ method: 'cash', amountKobo: 200_000 }],
    });
    expect(failedSale.status).toBe(409);
    expect(failedSale.body.error.code).toBe('INSUFFICIENT_STOCK');

    const salesCount = (await db.all<{ c: number }>('SELECT COUNT(*) AS c FROM sales'))[0]!.c;
    expect(salesCount).toBe(0);

    const saleMovements = (
      await db.all<{ c: number }>(
        "SELECT COUNT(*) AS c FROM stock_movements WHERE movement_type = 'sale'",
      )
    )[0]!.c;
    expect(saleMovements).toBe(0);

    const itemABalance = (
      await db.all<{ quantity: number }>(
        'SELECT quantity FROM stock_balances WHERE product_id = ?',
        [itemA.id],
      )
    )[0]!.quantity;
    expect(itemABalance).toBe(10);
  });
});

describe('Phase 3: Discounts, supervisor overrides, voids, refunds, non-deletion, RBAC, and financial separation', () => {
  it('enforces discount permissions and supports constant-time supervisor authorization without logging passwords', async () => {
    const retail = await createRetailProduct();
    const bottle = await unitId('bottle');
    await receiveBatch({
      productId: retail.id,
      unitId: bottle,
      quantity: 20,
      unitCostKobo: 15_000,
      movementType: 'opening_stock',
    });

    const { agent: cashier, session: cashierSession } = await createStaffAndLogin(
      'cashier',
      'cashier-disc',
    );
    const { email: managerEmail, password: managerPassword } = await createStaffAndLogin(
      'manager',
      'manager-disc',
    );
    const { email: otherCashierEmail, password: otherCashierPassword } = await createStaffAndLogin(
      'cashier',
      'cashier-peer',
    );

    // Cashier cannot apply discount alone
    const denied = await auth(cashier, cashierSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 3, lineDiscountKobo: 0 }],
      cartDiscountKobo: 5_000,
      discountReason: 'Loyal regular customer',
      payments: [{ method: 'cash', amountKobo: 70_000 }],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');

    // Peer cashier override also rejected (lacks sales.discount)
    const peerDenied = await auth(cashier, cashierSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: retail.id, unitId: bottle, quantity: 3, lineDiscountKobo: 0 }],
      cartDiscountKobo: 5_000,
      discountReason: 'Loyal regular customer',
      discountAuthorization: { email: otherCashierEmail, password: otherCashierPassword },
      payments: [{ method: 'cash', amountKobo: 70_000 }],
    });
    expect(peerDenied.status).toBe(403);

    // Manager override succeeds; cart discount of 5,000 across 3 identical lines distributes cleanly in integer kobo
    const approved = await auth(cashier, cashierSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [
        { productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 },
        { productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 },
        { productId: retail.id, unitId: bottle, quantity: 1, lineDiscountKobo: 0 },
      ],
      cartDiscountKobo: 5_000,
      discountReason: 'Loyal regular customer',
      discountAuthorization: { email: managerEmail, password: managerPassword },
      payments: [{ method: 'cash', amountKobo: 70_000 }],
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.subtotalKobo).toBe(75_000);
    expect(approved.body.discountTotalKobo).toBe(5_000);
    expect(approved.body.totalKobo).toBe(70_000);
    expect(approved.body.discountAuthorizedByName).toContain('MANAGER-DISC');
    const sumLines = approved.body.items.reduce(
      (sum: number, item: { lineTotalKobo: number }) => sum + item.lineTotalKobo,
      0,
    );
    expect(sumLines).toBe(75_000);
    const sumNetLines = approved.body.items.reduce(
      (sum: number, item: { netTotalKobo: number }) => sum + item.netTotalKobo,
      0,
    );
    expect(sumNetLines).toBe(70_000);

    // Audit log must NEVER store supervisor password
    const audits = await db.all<{ metadata_json: string }>('SELECT metadata_json FROM audit_logs');
    for (const row of audits) {
      expect(row.metadata_json).not.toContain(managerPassword);
    }
  });

  it('prevents deleting completed sales, handles voids and partial/full refunds with batch restoration and credit reduction, and keeps revenue/cash/COGS/profit separate', async () => {
    const med = await createMedicineWithPack({
      purchaseCostKobo: 4_000,
      sellingPriceKobo: 10_000,
    });
    const tablet = await unitId('tablet');
    const batch = await receiveBatch({
      productId: med.id,
      unitId: tablet,
      quantity: 50,
      unitCostKobo: 4_000,
      batchNumber: 'BATCH-REV-01',
      expiryDate: futureDate(180),
    });

    const customerRes = await auth(owner, ownerSession).post('/api/customers', {
      fullName: 'Ngozi Eze',
      phone: '08099887766',
      creditLimitKobo: 500_000,
    });
    const customerId = customerRes.body.id as string;

    // Sale 1: 10 tablets = 100,000 kobo (COGS = 40,000), paid 100,000 cash -> then VOIDED
    const saleToVoid = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: med.id, unitId: tablet, quantity: 10, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 100_000 }],
    });
    expect(saleToVoid.status).toBe(201);

    // Direct SQL DELETE on completed sale MUST fail via SQLite trigger
    await expect(db.run('DELETE FROM sales WHERE id = ?', [saleToVoid.body.id])).rejects.toThrow(
      /completed sales cannot be deleted/i,
    );
    await expect(
      db.run('DELETE FROM sale_payments WHERE sale_id = ?', [saleToVoid.body.id]),
    ).rejects.toThrow(/append-only/);

    // Cashier is forbidden from voiding or refunding
    const { agent: cashier, session: cashierSession } = await createStaffAndLogin(
      'cashier',
      'cashier-void',
    );
    expect(
      (
        await auth(cashier, cashierSession).post(`/api/sales/${saleToVoid.body.id}/void`, {
          operationId: randomUUID(),
          reason: 'Cashier attempt',
          refundMethod: 'cash',
        })
      ).status,
    ).toBe(403);
    expect((await auth(cashier, cashierSession).get('/api/debts')).status).toBe(403);
    expect((await auth(cashier, cashierSession).get('/api/reports/sales')).status).toBe(403);

    // Owner voids Sale 1 -> stock returns to 50, quantity_received remains 50, sale row still exists as 'voided'
    const voidRes = await auth(owner, ownerSession).post(`/api/sales/${saleToVoid.body.id}/void`, {
      operationId: randomUUID(),
      reason: 'Customer changed mind immediately at counter',
      refundMethod: 'cash',
    });
    expect(voidRes.status, JSON.stringify(voidRes.body)).toBe(200);
    expect(voidRes.body.status).toBe('voided');
    expect(voidRes.body.reversals).toHaveLength(1);

    const batchAfterVoid = (
      await db.all<{ quantity_received: number; quantity_remaining: number }>(
        'SELECT quantity_received, quantity_remaining FROM product_batches WHERE id = ?',
        [batch.batchId],
      )
    )[0]!;
    expect(batchAfterVoid).toEqual({ quantity_received: 50, quantity_remaining: 50 });

    // Sale 2: Part-paid credit sale of 20 tablets = 200,000 kobo (COGS = 80,000).
    // Paid 60,000 cash + 140,000 credit.
    const sale2 = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      customerId,
      items: [{ productId: med.id, unitId: tablet, quantity: 20, lineDiscountKobo: 0 }],
      payments: [{ method: 'cash', amountKobo: 60_000 }],
    });
    expect(sale2.status).toBe(201);
    const sale2LineId = sale2.body.items[0].id as string;

    // Partial refund of 5 tablets (50,000 kobo, COGS = 20,000) with restockItems: true.
    // Because customer owes 140,000 credit, all 50,000 MUST reduce unpaid credit (0 cash paid out)!
    const refundRes = await auth(owner, ownerSession).post(`/api/sales/${sale2.body.id}/refund`, {
      operationId: randomUUID(),
      reason: 'Returned 5 unopened tablets',
      restockItems: true,
      refundMethod: 'cash',
      items: [{ saleItemId: sale2LineId, quantity: 5 }],
    });
    expect(refundRes.status, JSON.stringify(refundRes.body)).toBe(200);
    expect(refundRes.body.status).toBe('partially_refunded');
    expect(refundRes.body.debt.outstandingKobo).toBe(90_000);
    expect(refundRes.body.reversals[0]).toMatchObject({
      totalReversedKobo: 50_000,
      debtReducedKobo: 50_000,
      cashRefundedKobo: 0,
      restockItems: true,
    });

    // Cashier summary hides COGS & gross profit (`null`), whereas owner report exposes exact figures
    const cashierSummary = await auth(cashier, cashierSession).get('/api/sales/summary');
    expect(cashierSummary.status).toBe(200);
    expect(cashierSummary.body.todayFinancials.costOfGoodsSoldKobo).toBeNull();
    expect(cashierSummary.body.todayFinancials.grossProfitKobo).toBeNull();

    // Verify financial separation report:
    // Gross sales: 100,000 (Sale 1) + 200,000 (Sale 2) = 300,000
    // Voided: 100,000 (Sale 1), Refunded: 50,000 (Sale 2)
    // Net sales revenue = 150,000 (15 tablets net sold)
    // Net COGS = (40,000 + 80,000) - (40,000 + 20,000) = 60,000
    // Gross profit = 150,000 - 60,000 = 90,000 (NOT equal to 150,000 revenue!)
    // Cash received net = (100,000 - 100,000 void cash refund) + 60,000 = 60,000
    // Outstanding credit = 90,000
    const report = await auth(owner, ownerSession).get('/api/reports/sales');
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.financials).toMatchObject({
      grossSalesKobo: 200_000,
      voidedSalesKobo: 100_000,
      refundsKobo: 50_000,
      salesRevenueKobo: 150_000,
      cashMethodReceivedKobo: 60_000,
      cashActuallyReceivedKobo: 60_000,
      outstandingCreditKobo: 90_000,
      costOfGoodsSoldKobo: 60_000,
      grossProfitKobo: 90_000,
      expensesTracked: false,
      expensesKobo: 0,
    });
    expect(report.body.financials.grossProfitKobo).not.toBe(
      report.body.financials.salesRevenueKobo,
    );

    // Final reconciliation check: 50 received - 15 net sold = 35 remaining, 0 drift
    const recon = await auth(owner, ownerSession).get('/api/inventory/reconciliation');
    expect(recon.body.inconsistentCount).toBe(0);
    const productDetail = await auth(owner, ownerSession).get(`/api/products/${med.id}`);
    expect(productDetail.body.stockQuantity).toBe(35);

    // Over-refund beyond remaining 15 tablets is rejected
    const overRefund = await auth(owner, ownerSession).post(`/api/sales/${sale2.body.id}/refund`, {
      operationId: randomUUID(),
      reason: 'Trying to refund more than sold',
      restockItems: true,
      refundMethod: 'cash',
      items: [{ saleItemId: sale2LineId, quantity: 16 }],
    });
    expect(overRefund.status).toBe(409);

    // Non-restocking refund (damaged return) of 2 tablets does NOT add back to stock
    const damagedRefund = await auth(owner, ownerSession).post(
      `/api/sales/${sale2.body.id}/refund`,
      {
        operationId: randomUUID(),
        reason: '2 tablets returned with broken blister',
        restockItems: false,
        refundMethod: 'cash',
        items: [{ saleItemId: sale2LineId, quantity: 2 }],
      },
    );
    expect(damagedRefund.status, JSON.stringify(damagedRefund.body)).toBe(200);
    const productAfterDamaged = await auth(owner, ownerSession).get(`/api/products/${med.id}`);
    expect(productAfterDamaged.body.stockQuantity).toBe(35);
  });

  it('persists receipt shop settings while preserving backward compatibility for businessName-only updates', async () => {
    const fullSettings = await auth(owner, ownerSession).put('/api/settings', {
      businessName: 'MediMart Surulere',
      shopAddress: '42 Bode Thomas Street, Surulere, Lagos',
      shopPhone: '+234 803 000 1122',
      shopEmail: 'receipts@medimart.ng',
      receiptFooter: 'Keep medicines out of reach of children.',
    });
    expect(fullSettings.status, JSON.stringify(fullSettings.body)).toBe(200);
    expect(fullSettings.body).toEqual({
      businessName: 'MediMart Surulere',
      shopAddress: '42 Bode Thomas Street, Surulere, Lagos',
      shopPhone: '+234 803 000 1122',
      shopEmail: 'receipts@medimart.ng',
      receiptFooter: 'Keep medicines out of reach of children.',
    });

    // Legacy Phase 1 caller sending ONLY { businessName } must succeed and preserve receipt fields
    const legacyUpdate = await auth(owner, ownerSession).put('/api/settings', {
      businessName: 'MediMart Victoria Island',
    });
    expect(legacyUpdate.status).toBe(200);
    expect(legacyUpdate.body.businessName).toBe('MediMart Victoria Island');
    expect(legacyUpdate.body.shopAddress).toBe('42 Bode Thomas Street, Surulere, Lagos');
  });
});
