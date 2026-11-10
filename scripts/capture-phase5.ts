/**
 * Phase 5 screenshot capture. Runs against a disposable database and the built web app.
 * Usage: MEDIMART_SANDBOX_BROWSER=1 node --import=tsx scripts/capture-phase5.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { migrate } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';
import { sandboxBrowserOptions } from './browser-options';

const port = 4174;
const base = `http://127.0.0.1:${port}`;
const origin = base;
const databasePath = resolve('.artifacts/screenshots/server.sqlite');
const outputDir = resolve('docs/screenshots/phase5');
const owner = {
  fullName: 'Amina Bello',
  email: 'owner@medimart.demo',
  password: 'A secure phase five screenshot passphrase',
};
const bootstrapToken = 'phase-five-screenshot-token-00000000000000000000';

mkdirSync(resolve('.artifacts/screenshots'), { recursive: true });
mkdirSync(outputDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath + suffix, { force: true });

const db = openNodeDatabase(databasePath);
await migrate(db);
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port,
  databasePath,
  bootstrapToken,
  allowedOrigins: [origin, 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  backupDir: '.artifacts/backups',
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
  authRateLimit: 200,
};
const server = createApp(db, config, resolve('apps/web/dist')).listen(port, '0.0.0.0');
await new Promise<void>((resolveReady) => server.once('listening', () => resolveReady()));

let cookie = '';
let csrf = '';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const payload = (await response.json().catch(() => null)) as
    (T & { error?: { message: string } }) | null;
  if (!response.ok || payload === null)
    throw new Error(`${method} ${path} failed (${response.status}): ${payload?.error?.message}`);
  return payload;
}

const now = new Date();
const today = now.toISOString().slice(0, 10);
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const id = () => crypto.randomUUID();

async function seed() {
  const session = await api<{ csrfToken: string }>('/api/auth/register-owner', 'POST', {
    ...owner,
    bootstrapToken,
  });
  csrf = session.csrfToken;

  const categories = (
    await api<{ categories: Array<{ id: string; name: string }> }>('/api/categories')
  ).categories;
  const units = (
    await api<{ units: Array<{ id: string; name: string; code: string }> }>('/api/units')
  ).units;
  const category = (name: string) => categories.find((entry) => entry.name === name)!.id;
  const unit = (code: string) => units.find((entry) => entry.code === code)!.id;

  const supplier = await api<{ id: string; name: string }>('/api/suppliers', 'POST', {
    name: 'Emzor Pharmaceutical Distribution',
    contactPerson: 'Chinedu Eze',
    phone: '+234 801 234 5678',
    email: 'orders@emzor.example',
    address: '12 Marina Road, Lagos Island, Lagos',
    businessInfo: 'RC 1234567 · 30-day credit terms',
    notes: 'Primary medicine and drinks wholesaler.',
    status: 'active',
  });

  const medicine = await api<{ id: string; baseUnitId: string }>('/api/products', 'POST', {
    name: 'Amoxicillin 500mg Capsules',
    genericName: 'Amoxicillin',
    brand: 'Emzor',
    sku: 'AMOX-500',
    barcode: '8901234567890',
    productType: 'medicine',
    categoryId: category('Antibiotics'),
    manufacturer: 'Emzor Pharmaceutical',
    purchaseCostKobo: 400,
    sellingPriceKobo: 1_000,
    reorderLevel: 30,
    baseUnitId: unit('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: unit('pack'), factor: 10 }],
  });
  const water = await api<{ id: string }>('/api/products', 'POST', {
    name: 'Eva Bottled Water 75cl',
    brand: 'Eva',
    sku: 'EVA-75CL',
    barcode: '6151234567890',
    productType: 'drinks',
    categoryId: category('Drinks'),
    purchaseCostKobo: 15_000,
    sellingPriceKobo: 25_000,
    reorderLevel: 24,
    baseUnitId: unit('bottle'),
    isExpiryTracked: false,
    status: 'active',
    units: [{ unitId: unit('carton'), factor: 12 }],
  });

  const purchase = await api<{
    id: string;
    items: Array<{ id: string; productId: string }>;
  }>('/api/purchases', 'POST', {
    operationId: id(),
    supplierId: supplier.id,
    status: 'ordered',
    items: [
      { productId: medicine.id, unitId: unit('pack'), quantity: 5, unitCostKobo: 4_000 },
      { productId: water.id, unitId: unit('carton'), quantity: 4, unitCostKobo: 180_000 },
    ],
    orderDiscountKobo: 20_000,
    discountReason: 'Bulk wholesale agreement',
    additionalChargesKobo: 5_000,
    additionalChargesReason: 'Delivery to the shop',
    expectedDeliveryDate: future(3),
    notes: 'Split delivery accepted. Keep cold-chain items separate.',
  });
  const purchaseMedicine = purchase.items.find((item) => item.productId === medicine.id)!;
  const purchaseWater = purchase.items.find((item) => item.productId === water.id)!;

  await api(`/api/purchases/${purchase.id}/receipts`, 'POST', {
    operationId: id(),
    receivedDate: today,
    notes: 'First delivery: medicine complete, water short by two cartons.',
    items: [
      {
        purchaseOrderItemId: purchaseMedicine.id,
        quantityReceived: 5,
        unitCostKobo: 4_000,
        batchNumber: 'AMOX-2601',
        manufacturingDate: past(90),
        expiryDate: future(500),
      },
      {
        purchaseOrderItemId: purchaseWater.id,
        quantityReceived: 2,
        unitCostKobo: 180_000,
        batchNumber: 'EVA-2601',
        expiryDate: future(240),
      },
    ],
  });

  const secondPurchase = await api<{
    id: string;
    items: Array<{ id: string }>;
  }>('/api/purchases', 'POST', {
    operationId: id(),
    supplierId: supplier.id,
    status: 'ordered',
    items: [{ productId: medicine.id, unitId: unit('pack'), quantity: 4, unitCostKobo: 4_200 }],
    expectedDeliveryDate: future(5),
    notes: 'Second order awaiting the balance of the delivery.',
  });
  await api(`/api/purchases/${secondPurchase.id}/receipts`, 'POST', {
    operationId: id(),
    receivedDate: today,
    items: [
      {
        purchaseOrderItemId: secondPurchase.items[0]!.id,
        quantityReceived: 1,
        unitCostKobo: 4_200,
        batchNumber: 'AMOX-2602',
        expiryDate: future(300),
      },
    ],
  });

  await api('/api/supplier-payments', 'POST', {
    operationId: id(),
    supplierId: supplier.id,
    amountKobo: 300_000,
    method: 'bank_transfer',
    paidAt: today,
    reference: 'GTB-TRX-9001',
    notes: 'Part payment against the first invoice.',
    allocations: [{ purchaseOrderId: purchase.id, amountKobo: 300_000 }],
  });

  const expenseCategories = (
    await api<{ categories: Array<{ id: string; code: string }> }>('/api/expense-categories')
  ).categories;
  const rent = expenseCategories.find((entry) => entry.code === 'rent')!.id;
  const internet = expenseCategories.find((entry) => entry.code === 'internet_communication')!.id;
  const cleaning = expenseCategories.find((entry) => entry.code === 'cleaning_materials')!.id;

  await api('/api/expenses', 'POST', {
    operationId: id(),
    categoryId: rent,
    description: 'Monthly shop rent — November',
    amountKobo: 25_000_000,
    paymentMethod: 'bank_transfer',
    expenseDate: today,
    payee: 'Marina Plaza Facilities Ltd',
    reference: 'RENT-NOV-2026',
    notes: 'Paid by bank transfer. Receipt filed at the front desk.',
    status: 'recorded',
  });
  await api('/api/expenses', 'POST', {
    operationId: id(),
    categoryId: cleaning,
    description: 'Cleaning materials and disinfectant',
    amountKobo: 800_000,
    paymentMethod: 'cash',
    expenseDate: today,
    payee: 'Tolu Hygiene Supplies',
    status: 'recorded',
  });
  await api('/api/expenses', 'POST', {
    operationId: id(),
    categoryId: internet,
    description: 'Internet and phone top-up (awaiting invoice)',
    amountKobo: 2_500_000,
    paymentMethod: 'pos_terminal',
    expenseDate: today,
    payee: 'Spectranet',
    status: 'draft',
  });

  await api('/api/sales', 'POST', {
    operationId: id(),
    items: [{ productId: medicine.id, unitId: unit('tablet'), quantity: 12 }],
    cartDiscountKobo: 0,
    payments: [{ method: 'cash', amountKobo: 12_000 }],
  });

  return { supplier, purchase, secondPurchase };
}

async function capture(browser: Browser, data: Awaited<ReturnType<typeof seed>>) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/#/login`);
  await page.getByLabel('Email address', { exact: true }).fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Sign in to MediMart' }).click();
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  const dismiss = page.getByLabel('Dismiss notification');
  if (await dismiss.count()) await dismiss.click().catch(() => undefined);
  await page.waitForTimeout(250);

  const shot = async (name: string, path: string, fullPage = false) => {
    await page.goto(`${base}/#${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outputDir, name), fullPage });
  };

  await shot('01-purchases.png', '/purchases');
  await shot('02-purchase-detail.png', `/purchases/${data.purchase.id}`, true);
  await shot('03-goods-receiving.png', `/purchases/${data.secondPurchase.id}/receive`, true);
  await shot('04-supplier-account.png', `/suppliers/${data.supplier.id}/account`, true);

  await page.goto(`${base}/#/suppliers/${data.supplier.id}/account`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Pay', exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outputDir, '05-supplier-payment.png') });
  await page.keyboard.press('Escape');

  await shot('06-expenses.png', '/expenses');
  await shot('07-financial-reports.png', '/reports/financial', true);
  await shot('08-cash-register.png', '/cash-register');
  await context.close();
}

let browser: Browser | undefined;
try {
  const data = await seed();
  browser = await chromium.launch(
    process.env.MEDIMART_SANDBOX_BROWSER === '1' ? await sandboxBrowserOptions() : {},
  );
  await capture(browser, data);
  console.log(`Screenshots written to ${outputDir}`);
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await db.close();
}
