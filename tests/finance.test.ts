import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import type {
  FinancialDashboardSummary,
  FinancialExport,
  FinancialReport,
  GoodsReceiptDetail,
  PurchaseOrderDetail,
  SessionResponse,
  SupplierAccountDetail,
  SupplierPaymentSummary,
} from '@medimart/shared';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';

const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: ':memory:',
  bootstrapToken: 'd'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  authRateLimit: 100,
};
const origin = 'https://trusted.medimart.test';
const ownerBody = {
  fullName: 'Finance Owner',
  email: 'owner@finance.test',
  password: 'A long private finance owner passphrase',
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

async function createStaff(role: string) {
  const email = `${role}@finance.test`;
  const password = `Strong ${role} finance passphrase 2026!`;
  const created = await auth(owner, ownerSession).post('/api/staff', {
    fullName: `${role} staff`,
    email,
    password,
    roles: [role],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').set('Origin', origin).send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { agent, session: login.body as SessionResponse };
}

async function unit(code: string) {
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
const today = () => new Date().toISOString().slice(0, 10);
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function createSupplier(name = 'Emzor Distribution') {
  const res = await auth(owner, ownerSession).post('/api/suppliers', {
    name,
    contactPerson: 'Chinedu Eze',
    phone: '+2348012345678',
    email: `${name.toLowerCase().replaceAll(/[^a-z]+/g, '-')}@example.test`,
    address: '12 Marina Road, Lagos',
    businessInfo: 'RC 1234567',
    notes: 'Wholesale supplier',
    status: 'active',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string };
}

async function createMedicine(overrides: Record<string, unknown> = {}) {
  const res = await auth(owner, ownerSession).post('/api/products', {
    name: 'Amoxicillin 500mg',
    genericName: 'Amoxicillin',
    brand: 'GSK',
    sku: `MED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `890${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    productType: 'medicine',
    categoryId: await categoryId('Antibiotics'),
    manufacturer: 'GSK',
    purchaseCostKobo: 400,
    sellingPriceKobo: 1_000,
    reorderLevel: 20,
    baseUnitId: await unit('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: await unit('pack'), factor: 10 }],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    name: string;
    baseUnitId: string;
    purchaseCostKobo: number;
    sellingPriceKobo: number;
  };
}

async function createRetail(overrides: Record<string, unknown> = {}) {
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
    baseUnitId: await unit('bottle'),
    isExpiryTracked: false,
    status: 'active',
    units: [{ unitId: await unit('carton'), factor: 12 }],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    name: string;
    baseUnitId: string;
    purchaseCostKobo: number;
    sellingPriceKobo: number;
  };
}

async function createPurchase(
  supplierId: string,
  items: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
  session = ownerSession,
) {
  const res = await auth(owner, session).post('/api/purchases', {
    operationId: randomUUID(),
    supplierId,
    items,
    status: 'ordered',
    orderDiscountKobo: 0,
    additionalChargesKobo: 0,
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as PurchaseOrderDetail;
}

async function receive(
  purchaseId: string,
  items: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
  session = ownerSession,
  agent = owner,
) {
  const res = await auth(agent, session).post(`/api/purchases/${purchaseId}/receipts`, {
    operationId: randomUUID(),
    receivedDate: today(),
    items,
    ...overrides,
  });
  return {
    status: res.status,
    body: res.body as GoodsReceiptDetail & {
      purchase: PurchaseOrderDetail;
      receipt: GoodsReceiptDetail;
      error: { code: string };
    },
  };
}

async function supplierAccount(supplierId: string) {
  const res = await auth(owner, ownerSession).get(`/api/suppliers/${supplierId}/account`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SupplierAccountDetail;
}

async function stockQuantity(productId: string) {
  const row = (
    await db.all<{ quantity: number }>('SELECT quantity FROM stock_balances WHERE product_id = ?', [
      productId,
    ])
  )[0];
  return Number(row?.quantity ?? 0);
}

beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db, migrations);
  app = createApp(db, config);
  owner = request.agent(app);
  const res = await owner.post('/api/auth/register-owner').set('Origin', origin).send(ownerBody);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  ownerSession = res.body;
});

afterEach(async () => {
  await db.close();
});

describe('purchase orders', () => {
  it('creates a draft purchase with unit conversions, discounts and charges without touching stock', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const retail = await createRetail();
    const tab = await unit('tablet');
    const pack = await unit('pack');
    const carton = await unit('carton');

    const res = await auth(owner, ownerSession).post('/api/purchases', {
      operationId: randomUUID(),
      supplierId: supplier.id,
      status: 'draft',
      items: [
        { productId: medicine.id, unitId: pack, quantity: 2, unitCostKobo: 40_000 },
        { productId: retail.id, unitId: carton, quantity: 1, unitCostKobo: 180_000 },
      ],
      orderDiscountKobo: 10_000,
      discountReason: 'Negotiated wholesale discount',
      additionalChargesKobo: 5_000,
      additionalChargesReason: 'Delivery and handling',
      expectedDeliveryDate: future(7),
      notes: 'Deliver to the back store',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const purchase = res.body as PurchaseOrderDetail;
    expect(purchase.status).toBe('draft');
    expect(purchase.referenceNumber).toMatch(/^PO-\d{8}-\d{4}$/);
    expect(purchase.supplierName).toBe(supplier.name);
    expect(purchase.subtotalKobo).toBe(260_000);
    expect(purchase.lineDiscountTotalKobo).toBe(0);
    expect(purchase.discountTotalKobo).toBe(10_000);
    expect(purchase.additionalChargesKobo).toBe(5_000);
    expect(purchase.totalKobo).toBe(255_000);
    expect(purchase.items).toHaveLength(2);
    const medicineLine = purchase.items.find((line) => line.productId === medicine.id)!;
    expect(medicineLine.baseQuantity).toBe(20);
    expect(medicineLine.unitSymbol).toBe('pack');
    expect(medicineLine.receivedQuantity).toBe(0);
    expect(purchase.items.find((line) => line.productId === retail.id)!.baseQuantity).toBe(12);
    expect(medicineLine.conversionFactor).toBe(10);

    // An order is commercial intent only: no stock balance, batch or ledger movement.
    expect(await stockQuantity(medicine.id)).toBe(0);
    expect(await stockQuantity(retail.id)).toBe(0);
    expect(await db.all('SELECT * FROM stock_movements')).toHaveLength(0);
    expect(await db.all('SELECT * FROM product_batches')).toHaveLength(0);
    expect(await db.all('SELECT * FROM goods_receipts')).toHaveLength(0);
    expect(tab).toBe(medicine.baseUnitId);
  });

  it('replays an identical create exactly once and rejects a changed operation payload', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const pack = await unit('pack');
    const operationId = randomUUID();
    const body = {
      operationId,
      supplierId: supplier.id,
      items: [{ productId: medicine.id, unitId: pack, quantity: 1, unitCostKobo: 40_000 }],
    };
    const first = await auth(owner, ownerSession).post('/api/purchases', {
      ...body,
      status: 'ordered',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await auth(owner, ownerSession).post('/api/purchases', {
      ...body,
      status: 'ordered',
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await db.all('SELECT * FROM purchase_orders')).toHaveLength(1);

    const conflict = await auth(owner, ownerSession).post('/api/purchases', {
      ...body,
      status: 'ordered',
      items: [{ productId: medicine.id, unitId: pack, quantity: 2, unitCostKobo: 40_000 }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');
  });

  it('marks an order as ordered, filters it, and cancels it without changing stock', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const pack = await unit('pack');
    const draft = await createPurchase(
      supplier.id,
      [{ productId: medicine.id, unitId: pack, quantity: 1, unitCostKobo: 40_000 }],
      { status: 'draft' },
    );
    expect(draft.status).toBe('draft');

    const ordered = await auth(owner, ownerSession).post(`/api/purchases/${draft.id}/order`, {});
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(200);
    expect(ordered.body.status).toBe('ordered');
    expect(ordered.body.orderedAt).toBeTruthy();

    const filtered = await auth(owner, ownerSession).get(
      `/api/purchases?supplierId=${supplier.id}&status=ordered&search=${draft.referenceNumber}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].id).toBe(draft.id);

    const cancelled = await auth(owner, ownerSession).post(`/api/purchases/${draft.id}/cancel`, {
      reason: 'Supplier could not fulfil the order',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancelReason).toBe('Supplier could not fulfil the order');
    expect(await stockQuantity(medicine.id)).toBe(0);

    const receipt = await receive(draft.id, [
      { purchaseOrderItemId: draft.items[0]!.id, quantityReceived: 1 },
    ]);
    expect(receipt.status).toBe(409);
    expect(receipt.body.error.code).toBe('PURCHASE_NOT_RECEIVABLE');
  });
});

describe('goods receiving', () => {
  it('receives partially, creates batches and ledger movements once, and prevents duplicate or excess receipts', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const retail = await createRetail();
    const pack = await unit('pack');
    const carton = await unit('carton');
    const purchase = await createPurchase(supplier.id, [
      { productId: medicine.id, unitId: pack, quantity: 2, unitCostKobo: 40_000 },
      { productId: retail.id, unitId: carton, quantity: 1, unitCostKobo: 180_000 },
    ]);
    const medicineLine = purchase.items.find((line) => line.productId === medicine.id)!;
    const retailLine = purchase.items.find((line) => line.productId === retail.id)!;
    const operationId = randomUUID();
    const firstItems = [
      {
        purchaseOrderItemId: medicineLine.id,
        quantityReceived: 1,
        unitCostKobo: 42_000,
        batchNumber: 'AMOX-2601',
        manufacturingDate: past(60),
        expiryDate: future(365),
      },
    ];
    const first = await auth(owner, ownerSession).post(`/api/purchases/${purchase.id}/receipts`, {
      operationId,
      receivedDate: today(),
      items: firstItems,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.receipt.receiptNumber).toMatch(/^GRN-\d{8}-\d{4}$/);
    expect(first.body.receipt.receivedValueKobo).toBe(42_000);
    expect(first.body.purchase.status).toBe('partially_received');
    expect(
      first.body.purchase.items.find((line: { id: string }) => line.id === medicineLine.id)
        .receivedQuantity,
    ).toBe(1);
    expect(await stockQuantity(medicine.id)).toBe(10);
    expect(await stockQuantity(retail.id)).toBe(0);
    const batch = (
      await db.all<{ id: string; purchase_cost_kobo: number; expiry_date: string }>(
        'SELECT id,purchase_cost_kobo,expiry_date FROM product_batches WHERE product_id = ?',
        [medicine.id],
      )
    )[0]!;
    expect(Number(batch.purchase_cost_kobo)).toBe(4_200);
    expect(batch.expiry_date).toBe(future(365));
    const movements = await db.all<{ reference_id: string; movement_type: string }>(
      'SELECT reference_id,movement_type FROM stock_movements WHERE product_id = ?',
      [medicine.id],
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]!.movement_type).toBe('stock_received');
    expect(movements[0]!.reference_id).toBe(first.body.receipt.receiptNumber);

    // Exact replay of the same operation is a no-op, not a second delivery.
    const replay = await auth(owner, ownerSession).post(`/api/purchases/${purchase.id}/receipts`, {
      operationId,
      receivedDate: today(),
      items: firstItems,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.receipt.id).toBe(first.body.receipt.id);
    expect(await stockQuantity(medicine.id)).toBe(10);
    expect(await db.all('SELECT * FROM goods_receipts')).toHaveLength(1);
    expect(await db.all('SELECT * FROM stock_movements')).toHaveLength(1);

    const changedReplay = await auth(owner, ownerSession).post(
      `/api/purchases/${purchase.id}/receipts`,
      {
        operationId,
        receivedDate: today(),
        items: [{ ...firstItems[0], quantityReceived: 2 }],
      },
    );
    expect(changedReplay.status).toBe(409);
    expect(changedReplay.body.error.code).toBe('OPERATION_CONFLICT');

    // Receiving more than is outstanding is refused and does not move stock.
    const excess = await receive(purchase.id, [
      {
        purchaseOrderItemId: medicineLine.id,
        quantityReceived: 2,
        batchNumber: 'AMOX-2601',
        expiryDate: future(365),
      },
    ]);
    expect(excess.status).toBe(409);
    expect(excess.body.error.code).toBe('RECEIVE_EXCEEDS_ORDER');
    expect(await stockQuantity(medicine.id)).toBe(10);

    // A second delivery of the same batch adds to the existing batch.
    const second = await receive(purchase.id, [
      {
        purchaseOrderItemId: medicineLine.id,
        quantityReceived: 1,
        unitCostKobo: 42_000,
        batchNumber: 'AMOX-2601',
        manufacturingDate: past(60),
        expiryDate: future(365),
      },
    ]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await stockQuantity(medicine.id)).toBe(20);
    const batchAfter = (
      await db.all<{ quantity_received: number; quantity_remaining: number }>(
        'SELECT quantity_received,quantity_remaining FROM product_batches WHERE id = ?',
        [batch.id],
      )
    )[0]!;
    expect(Number(batchAfter.quantity_received)).toBe(20);
    expect(Number(batchAfter.quantity_remaining)).toBe(20);

    // A full delivery of the remaining line closes the order.
    const third = await receive(purchase.id, [
      {
        purchaseOrderItemId: retailLine.id,
        quantityReceived: 1,
        unitCostKobo: 190_000,
        batchNumber: 'EVA-2601',
        expiryDate: future(200),
      },
    ]);
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    expect(third.body.purchase.status).toBe('received');
    expect(third.body.purchase.receivedValueKobo).toBe(42_000 + 42_000 + 190_000);
    expect(await stockQuantity(retail.id)).toBe(12);
    const retailBatch = (
      await db.all<{ purchase_cost_kobo: number }>(
        'SELECT purchase_cost_kobo FROM product_batches WHERE product_id = ?',
        [retail.id],
      )
    )[0]!;
    // 190000 kobo per carton / 12 bottles rounds to an integer base-unit cost.
    expect(Number(retailBatch.purchase_cost_kobo)).toBe(15_833);
    expect(Number.isInteger(Number(retailBatch.purchase_cost_kobo))).toBe(true);

    const account = await supplierAccount(supplier.id);
    expect(account.totalGoodsReceivedKobo).toBe(274_000);
    expect(account.netPaidKobo).toBe(0);
    expect(account.outstandingBalanceKobo).toBe(274_000);
    expect(account.outstandingInvoiceCount).toBe(1);
    expect(account.outstandingInvoices[0]!.outstandingKobo).toBe(274_000);
  });

  it('records rejected goods without increasing stock or creating a payable', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const pack = await unit('pack');
    const purchase = await createPurchase(supplier.id, [
      { productId: medicine.id, unitId: pack, quantity: 1, unitCostKobo: 40_000 },
    ]);
    const result = await receive(purchase.id, [
      {
        purchaseOrderItemId: purchase.items[0]!.id,
        quantityReceived: 0,
        quantityRejected: 1,
        rejectionReason: 'Cartons damaged in transit',
      },
    ]);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.receipt.receivedValueKobo).toBe(0);
    expect(result.body.receipt.totalRejectedBaseQuantity).toBe(10);
    expect(result.body.receipt.items[0]!.quantityRejected).toBe(1);
    expect(result.body.receipt.items[0]!.baseQuantityRejected).toBe(10);
    expect(result.body.receipt.items[0]!.stockMovementId).toBeNull();
    expect(result.body.receipt.items[0]!.batchId).toBeNull();
    expect(result.body.purchase.status).toBe('ordered');
    expect(result.body.purchase.items[0]!.receivedQuantity).toBe(0);
    expect(await stockQuantity(medicine.id)).toBe(0);
    expect(await db.all('SELECT * FROM stock_movements')).toHaveLength(0);
    const account = await supplierAccount(supplier.id);
    expect(account.outstandingBalanceKobo).toBe(0);
  });

  it('blocks expired medicine and rolls the whole receipt back when any line fails', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const retail = await createRetail();
    const pack = await unit('pack');
    const carton = await unit('carton');
    const purchase = await createPurchase(supplier.id, [
      { productId: medicine.id, unitId: pack, quantity: 1, unitCostKobo: 40_000 },
      { productId: retail.id, unitId: carton, quantity: 1, unitCostKobo: 180_000 },
    ]);
    const medicineLine = purchase.items.find((line) => line.productId === medicine.id)!;
    const retailLine = purchase.items.find((line) => line.productId === retail.id)!;

    const expired = await receive(purchase.id, [
      {
        purchaseOrderItemId: medicineLine.id,
        quantityReceived: 1,
        unitCostKobo: 40_000,
        batchNumber: 'EXPIRED-1',
        expiryDate: past(1),
      },
    ]);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('EXPIRED_GOODS_BLOCKED');
    expect(await stockQuantity(medicine.id)).toBe(0);
    expect(await db.all('SELECT * FROM goods_receipts')).toHaveLength(0);

    // First line is valid, second line exceeds the ordered quantity: everything rolls back.
    const partial = await receive(purchase.id, [
      {
        purchaseOrderItemId: medicineLine.id,
        quantityReceived: 1,
        unitCostKobo: 40_000,
        batchNumber: 'AMOX-VALID',
        expiryDate: future(365),
      },
      {
        purchaseOrderItemId: retailLine.id,
        quantityReceived: 2,
        unitCostKobo: 180_000,
        batchNumber: 'EVA-VALID',
        expiryDate: future(365),
      },
    ]);
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('RECEIVE_EXCEEDS_ORDER');
    expect(await stockQuantity(medicine.id)).toBe(0);
    expect(await stockQuantity(retail.id)).toBe(0);
    expect(await db.all('SELECT * FROM goods_receipts')).toHaveLength(0);
    expect(await db.all('SELECT * FROM goods_receipt_items')).toHaveLength(0);
    expect(await db.all('SELECT * FROM stock_movements')).toHaveLength(0);
    expect(await db.all('SELECT * FROM product_batches')).toHaveLength(0);
    expect(
      await db.all('SELECT * FROM purchase_order_items WHERE received_base_quantity > 0'),
    ).toHaveLength(0);
  });
});

describe('supplier payments and statements', () => {
  async function receivedInvoice() {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const pack = await unit('pack');
    const purchase = await createPurchase(supplier.id, [
      { productId: medicine.id, unitId: pack, quantity: 2, unitCostKobo: 40_000 },
    ]);
    const receipt = await receive(purchase.id, [
      {
        purchaseOrderItemId: purchase.items[0]!.id,
        quantityReceived: 2,
        unitCostKobo: 40_000,
        batchNumber: 'PAY-BATCH',
        expiryDate: future(300),
      },
    ]);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    return { supplier, purchase, account: await supplierAccount(supplier.id) };
  }

  async function pay(
    supplierId: string,
    purchaseId: string,
    amountKobo: number,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await auth(owner, ownerSession).post('/api/supplier-payments', {
      operationId: randomUUID(),
      supplierId,
      amountKobo,
      method: 'bank_transfer',
      paidAt: today(),
      reference: `TRX-${Math.random().toString(36).slice(2, 10)}`,
      allocations: [{ purchaseOrderId: purchaseId, amountKobo }],
      ...overrides,
    });
    return {
      status: res.status,
      body: res.body as SupplierPaymentSummary & { error: { code: string } },
    };
  }

  it('supports partial and full invoice payments, prevents overpayment and never treats credit as cash', async () => {
    const { supplier, purchase, account } = await receivedInvoice();
    expect(account.outstandingBalanceKobo).toBe(80_000);

    const partial = await pay(supplier.id, purchase.id, 30_000);
    expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    expect(partial.body.paymentNumber).toMatch(/^SP-\d{8}-\d{4}$/);
    expect(partial.body.allocations[0]!.direction).toBe('apply');
    expect(partial.body.allocations[0]!.amountKobo).toBe(30_000);

    let updated = await supplierAccount(supplier.id);
    expect(updated.netPaidKobo).toBe(30_000);
    expect(updated.outstandingBalanceKobo).toBe(50_000);
    expect(updated.outstandingInvoices[0]!.paymentStatus).toBe('partial');
    expect(updated.outstandingInvoices[0]!.outstandingKobo).toBe(50_000);

    const over = await pay(supplier.id, purchase.id, 60_000);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PAYMENT_EXCEEDS_INVOICE');

    const full = await pay(supplier.id, purchase.id, 50_000);
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    updated = await supplierAccount(supplier.id);
    expect(updated.outstandingBalanceKobo).toBe(0);
    expect(updated.outstandingInvoiceCount).toBe(0);
    expect(updated.netPaidKobo).toBe(80_000);

    const excessive = await pay(supplier.id, purchase.id, 1_000);
    expect(excessive.status).toBe(409);
    expect(excessive.body.error.code).toBe('PAYMENT_EXCEEDS_INVOICE');
    expect(await db.all('SELECT * FROM supplier_payments')).toHaveLength(2);

    // Supplier payments are money out; they never appear as customer cash received.
    const reportRes = await auth(owner, ownerSession).get(
      `/api/reports/finance?from=${today()}&to=${today()}`,
    );
    expect(reportRes.status).toBe(200);
    const report = reportRes.body as FinancialReport;
    expect(report.purchases.paidToSuppliersKobo).toBe(80_000);
    expect(report.collections.totalReceivedKobo).toBe(0);
    expect(report.purchases.goodsReceivedKobo).toBe(80_000);
    expect(report.purchases.totalOrderedKobo).toBe(80_000);
    expect(report.purchases.outstandingSupplierBalanceKobo).toBe(0);
  });

  it('deduplicates payment submissions, rejects duplicate references, and reverses with a new record', async () => {
    const { supplier, purchase } = await receivedInvoice();
    const operationId = randomUUID();
    const body = {
      operationId,
      supplierId: supplier.id,
      amountKobo: 20_000,
      method: 'bank_transfer' as const,
      paidAt: today(),
      reference: 'BANK-UNIQUE-1',
      allocations: [{ purchaseOrderId: purchase.id, amountKobo: 20_000 }],
    };
    const first = await auth(owner, ownerSession).post('/api/supplier-payments', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await auth(owner, ownerSession).post('/api/supplier-payments', body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await db.all('SELECT * FROM supplier_payments')).toHaveLength(1);

    const conflict = await auth(owner, ownerSession).post('/api/supplier-payments', {
      ...body,
      amountKobo: 21_000,
      allocations: [{ purchaseOrderId: purchase.id, amountKobo: 21_000 }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('OPERATION_CONFLICT');

    const duplicateReference = await auth(owner, ownerSession).post('/api/supplier-payments', {
      operationId: randomUUID(),
      supplierId: supplier.id,
      amountKobo: 20_000,
      method: 'bank_transfer',
      paidAt: today(),
      reference: 'BANK-UNIQUE-1',
      allocations: [{ purchaseOrderId: purchase.id, amountKobo: 20_000 }],
    });
    expect(duplicateReference.status).toBe(409);
    expect(duplicateReference.body.error.code).toBe('DUPLICATE_PAYMENT_REFERENCE');

    const reversal = await auth(owner, ownerSession).post(
      `/api/supplier-payments/${first.body.id}/reverse`,
      { operationId: randomUUID(), reason: 'Bank transfer was returned by the bank' },
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    expect(reversal.body.paymentKind).toBe('reversal');
    expect(reversal.body.reversalOfPaymentId).toBe(first.body.id);
    expect(reversal.body.allocations[0]!.direction).toBe('reverse');
    const account = await supplierAccount(supplier.id);
    expect(account.netPaidKobo).toBe(0);
    expect(account.outstandingBalanceKobo).toBe(80_000);
    expect(account.totalPaymentReversalsKobo).toBe(20_000);

    const twice = await auth(owner, ownerSession).post(
      `/api/supplier-payments/${first.body.id}/reverse`,
      { operationId: randomUUID(), reason: 'Trying to reverse again' },
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('PAYMENT_ALREADY_REVERSED');

    const statementRes = await auth(owner, ownerSession).get(
      `/api/suppliers/${supplier.id}/statement?from=${today()}&to=${today()}`,
    );
    expect(statementRes.status).toBe(200);
    const statement = statementRes.body as {
      openingBalanceKobo: number;
      closingBalanceKobo: number;
      entries: Array<{ type: string; debitKobo: number; creditKobo: number }>;
    };
    expect(statement.openingBalanceKobo).toBe(0);
    expect(statement.entries.map((entry) => entry.type)).toEqual([
      'goods_received',
      'payment',
      'payment_reversal',
    ]);
    expect(statement.entries[0]!.debitKobo).toBe(80_000);
    expect(statement.entries[1]!.creditKobo).toBe(20_000);
    expect(statement.entries[2]!.debitKobo).toBe(20_000);
    expect(statement.closingBalanceKobo).toBe(80_000);

    // Reversal is append-only: the original payment remains visible.
    const payments = await auth(owner, ownerSession).get(
      `/api/supplier-payments?supplierId=${supplier.id}`,
    );
    expect(payments.status).toBe(200);
    expect(payments.body.total).toBe(2);
  });

  it('requires the payment amount to match its invoice allocations', async () => {
    const { supplier, purchase } = await receivedInvoice();
    const res = await auth(owner, ownerSession).post('/api/supplier-payments', {
      operationId: randomUUID(),
      supplierId: supplier.id,
      amountKobo: 20_000,
      method: 'cash',
      paidAt: today(),
      allocations: [{ purchaseOrderId: purchase.id, amountKobo: 15_000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await db.all('SELECT * FROM supplier_payments')).toHaveLength(0);
  });
});

describe('expenses', () => {
  async function expenseCategories() {
    const res = await auth(owner, ownerSession).get('/api/expense-categories');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.categories as Array<{ id: string; code: string; name: string }>;
  }

  it('seeds operating categories and records, edits drafts, posts and reverses with an audit trail', async () => {
    const categories = await expenseCategories();
    expect(categories).toHaveLength(12);
    expect(categories.map((category) => category.code)).toContain('rent');
    expect(categories.map((category) => category.code)).toContain('staff_salaries');
    const rent = categories.find((category) => category.code === 'rent')!;
    const transport = categories.find((category) => category.code === 'transportation')!;

    const operationId = randomUUID();
    const created = await auth(owner, ownerSession).post('/api/expenses', {
      operationId,
      categoryId: rent.id,
      description: 'November shop rent',
      amountKobo: 500_000,
      paymentMethod: 'bank_transfer',
      expenseDate: today(),
      payee: 'Marina Plaza Ltd',
      reference: 'RENT-NOV',
      status: 'draft',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.expenseNumber).toMatch(/^EXP-\d{8}-\d{4}$/);
    expect(created.body.status).toBe('draft');
    expect(created.body.categoryName).toBe('Rent');

    const replay = await auth(owner, ownerSession).post('/api/expenses', {
      operationId,
      categoryId: rent.id,
      description: 'November shop rent',
      amountKobo: 500_000,
      paymentMethod: 'bank_transfer',
      expenseDate: today(),
      payee: 'Marina Plaza Ltd',
      reference: 'RENT-NOV',
      status: 'draft',
    });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created.body.id);
    expect(await db.all('SELECT * FROM expenses')).toHaveLength(1);

    const edited = await auth(owner, ownerSession).put(`/api/expenses/${created.body.id}`, {
      version: created.body.version,
      categoryId: transport.id,
      description: 'November shop rent and transport',
      amountKobo: 520_000,
      paymentMethod: 'bank_transfer',
      expenseDate: today(),
      payee: 'Marina Plaza Ltd',
      reference: 'RENT-NOV',
      notes: 'Includes transport',
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.amountKobo).toBe(520_000);
    expect(edited.body.categoryName).toBe('Transportation');

    const auditRows = await auth(owner, ownerSession).get('/api/audit-logs?limit=100');
    const actions = auditRows.body.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('expense.updated');
    const updateAudit = auditRows.body.entries.find(
      (entry: { action: string }) => entry.action === 'expense.updated',
    );
    expect(JSON.parse(updateAudit.metadata_json).previousAmountKobo).toBe(500_000);
    expect(JSON.parse(updateAudit.metadata_json).amountKobo).toBe(520_000);

    const posted = await auth(owner, ownerSession).post(
      `/api/expenses/${created.body.id}/record`,
      {},
    );
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.status).toBe('recorded');
    expect(posted.body.recordedAt).toBeTruthy();

    const editRecorded = await auth(owner, ownerSession).put(`/api/expenses/${created.body.id}`, {
      version: posted.body.version,
      categoryId: transport.id,
      description: 'Changed after posting',
      amountKobo: 1_000,
      paymentMethod: 'cash',
      expenseDate: today(),
    });
    expect(editRecorded.status).toBe(409);
    expect(editRecorded.body.error.code).toBe('EXPENSE_NOT_DRAFT');

    const reversed = await auth(owner, ownerSession).post(
      `/api/expenses/${created.body.id}/reverse`,
      { operationId: randomUUID(), reason: 'Rent was cancelled by the landlord' },
    );
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    expect(reversed.body.status).toBe('reversed');
    expect(reversed.body.reversalReason).toBe('Rent was cancelled by the landlord');
    expect(await db.all('SELECT * FROM expense_reversals')).toHaveLength(1);
    expect(await db.all('SELECT * FROM expenses')).toHaveLength(1);

    const twice = await auth(owner, ownerSession).post(`/api/expenses/${created.body.id}/reverse`, {
      operationId: randomUUID(),
      reason: 'Again',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('EXPENSE_ALREADY_REVERSED');

    const listed = await auth(owner, ownerSession).get(
      `/api/expenses?search=rent&status=reversed&categoryId=${transport.id}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].status).toBe('reversed');

    const report = (
      await auth(owner, ownerSession).get(`/api/reports/finance?from=${today()}&to=${today()}`)
    ).body as FinancialReport;
    expect(report.expenses.recordedGrossKobo).toBe(520_000);
    expect(report.expenses.reversedKobo).toBe(520_000);
    expect(report.expenses.netKobo).toBe(0);
  });

  it('stores an optional receipt attachment and rejects unsupported or oversized documents', async () => {
    const categories = await expenseCategories();
    const rent = categories[0]!;
    const created = await auth(owner, ownerSession).post('/api/expenses', {
      operationId: randomUUID(),
      categoryId: rent.id,
      description: 'Cleaning supplies with receipt',
      amountKobo: 12_500,
      paymentMethod: 'cash',
      expenseDate: today(),
      attachment: {
        name: 'receipt.png',
        mime: 'image/png',
        dataBase64: Buffer.from('not-a-real-image-but-valid-base64').toString('base64'),
      },
      status: 'recorded',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.hasAttachment).toBe(true);
    expect(created.body.attachmentName).toBe('receipt.png');
    const detail = await auth(owner, ownerSession).get(`/api/expenses/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.attachment.mime).toBe('image/png');
    expect(detail.body.attachment.dataBase64).toBeTruthy();

    const rejected = await auth(owner, ownerSession).post('/api/expenses', {
      operationId: randomUUID(),
      categoryId: rent.id,
      description: 'Executable attachment',
      amountKobo: 1_000,
      paymentMethod: 'cash',
      expenseDate: today(),
      attachment: {
        name: 'malware.exe',
        mime: 'application/x-msdownload',
        dataBase64: 'AAAA',
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('financial reports and permissions', () => {
  async function buildDataset() {
    const supplier = await createSupplier();
    const medicine = await createMedicine({ sellingPriceKobo: 1_000, purchaseCostKobo: 400 });
    const pack = await unit('pack');
    const tablet = await unit('tablet');
    const purchase = await createPurchase(supplier.id, [
      { productId: medicine.id, unitId: pack, quantity: 10, unitCostKobo: 4_000 },
    ]);
    const received = await receive(purchase.id, [
      {
        purchaseOrderItemId: purchase.items[0]!.id,
        quantityReceived: 10,
        unitCostKobo: 4_000,
        batchNumber: 'REPORT-BATCH',
        manufacturingDate: past(20),
        expiryDate: future(500),
      },
    ]);
    expect(received.status, JSON.stringify(received.body)).toBe(201);

    const saleOne = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: medicine.id, unitId: tablet, quantity: 5, lineDiscountKobo: 0 }],
      cartDiscountKobo: 0,
      payments: [{ method: 'cash', amountKobo: 5_000 }],
    });
    expect(saleOne.status, JSON.stringify(saleOne.body)).toBe(201);
    const saleTwo = await auth(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      items: [{ productId: medicine.id, unitId: tablet, quantity: 3, lineDiscountKobo: 500 }],
      cartDiscountKobo: 0,
      discountReason: 'Loyal customer discount',
      payments: [{ method: 'cash', amountKobo: 2_500 }],
    });
    expect(saleTwo.status, JSON.stringify(saleTwo.body)).toBe(201);
    const saleDetail = await auth(owner, ownerSession).get(`/api/sales/${saleOne.body.id}`);
    expect(saleDetail.status).toBe(200);
    const refund = await auth(owner, ownerSession).post(`/api/sales/${saleOne.body.id}/refund`, {
      operationId: randomUUID(),
      reason: 'Customer returned one tablet',
      restockItems: true,
      refundMethod: 'cash',
      items: [{ saleItemId: saleDetail.body.items[0].id, quantity: 1 }],
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(200);

    const categories = (await auth(owner, ownerSession).get('/api/expense-categories')).body
      .categories as Array<{ id: string; code: string }>;
    const rent = categories.find((category) => category.code === 'rent')!;
    const expense = await auth(owner, ownerSession).post('/api/expenses', {
      operationId: randomUUID(),
      categoryId: rent.id,
      description: 'Monthly shop rent',
      amountKobo: 10_000,
      paymentMethod: 'cash',
      expenseDate: today(),
      status: 'recorded',
    });
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);
    const draftExpense = await auth(owner, ownerSession).post('/api/expenses', {
      operationId: randomUUID(),
      categoryId: rent.id,
      description: 'Unposted draft rent',
      amountKobo: 99_000,
      paymentMethod: 'cash',
      expenseDate: today(),
      status: 'draft',
    });
    expect(draftExpense.status).toBe(201);

    const payment = await auth(owner, ownerSession).post('/api/supplier-payments', {
      operationId: randomUUID(),
      supplierId: supplier.id,
      amountKobo: 20_000,
      method: 'bank_transfer',
      paidAt: today(),
      reference: 'REPORT-BANK-1',
      allocations: [{ purchaseOrderId: purchase.id, amountKobo: 20_000 }],
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);

    return { supplier, medicine, purchase };
  }

  it('calculates sales, collections, purchases, expenses, inventory, COGS and operating profit separately', async () => {
    await buildDataset();
    const res = await auth(owner, ownerSession).get(
      `/api/reports/finance?from=${today()}&to=${today()}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body as FinancialReport;

    expect(report.sales.grossSalesKobo).toBe(8_000);
    expect(report.sales.discountsKobo).toBe(500);
    expect(report.sales.refundsKobo).toBe(1_000);
    expect(report.sales.netSalesRevenueKobo).toBe(6_500);
    expect(report.sales.transactionsCount).toBe(2);
    expect(report.sales.refundCount).toBe(1);
    expect(report.sales.costOfGoodsSoldKobo).toBe(2_800);

    // Collections are actual money received, net of refunds. No credit was issued.
    expect(report.collections.cashKobo).toBe(6_500);
    expect(report.collections.bankTransferKobo).toBe(0);
    expect(report.collections.posKobo).toBe(0);
    expect(report.collections.totalReceivedKobo).toBe(6_500);
    expect(report.collections.salesPaymentsKobo).toBe(6_500);
    expect(report.collections.refundsPaidKobo).toBe(1_000);

    // Purchases remain separate from cash paid and from sales.
    expect(report.purchases.totalOrderedKobo).toBe(40_000);
    expect(report.purchases.goodsReceivedKobo).toBe(40_000);
    expect(report.purchases.paidToSuppliersKobo).toBe(20_000);
    expect(report.purchases.outstandingSupplierBalanceKobo).toBe(20_000);
    expect(report.purchases.outstandingInvoiceCount).toBe(1);

    // Only the recorded expense counts; the draft does not.
    expect(report.expenses.recordedGrossKobo).toBe(10_000);
    expect(report.expenses.netKobo).toBe(10_000);
    expect(report.expenses.expenseCount).toBe(1);
    expect(report.expenses.byCategory[0]!.categoryCode).toBe('rent');
    expect(report.expenses.byCategory[0]!.amountKobo).toBe(10_000);

    expect(report.inventory.stockUnits).toBe(93);
    expect(report.inventory.stockValueCostKobo).toBe(37_200);
    expect(report.inventory.stockValueRetailKobo).toBe(93_000);

    expect(report.profitability.netSalesRevenueKobo).toBe(6_500);
    expect(report.profitability.costOfGoodsSoldKobo).toBe(2_800);
    expect(report.profitability.grossProfitKobo).toBe(3_700);
    expect(report.profitability.operatingExpensesKobo).toBe(10_000);
    expect(report.profitability.operatingProfitKobo).toBe(-6_300);

    expect(report.topProducts[0]!.productId).toBeTruthy();
    expect(report.cogsRows[0]!.baseQuantitySold).toBe(7);
    expect(report.cogsRows[0]!.cogsKobo).toBe(2_800);

    // Cash movement distinguishes actual cash from bank transfers and never counts credit.
    expect(report.cashMovement.byMethod.find((row) => row.method === 'cash')!.netKobo).toBe(-3_500);
    expect(
      report.cashMovement.byMethod.find((row) => row.method === 'bank_transfer')!.netKobo,
    ).toBe(-20_000);
    expect(report.cashMovement.netKobo).toBe(-23_500);
    expect(report.cashMovement.cashNetKobo).toBe(-3_500);
    expect(report.cashMovement.rows.filter((row) => row.type === 'supplier_payment')).toHaveLength(
      1,
    );
    expect(report.cashMovement.rows.filter((row) => row.type === 'expense')).toHaveLength(1);

    const dashboard = await auth(owner, ownerSession).get(
      `/api/finance/dashboard?from=${today()}&to=${today()}`,
    );
    expect(dashboard.status).toBe(200);
    const summary = dashboard.body as FinancialDashboardSummary;
    expect(summary.profitability.operatingProfitKobo).toBe(-6_300);
    expect(summary.collections.totalReceivedKobo).toBe(6_500);
  });

  it('filters reports by date range and returns daily, weekly and monthly trends', async () => {
    await buildDataset();
    const yesterday = past(1);
    const empty = (
      await auth(owner, ownerSession).get(`/api/reports/finance?from=${yesterday}&to=${yesterday}`)
    ).body as FinancialReport;
    expect(empty.sales.netSalesRevenueKobo).toBe(0);
    expect(empty.expenses.netKobo).toBe(0);
    expect(empty.purchases.goodsReceivedKobo).toBe(0);
    expect(empty.expenseRows).toHaveLength(0);
    // Inventory is a live balance, not a period movement.
    expect(empty.inventory.stockValueCostKobo).toBe(37_200);

    const monthly = (
      await auth(owner, ownerSession).get(
        `/api/reports/finance?from=${today()}&to=${today()}&period=monthly`,
      )
    ).body as FinancialReport;
    expect(monthly.period).toBe('monthly');
    expect(monthly.salesTrend).toHaveLength(1);
    expect(monthly.salesTrend[0]!.netSalesRevenueKobo).toBe(6_500);

    const weekly = (
      await auth(owner, ownerSession).get(
        `/api/reports/finance?from=${today()}&to=${today()}&period=weekly`,
      )
    ).body as FinancialReport;
    expect(weekly.salesTrend).toHaveLength(1);
    expect(weekly.salesTrend[0]!.label).toMatch(/^Week of /);

    const invalid = await auth(owner, ownerSession).get(
      `/api/reports/finance?from=${today()}&to=${yesterday}`,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('exports CSV only with reports.export and keeps the financial data permission-separated', async () => {
    await buildDataset();
    const exportRes = await auth(owner, ownerSession).get(
      `/api/reports/finance/export?report=cash_movement&from=${today()}&to=${today()}`,
    );
    expect(exportRes.status, JSON.stringify(exportRes.body)).toBe(200);
    const exported = exportRes.body as FinancialExport;
    expect(exported.filename).toContain(today());
    expect(exported.contentType).toContain('text/csv');
    expect(exported.csv.split('\r\n')[0]).toContain('signed_amount_kobo');
    expect(exported.rowCount).toBe(5);

    const categoryExport = await auth(owner, ownerSession).get(
      `/api/reports/finance/export?report=expense_categories&from=${today()}&to=${today()}`,
    );
    expect(categoryExport.status).toBe(200);
    expect(categoryExport.body.csv).toContain('Rent');

    const cashier = await createStaff('cashier');
    const cashierExport = await auth(cashier.agent, cashier.session).get(
      `/api/reports/finance/export?report=sales&from=${today()}&to=${today()}`,
    );
    expect(cashierExport.status).toBe(403);
    expect(cashierExport.body.error.code).toBe('PERMISSION_DENIED');

    const cashierReport = await auth(cashier.agent, cashier.session).get('/api/reports/finance');
    expect(cashierReport.status).toBe(403);
    const cashierPurchases = await auth(cashier.agent, cashier.session).get('/api/purchases');
    expect(cashierPurchases.status).toBe(403);
    const cashierExpenses = await auth(cashier.agent, cashier.session).get('/api/expenses');
    expect(cashierExpenses.status).toBe(403);

    // Cashiers can see their own sales-side cash movement, never supplier or expense flows.
    const register = await auth(cashier.agent, cashier.session).get(
      `/api/cash-register?from=${today()}&to=${today()}`,
    );
    expect(register.status, JSON.stringify(register.body)).toBe(200);
    expect(
      register.body.rows.every((row: { type: string }) =>
        ['sale_payment', 'sale_refund', 'debt_repayment'].includes(row.type),
      ),
    ).toBe(true);
    expect(
      register.body.rows.some((row: { type: string }) => row.type === 'supplier_payment'),
    ).toBe(false);
    expect(register.body.note).toContain('Unpaid credit sales are not cash');

    const storekeeper = await createStaff('storekeeper');
    const storekeeperPayment = await auth(storekeeper.agent, storekeeper.session).post(
      '/api/supplier-payments',
      {
        operationId: randomUUID(),
        supplierId: randomUUID(),
        amountKobo: 100,
        method: 'cash',
        paidAt: today(),
        allocations: [{ purchaseOrderId: randomUUID(), amountKobo: 100 }],
      },
    );
    expect(storekeeperPayment.status).toBe(403);
    expect(storekeeperPayment.body.error.code).toBe('PERMISSION_DENIED');
    const storekeeperAccount = await auth(storekeeper.agent, storekeeper.session).get(
      `/api/supplier-balances`,
    );
    expect(storekeeperAccount.status).toBe(403);
    const storekeeperExpense = await auth(storekeeper.agent, storekeeper.session).post(
      '/api/expenses',
      {
        operationId: randomUUID(),
        categoryId: randomUUID(),
        description: 'Not allowed',
        amountKobo: 100,
        paymentMethod: 'cash',
        expenseDate: today(),
      },
    );
    expect(storekeeperExpense.status).toBe(403);
  });

  it('enforces storekeeper purchasing execution without granting money permissions', async () => {
    const supplier = await createSupplier();
    const medicine = await createMedicine();
    const pack = await unit('pack');
    const storekeeper = await createStaff('storekeeper');
    const draft = await auth(storekeeper.agent, storekeeper.session).post('/api/purchases', {
      operationId: randomUUID(),
      supplierId: supplier.id,
      status: 'draft',
      items: [{ productId: medicine.id, unitId: pack, quantity: 1, unitCostKobo: 40_000 }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const ordered = await auth(storekeeper.agent, storekeeper.session).post(
      `/api/purchases/${draft.body.id}/order`,
      {},
    );
    expect(ordered.status).toBe(200);
    const received = await receive(
      draft.body.id,
      [
        {
          purchaseOrderItemId: draft.body.items[0].id,
          quantityReceived: 1,
          unitCostKobo: 40_000,
          batchNumber: 'STORE-BATCH',
          expiryDate: future(300),
        },
      ],
      {},
      storekeeper.session,
      storekeeper.agent,
    );
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    expect(await stockQuantity(medicine.id)).toBe(10);

    const cancel = await auth(storekeeper.agent, storekeeper.session).post(
      `/api/purchases/${draft.body.id}/cancel`,
      { reason: 'Cannot cancel without permission' },
    );
    expect(cancel.status).toBe(403);
    expect(cancel.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('audits sensitive financial actions with correlation but without credentials', async () => {
    await buildDataset();
    const exported = await auth(owner, ownerSession).get(
      `/api/reports/finance/export?report=expenses&from=${today()}&to=${today()}`,
    );
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const auditRes = await auth(owner, ownerSession).get('/api/audit-logs?limit=100');
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('purchase.created');
    expect(actions).toContain('goods_receipt.created');
    expect(actions).toContain('supplier_payment.recorded');
    expect(actions).toContain('expense.recorded');
    expect(actions).toContain('report.exported');
    const serialized = JSON.stringify(auditRes.body.entries);
    expect(serialized).not.toContain(ownerBody.password);
    expect(serialized).not.toContain('csrfToken');
  });
});
