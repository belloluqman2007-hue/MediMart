import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  canonicalJson,
  sha256,
  type OfflineEnvelope,
  type SessionResponse,
} from '@medimart/shared';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';

/**
 * Phase 6 offline capture and synchronization tests.
 *
 * These exercise the real HTTP surface and the real SQLite schema. "Offline" is simulated by
 * capturing envelopes on the device model without the server, then pushing a batch — the same code
 * path a phone uses when it reconnects.
 */
const dir = mkdtempSync(join(tmpdir(), 'medimart-sync-'));
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: join(dir, 'central.sqlite'),
  bootstrapToken: 'd'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  backupDir: join(dir, 'backups'),
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
};
const origin = 'https://trusted.medimart.test';

type Agent = ReturnType<typeof request.agent>;
let db: Database;
let app: ReturnType<typeof createApp>;
let owner: Agent;
let ownerSession: SessionResponse;

const ownerCredentials = {
  fullName: 'Sync Test Owner',
  email: 'sync-owner@medimart.test',
  password: 'A long private sync owner passphrase',
  bootstrapToken: config.bootstrapToken,
};

function cookies(agent: Agent, session: SessionResponse) {
  return {
    get: (path: string) => agent.get(path),
    post: (path: string, body: object = {}) =>
      agent.post(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send(body),
    put: (path: string, body: object) =>
      agent.put(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send(body),
  };
}

async function unitId(code: string) {
  return (await db.all<{ id: string }>('SELECT id FROM units WHERE code = ?', [code]))[0]!.id;
}

async function categoryId(name: string) {
  return (
    await db.all<{ id: string }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [name])
  )[0]!.id;
}

async function createProduct(overrides: Record<string, unknown> = {}) {
  const res = await cookies(owner, ownerSession).post('/api/products', {
    name: 'Paracetamol 500mg',
    genericName: 'Paracetamol',
    sku: `SYNC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    barcode: `777${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    productType: 'medicine',
    categoryId: await categoryId('Analgesics'),
    purchaseCostKobo: 2_000,
    sellingPriceKobo: 5_000,
    reorderLevel: 10,
    baseUnitId: await unitId('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; baseUnitId: string; sellingPriceKobo: number };
}

async function receive(productId: string, quantity: number, costKobo = 2_000) {
  const res = await cookies(owner, ownerSession).post('/api/stock/receive', {
    operationId: randomUUID(),
    productId,
    unitId: await unitId('tablet'),
    quantity,
    unitCostKobo: costKobo,
    reason: 'Supplier delivery',
    batchNumber: `B-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    expiryDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
    movementType: 'stock_received',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/**
 * Enrol a device exactly as the Android app does: generate an installation secret, register it,
 * have an owner approve the pairing code, then sign in to obtain a device-bound bearer session.
 */
async function enrolDevice(name: string) {
  const deviceId = randomUUID();
  const secret = Array.from(
    { length: 64 },
    () => 'abcdef0123456789'[Math.floor(Math.random() * 16)],
  ).join('');
  const registration = await request(app)
    .post('/api/devices/register')
    .set('Origin', origin)
    .send({ id: deviceId, name, platform: 'android', secret });
  expect(registration.status, JSON.stringify(registration.body)).toBe(201);
  const pairingCode = registration.body.pairingCode as string;
  const approval = await cookies(owner, ownerSession).post(`/api/devices/${deviceId}/approve`, {
    pairingCode,
  });
  expect(approval.status, JSON.stringify(approval.body)).toBe(204);
  const login = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({
      email: ownerCredentials.email,
      password: ownerCredentials.password,
      device: { id: deviceId, secret },
    });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const token = login.body.token as string;
  return {
    deviceId,
    secret,
    token,
    push: (path: string, body: object) =>
      request(app)
        .post(path)
        .set('Origin', origin)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    get: (path: string) =>
      request(app).get(path).set('Origin', origin).set('Authorization', `Bearer ${token}`),
  };
}

type Device = Awaited<ReturnType<typeof enrolDevice>>;

/** Build a signed envelope in the same shape the Android outbox stores. */
async function envelope(
  device: Device,
  record: OfflineEnvelope['record'],
  overrides: Partial<OfflineEnvelope> = {},
): Promise<OfflineEnvelope> {
  const base: Omit<OfflineEnvelope, 'fingerprint'> = {
    schemaVersion: 1,
    operationId: randomUUID(),
    deviceId: device.deviceId,
    clientCreatedAt: new Date().toISOString(),
    clientDate: new Date().toISOString().slice(0, 10),
    capturedByUserId: (
      await db.all<{ id: string }>('SELECT id FROM users WHERE email = ?', [ownerCredentials.email])
    )[0]!.id,
    record,
    ...overrides,
  };
  return { ...base, fingerprint: await sha256(canonicalJson(base)) };
}

function saleRecord(
  items: Array<{ productId: string; unitId: string; quantity: number; lineDiscountKobo?: number }>,
  extra: Partial<Extract<OfflineEnvelope['record'], { recordType: 'sale' }>['payload']> = {},
): OfflineEnvelope['record'] {
  return {
    recordType: 'sale',
    requiresOnlineReview: false,
    payload: {
      customerId: null,
      customerDraft: null,
      items: items.map((item) => ({ lineDiscountKobo: 0, ...item })),
      cartDiscountKobo: 0,
      discountReason: null,
      payments: [],
      dueDate: null,
      notes: null,
      ...extra,
    },
  };
}

/** Attach a full cash payment so the record is a paid sale, not a credit sale. */
function paidSale(
  record: OfflineEnvelope['record'],
  amountKobo: number,
): OfflineEnvelope['record'] {
  if (record.recordType !== 'sale') return record;
  return {
    ...record,
    payload: {
      ...record.payload,
      payments: [{ method: 'cash', amountKobo, reference: null }],
    },
  };
}

beforeEach(async () => {
  db = openNodeDatabase(config.databasePath);
  await migrate(db, migrations);
  app = createApp(db, config);
  owner = request.agent(app);
  const res = await owner
    .post('/api/auth/register-owner')
    .set('Origin', origin)
    .send(ownerCredentials);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  ownerSession = res.body;
});

afterEach(async () => {
  await db.close();
  rmSync(config.databasePath, { force: true });
  rmSync(`${config.databasePath}-wal`, { force: true });
  rmSync(`${config.databasePath}-shm`, { force: true });
});

describe('Phase 6: offline capture and synchronization', () => {
  it('applies an offline sale once, replays it without duplicating stock or cash, and audits it', async () => {
    const product = await createProduct();
    await receive(product.id, 40);
    const device = await enrolDevice('Counter phone A');
    const record = saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 3 }]);
    const payload = await envelope(device, record, {
      record: {
        ...record,
        payload: {
          ...record.payload,
          payments: [{ method: 'cash', amountKobo: product.sellingPriceKobo * 3, reference: null }],
        },
      } as OfflineEnvelope['record'],
    });

    const push = await device.push('/api/sync/push', { envelopes: [payload] });
    expect(push.status, JSON.stringify(push.body)).toBe(200);
    expect(push.body.accepted).toHaveLength(1);
    expect(push.body.accepted[0].outcome).toBe('applied');
    expect(push.body.rejected).toHaveLength(0);

    const stock = (
      await db.all<{ quantity: number }>(
        'SELECT quantity FROM stock_balances WHERE product_id = ?',
        [product.id],
      )
    )[0]!;
    expect(stock.quantity).toBe(37);
    const sales = await db.all('SELECT id FROM sales');
    expect(sales).toHaveLength(1);

    // Exact replay after a dropped response must not double-apply.
    const replay = await device.push('/api/sync/push', { envelopes: [payload] });
    expect(replay.status).toBe(200);
    expect(replay.body.accepted[0].outcome).toBe('duplicate');
    expect(await db.all('SELECT id FROM sales')).toHaveLength(1);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id = ?',
          [product.id],
        )
      )[0]!.quantity,
    ).toBe(37);

    const auditRows = await db.all<{ action: string }>('SELECT action FROM audit_logs');
    expect(auditRows.map((row) => row.action)).toContain('sync.record_applied');
    expect(
      (await db.all<{ status: string }>('SELECT status FROM offline_records'))[0]!.status,
    ).toBe('applied');
  });

  it('rejects a tampered envelope and a record whose device clock is far ahead', async () => {
    const device = await enrolDevice('Counter phone B');
    const product = await createProduct();
    await receive(product.id, 10);
    const good = await envelope(
      device,
      saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 1 }]),
    );
    const tampered = {
      ...good,
      operationId: randomUUID(),
      record: saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 9 }]),
    } as OfflineEnvelope;
    const ahead = await envelope(
      device,
      saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 1 }]),
      { clientCreatedAt: new Date(Date.now() + 10 * 86_400_000).toISOString() },
    );

    const result = await device.push('/api/sync/push', { envelopes: [tampered, ahead] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.accepted).toHaveLength(0);
    expect(result.body.rejected.map((r: { code: string }) => r.code)).toEqual([
      'FINGERPRINT_MISMATCH',
      'DEVICE_CLOCK_AHEAD',
    ]);
    expect(await db.all('SELECT id FROM sales')).toHaveLength(0);
  });

  it('rejects an offline sale that exceeds stock without partially applying it', async () => {
    const product = await createProduct();
    await receive(product.id, 2);
    const device = await enrolDevice('Counter phone C');
    const payload = await envelope(
      device,
      saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 5 }]),
    );
    const result = await device.push('/api/sync/push', { envelopes: [payload] });
    expect(result.status).toBe(200);
    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0].code).toBe('INSUFFICIENT_STOCK');
    const stock = (
      await db.all<{ quantity: number }>(
        'SELECT quantity FROM stock_balances WHERE product_id = ?',
        [product.id],
      )
    )[0]!;
    expect(stock.quantity).toBe(2);
    expect(await db.all('SELECT id FROM sales')).toHaveLength(0);
    expect(
      (await db.all<{ status: string }>('SELECT status FROM offline_records'))[0]!.status,
    ).toBe('rejected');
  });

  it('binds synchronization to an approved device and refuses revoked devices immediately', async () => {
    const device = await enrolDevice('Counter phone D');
    const product = await createProduct();
    await receive(product.id, 10);
    const payload = await envelope(
      device,
      saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 1 }]),
    );

    // A revoked device's session stops working on the next request, including synchronization.
    const revoke = await cookies(owner, ownerSession).post(
      `/api/devices/${device.deviceId}/revoke`,
      {},
    );
    expect(revoke.status).toBe(204);
    const attempt = await device.push('/api/sync/push', { envelopes: [payload] });
    expect(attempt.status).toBe(401);
    expect(await db.all('SELECT id FROM sales')).toHaveLength(0);

    // A browser session must not be able to push business records as if it were a device.
    const browserPush = await cookies(owner, ownerSession).post('/api/sync/push', {
      envelopes: [payload],
    });
    expect(browserPush.status).toBe(403);
    expect(browserPush.body.error.code).toBe('DEVICE_REQUIRED');
  });

  it('rejects a batch that claims records for a different installation', async () => {
    const device = await enrolDevice('Counter phone E');
    const other = await enrolDevice('Counter phone F');
    const product = await createProduct();
    await receive(product.id, 5);
    const foreign = await envelope(
      device,
      saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 1 }]),
    );
    const mixed = { ...foreign, deviceId: other.deviceId };
    const result = await device.push('/api/sync/push', { envelopes: [mixed] });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('DEVICE_MISMATCH');
  });

  it('applies offline customers, debt repayments, stock receipts, purchase orders and expenses', async () => {
    const device = await enrolDevice('Back office phone');
    const product = await createProduct();

    // 1. Customer captured offline.
    const customerEnvelope = await envelope(device, {
      recordType: 'customer',
      requiresOnlineReview: false,
      payload: {
        customer: {
          localId: randomUUID(),
          fullName: 'Offline Customer One',
          phone: '08030000001',
          address: '14 Market Road',
          creditLimitKobo: 500_000,
        },
      },
    });
    // 2. Stock receipt captured offline.
    const receiptEnvelope = await envelope(device, {
      recordType: 'stock_receipt',
      requiresOnlineReview: false,
      payload: {
        receipt: {
          productId: product.id,
          quantity: 25,
          unitId: product.baseUnitId,
          batchNumber: 'OFFLINE-1',
          expiryDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
          manufacturingDate: null,
          unitCostKobo: 2_100,
          supplierId: null,
          reason: 'Received while the server was unreachable',
        },
      },
    });
    // 3. Purchase order captured offline.
    const supplierRes = await cookies(owner, ownerSession).post('/api/suppliers', {
      name: 'Offline Wholesale Ltd',
      contactPerson: 'Ada Buyer',
      phone: '08031234567',
      email: 'wholesale@example.test',
      address: '1 Depot Road',
    });
    expect(supplierRes.status, JSON.stringify(supplierRes.body)).toBe(201);
    const supplierId = supplierRes.body.id as string;
    const purchaseEnvelope = await envelope(device, {
      recordType: 'purchase_order',
      requiresOnlineReview: false,
      payload: {
        order: {
          supplierId,
          items: [
            {
              productId: product.id,
              unitId: product.baseUnitId,
              quantity: 100,
              unitCostKobo: 2_000,
              lineDiscountKobo: 0,
            },
          ],
          orderDiscountKobo: 0,
          discountReason: null,
          additionalChargesKobo: 0,
          additionalChargesReason: null,
          expectedDeliveryDate: null,
          notes: 'Captured offline',
        },
      },
    });
    // 4. Expense captured offline.
    const category = (
      await db.all<{ id: string }>('SELECT id FROM expense_categories ORDER BY sort_order LIMIT 1')
    )[0]!;
    const expenseEnvelope = await envelope(device, {
      recordType: 'expense',
      requiresOnlineReview: false,
      payload: {
        expense: {
          categoryId: category.id,
          description: 'Generator fuel during outage',
          amountKobo: 85_000,
          paymentMethod: 'cash',
          expenseDate: new Date().toISOString().slice(0, 10),
          payee: 'Total Filling Station',
          reference: null,
          notes: null,
        },
      },
    });

    const result = await device.push('/api/sync/push', {
      envelopes: [customerEnvelope, receiptEnvelope, purchaseEnvelope, expenseEnvelope],
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.rejected, JSON.stringify(result.body.rejected)).toHaveLength(0);
    expect(result.body.accepted).toHaveLength(4);

    expect(await db.all('SELECT id FROM customers')).toHaveLength(1);
    expect(await db.all('SELECT id FROM purchase_orders')).toHaveLength(1);
    expect(await db.all('SELECT id FROM expenses')).toHaveLength(1);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id = ?',
          [product.id],
        )
      )[0]!.quantity,
    ).toBe(25);

    // Now a debt repayment against the customer captured moments ago (credit sale first).
    const sale = await cookies(owner, ownerSession).post('/api/sales', {
      operationId: randomUUID(),
      customerId: (await db.all<{ id: string }>('SELECT id FROM customers'))[0]!.id,
      items: [
        { productId: product.id, unitId: product.baseUnitId, quantity: 4, lineDiscountKobo: 0 },
      ],
      cartDiscountKobo: 0,
      payments: [],
      notes: null,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const customerId = sale.body.customerId as string;
    const repayment = await envelope(device, {
      recordType: 'customer_repayment',
      requiresOnlineReview: false,
      payload: {
        customerId,
        amountKobo: 5_000,
        method: 'pos_terminal',
        reference: 'POS-REF-1',
        notes: 'Paid from the back office phone',
      },
    });
    const repaymentResult = await device.push('/api/sync/push', { envelopes: [repayment] });
    expect(repaymentResult.status, JSON.stringify(repaymentResult.body)).toBe(200);
    expect(
      repaymentResult.body.rejected,
      JSON.stringify(repaymentResult.body.rejected),
    ).toHaveLength(0);
    expect(await db.all('SELECT id FROM debt_payments')).toHaveLength(1);
  });

  it('refuses an offline discount from an account without sales.discount', async () => {
    const product = await createProduct();
    await receive(product.id, 20);
    // A cashier is created and paired as its own device so the permission check is real.
    const cashierAgent = request.agent(app);
    const created = await cookies(owner, ownerSession).post('/api/staff', {
      fullName: 'Sync Cashier',
      email: 'sync-cashier@medimart.test',
      password: 'A long private cashier passphrase',
      // Cashiers may synchronize their own parked offline records; sales.discount is still absent.
      roles: ['cashier'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const login = await cashierAgent.post('/api/auth/login').set('Origin', origin).send({
      email: 'sync-cashier@medimart.test',
      password: 'A long private cashier passphrase',
    });
    expect(login.status).toBe(200);
    const cashierSession = login.body as SessionResponse;

    const deviceId = randomUUID();
    const secret = 'ab'.repeat(32);
    await request(app)
      .post('/api/devices/register')
      .set('Origin', origin)
      .send({ id: deviceId, name: 'Cashier phone', platform: 'android', secret });
    const code = (
      await db.all<{ pairing_code_hash: string }>(
        'SELECT pairing_code_hash FROM devices WHERE id = ?',
        [deviceId],
      )
    )[0]!;
    expect(code.pairing_code_hash).toBeTruthy();
    // Approve via the real endpoint by reading the code from the registration response.
    const registration = await request(app)
      .post('/api/devices/register')
      .set('Origin', origin)
      .send({ id: deviceId, name: 'Cashier phone', platform: 'android', secret });
    const approval = await cookies(owner, ownerSession).post(`/api/devices/${deviceId}/approve`, {
      pairingCode: registration.body.pairingCode,
    });
    expect(approval.status).toBe(204);
    const deviceLogin = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({
        email: 'sync-cashier@medimart.test',
        password: 'A long private cashier passphrase',
        device: { id: deviceId, secret },
      });
    expect(deviceLogin.status, JSON.stringify(deviceLogin.body)).toBe(200);
    const token = deviceLogin.body.token as string;

    // Fully paid, so the only reason to refuse is the unauthorized discount.
    const record = paidSale(
      saleRecord(
        [{ productId: product.id, unitId: product.baseUnitId, quantity: 2, lineDiscountKobo: 500 }],
        { cartDiscountKobo: 0, discountReason: 'Loyal customer discount' },
      ),
      (10_000 - 500) * 1,
    );
    const base = {
      schemaVersion: 1 as const,
      operationId: randomUUID(),
      deviceId,
      clientCreatedAt: new Date().toISOString(),
      clientDate: new Date().toISOString().slice(0, 10),
      capturedByUserId: cashierSession.user.id,
      record,
    };
    const payload: OfflineEnvelope = { ...base, fingerprint: await sha256(canonicalJson(base)) };
    const result = await request(app)
      .post('/api/sync/push')
      .set('Origin', origin)
      .set('Authorization', `Bearer ${token}`)
      .send({ envelopes: [payload] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.rejected[0].code).toBe('DISCOUNT_NOT_AUTHORIZED_OFFLINE');
    expect(await db.all('SELECT id FROM sales')).toHaveLength(0);
  });

  it('reports synchronization status and a reviewable record list', async () => {
    const device = await enrolDevice('Status phone');
    const product = await createProduct();
    await receive(product.id, 10);
    const payload = await envelope(
      device,
      paidSale(
        saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity: 1 }]),
        product.sellingPriceKobo,
      ),
    );
    const pushed = await device.push('/api/sync/push', { envelopes: [payload] });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.accepted, JSON.stringify(pushed.body)).toHaveLength(1);

    const status = await device.get('/api/sync/status');
    expect(status.status).toBe(200);
    expect(status.body.implemented).toBe(true);
    expect(status.body.synced).toBe(1);
    expect(status.body.device.id).toBe(device.deviceId);

    const list = await cookies(owner, ownerSession).get('/api/sync/records');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].recordType).toBe('sale');
    expect(list.body.items[0].status).toBe('applied');

    const summary = await cookies(owner, ownerSession).get('/api/sync/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.syncedToday).toBe(1);
  });

  it('keeps the stock ledger and sales totals equal to the applied offline records', async () => {
    const product = await createProduct();
    await receive(product.id, 30);
    const device = await enrolDevice('Reconciliation phone');
    for (const quantity of [2, 3, 5]) {
      const record = saleRecord([{ productId: product.id, unitId: product.baseUnitId, quantity }]);
      const withPayment = paidSale(record, product.sellingPriceKobo * quantity);
      const result = await device.push('/api/sync/push', {
        envelopes: [await envelope(device, withPayment)],
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.accepted).toHaveLength(1);
    }
    const totalRevenue = (
      await db.all<{ total: number }>('SELECT COALESCE(SUM(total_kobo),0) AS total FROM sales')
    )[0]!.total;
    expect(Number(totalRevenue)).toBe(product.sellingPriceKobo * 10);
    const stock = (
      await db.all<{ quantity: number }>(
        'SELECT quantity FROM stock_balances WHERE product_id = ?',
        [product.id],
      )
    )[0]!.quantity;
    expect(Number(stock)).toBe(20);
    const movementSum = (
      await db.all<{ delta: number }>(
        'SELECT COALESCE(SUM(new_balance - previous_balance),0) AS delta FROM stock_movements WHERE product_id = ?',
        [product.id],
      )
    )[0]!.delta;
    expect(Number(movementSum)).toBe(20);
  });
});
