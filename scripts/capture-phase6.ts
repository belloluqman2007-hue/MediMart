/**
 * Phase 6 screenshot capture: the Backup & Sync screen, with a real backup on disk.
 *
 * Runs against a disposable database and the built web application, exactly like the Phase 5
 * capture. It creates a real verified backup through the API first, so the screenshot shows real
 * file names, sizes and checksums rather than invented ones.
 *
 * Usage: MEDIMART_SANDBOX_BROWSER=1 node --import=tsx scripts/capture-phase6.ts
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { migrate } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';
import { sandboxBrowserOptions } from './browser-options';

const port = 4176;
const base = `http://127.0.0.1:${port}`;
const origin = base;
const databasePath = resolve('.artifacts/screenshots/phase6.sqlite');
const backupDir = resolve('.artifacts/screenshots/phase6-backups');
const outputDir = resolve('docs/screenshots/phase6');
const owner = {
  fullName: 'Amina Bello',
  email: 'owner@medimart.demo',
  password: 'A secure phase six screenshot passphrase',
};
const bootstrapToken = 'phase-six-screenshot-token-000000000000000000000';

mkdirSync(resolve('.artifacts/screenshots'), { recursive: true });
mkdirSync(backupDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm', '.restore-request']) {
  rmSync(databasePath + suffix, { force: true });
}
for (const name of (await import('node:fs')).readdirSync(backupDir)) {
  if (name.startsWith('medimart-backup-')) rmSync(resolve(backupDir, name), { force: true });
}

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
  backupDir,
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
  authRateLimit: 200,
};
const server = createApp(db, config, resolve('apps/web/dist')).listen(port, '0.0.0.0');
await new Promise<void>((ready) => server.once('listening', () => ready()));

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

const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

  const supplier = await api<{ id: string }>('/api/suppliers', 'POST', {
    name: 'Emzor Pharmaceutical Distribution',
    contactPerson: 'Chinedu Eze',
    phone: '+234 801 234 5678',
    email: 'orders@emzor.example',
    address: '12 Marina Road, Lagos Island, Lagos',
    businessInfo: 'RC 1234567 · 30-day credit terms',
    notes: 'Primary medicine wholesaler.',
    status: 'active',
  });
  const medicine = await api<{ id: string; baseUnitId: string }>('/api/products', 'POST', {
    name: 'Amoxicillin 500mg Capsules',
    genericName: 'Amoxicillin',
    brand: 'Emzor',
    sku: 'AMOX-500-20',
    barcode: '6151100010012',
    productType: 'medicine',
    categoryId: category('Antibiotics'),
    manufacturer: 'Emzor Pharmaceutical Industries',
    purchaseCostKobo: 45_000,
    sellingPriceKobo: 65_000,
    reorderLevel: 15,
    baseUnitId: unit('tablet'),
    isExpiryTracked: true,
    status: 'active',
    units: [{ unitId: unit('pack'), factor: 10 }],
  });
  await api('/api/stock/receive', 'POST', {
    operationId: crypto.randomUUID(),
    productId: medicine.id,
    unitId: unit('pack'),
    quantity: 12,
    unitCostKobo: 45_000,
    supplierId: supplier.id,
    reason: 'Opening stock',
    batchNumber: 'AMX-2411',
    manufacturingDate: future(-30),
    expiryDate: future(420),
  });
  for (let index = 0; index < 3; index++) {
    await api('/api/sales', 'POST', {
      operationId: crypto.randomUUID(),
      items: [
        {
          productId: medicine.id,
          unitId: medicine.baseUnitId,
          quantity: 2 + index,
          lineDiscountKobo: 0,
        },
      ],
      payments: [{ method: 'cash', amountKobo: 65_000 * (2 + index), reference: null }],
    });
  }
  const settings = await api('/api/backups/settings', 'PUT', {
    directory: backupDir,
    automaticEnabled: true,
    intervalHours: 24,
    retentionCount: 14,
  });
  if (settings === null) throw new Error('Backup settings were not saved');
  await api('/api/backups', 'POST', { note: 'Closing shift' });
  await api('/api/backups', 'POST', { note: 'Before stock count' });
}

async function capture(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/#/login`);
  await page.getByLabel('Email address', { exact: true }).fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Sign in to MediMart' }).click();
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
  const dismiss = page.getByLabel('Dismiss notification');
  if (await dismiss.count()) await dismiss.click().catch(() => undefined);

  await page.goto(`${base}/#/backup-sync`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await page.screenshot({
    path: resolve(outputDir, '01-backup-and-sync.png'),
    fullPage: true,
  });

  // The restore confirmation, where the operator must type the word and is told what will change.
  await page
    .getByRole('button', { name: /^Restore$/ })
    .first()
    .click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outputDir, '02-restore-confirmation.png') });
  await page.keyboard.press('Escape');

  // Settings → Connection & storage, which is where a staff member checks the server address.
  await page.goto(`${base}/#/settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(outputDir, '03-settings-connection.png'), fullPage: true });
  await context.close();
}

let browser: Browser | undefined;
try {
  await seed();
  browser = await chromium.launch(
    process.env.MEDIMART_SANDBOX_BROWSER === '1' ? await sandboxBrowserOptions() : {},
  );
  await capture(browser);
  console.log(`Screenshots written to ${outputDir}`);
} finally {
  await browser?.close();
  await new Promise<void>((close) => server.close(() => close()));
  await db.close();
}
