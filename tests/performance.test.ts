import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import type { SessionResponse } from '@medimart/shared';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';

/**
 * Phase 6 performance measurements on this machine, with a realistic starting catalogue.
 *
 * These are measurements, not guarantees. The thresholds are deliberately generous (they describe
 * "usable on a four-year-old office computer"), and the printed numbers are the evidence that goes
 * into docs/PHASE_6_PERFORMANCE.md. If a machine fails them the report must say so, not the test.
 */
const workDir = mkdtempSync(join(tmpdir(), 'medimart-perf-'));
const databasePath = join(workDir, 'perf.sqlite');
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath,
  bootstrapToken: 'a'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  backupDir: join(workDir, 'backups'),
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
};
const origin = 'https://trusted.medimart.test';

let db: Database;
let app: ReturnType<typeof createApp>;
let owner: ReturnType<typeof request.agent>;
let session: SessionResponse;
const measurements: Record<string, number> = {};

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = process.hrtime.bigint();
  const value = await work();
  measurements[label] = Number(process.hrtime.bigint() - start) / 1_000_000;
  return value;
};

const post = (path: string, body: object = {}) =>
  owner.post(path).set('Origin', origin).set('X-CSRF-Token', session.csrfToken!).send(body);
const get = (path: string) => owner.get(path);

beforeAll(async () => {
  db = openNodeDatabase(databasePath);
  await migrate(db, migrations);
  app = createApp(db, config);
  owner = request.agent(app);
  const ownerStart = process.hrtime.bigint();
  const created = await owner.post('/api/auth/register-owner').set('Origin', origin).send({
    fullName: 'Performance Owner',
    email: 'perf-owner@medimart.test',
    password: 'A long private performance passphrase',
    bootstrapToken: config.bootstrapToken,
  });
  measurements['startup:first owner (Argon2id)'] =
    Number(process.hrtime.bigint() - ownerStart) / 1e6;
  expect(created.status).toBe(201);
  session = created.body;
}, 120_000);

afterAll(async () => {
  await db.close();
  rmSync(workDir, { recursive: true, force: true });
  console.log('\nMeasured on this machine (milliseconds):');
  for (const [label, value] of Object.entries(measurements))
    console.log(`  ${label}: ${value.toFixed(1)}`);
});

describe.skipIf(process.platform === 'win32')(
  'Phase 6: performance with a realistic catalogue',
  () => {
    it('seeds 400 products and 1,200 sales, then measures search, POS and reporting', async () => {
      const unit = (await db.all<{ id: string }>("SELECT id FROM units WHERE code='tablet'"))[0]!
        .id;
      const category = (
        await db.all<{ id: string }>("SELECT id FROM categories WHERE name='Antibiotics'")
      )[0]!.id;

      // 1. Catalogue: 400 products, written directly to keep the fixture fast and deterministic.
      await timed('catalogue: create 400 products', async () => {
        await db.transaction(async (tx) => {
          for (let index = 0; index < 400; index++) {
            const productId = randomUUID();
            await tx.run(
              `INSERT INTO products (id,name,generic_name,sku,barcode,product_type,category_id,
              purchase_cost_kobo,selling_price_kobo,reorder_level,base_unit_id,is_expiry_tracked,status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                productId,
                `Perf Medicine ${String(index).padStart(3, '0')} 500mg`,
                `Generic ${index}`,
                `PERF-${index}`,
                `890${String(index).padStart(10, '0')}`,
                index % 7 === 0 ? 'drinks' : 'medicine',
                index % 7 === 0 ? null : category,
                2_000 + index,
                4_000 + index,
                10,
                unit,
                // Non-expiry stock so the fixture can be written directly; batch/FEFO behaviour is
                // covered by the sales and inventory suites.
                0,
                'active',
              ],
            );
            await tx.run('INSERT INTO stock_balances (product_id,quantity) VALUES (?,100)', [
              productId,
            ]);
          }
        });
      });

      const products = await db.all<{ id: string }>('SELECT id FROM products');
      expect(products).toHaveLength(400);

      // 2. Search performance through the real HTTP surface.
      await timed('POS: product search (1 of 400)', async () => {
        const result = await get('/api/pos/products?search=Medicine%20123');
        expect(result.status).toBe(200);
        expect(result.body.items.length).toBeGreaterThan(0);
      });
      await timed('POS: list first 40 products', async () => {
        const result = await get('/api/pos/products?pageSize=40');
        expect(result.status).toBe(200);
        expect(result.body.items).toHaveLength(40);
      });

      // 3. Sell 1,200 items over 200 sales.
      await timed('POS: 200 checkout requests (1,200 items)', async () => {
        for (let sale = 0; sale < 200; sale++) {
          const items = Array.from({ length: 6 }, (_, line) => ({
            productId: products[(sale * 6 + line) % products.length]!.id,
            unitId: unit,
            quantity: 1,
            lineDiscountKobo: 0,
          }));
          const response = await post('/api/sales', {
            operationId: randomUUID(),
            customerId: null,
            items,
            cartDiscountKobo: 0,
            payments: [{ method: 'cash', amountKobo: 100_000, reference: null }],
            notes: null,
          });
          expect(response.status, JSON.stringify(response.body)).toBe(201);
        }
      });

      // 4. Reporting and dashboard reads.
      await timed('reports: sales report (today)', async () => {
        const result = await get('/api/reports/sales');
        expect(result.status).toBe(200);
      });
      await timed('reports: financial report (month)', async () => {
        const result = await get('/api/reports/finance');
        expect(result.status).toBe(200);
      });
      await timed('dashboard: inventory aggregates', async () => {
        const result = await get('/api/inventory/dashboard');
        expect(result.status).toBe(200);
      });
      await timed('inventory: stock movement history (page)', async () => {
        const result = await get('/api/stock/movements?pageSize=50');
        expect(result.status).toBe(200);
      });

      // 5. Backup of a database with real volume.
      await timed('backup: create and verify', async () => {
        const result = await post('/api/backups', {});
        expect(result.status, JSON.stringify(result.body)).toBe(201);
        expect(result.body.verified).toBe(true);
        expect(result.body.tableCounts.sales).toBe(200);
        expect(result.body.tableCounts.sale_items).toBe(1200);
      });

      // Thresholds describe a four-year-old office computer, with headroom for a slower machine.
      expect(measurements['POS: product search (1 of 400)']!).toBeLessThan(1_500);
      expect(measurements['reports: financial report (month)']!).toBeLessThan(5_000);
      expect(measurements['dashboard: inventory aggregates']!).toBeLessThan(3_000);
      expect(measurements['backup: create and verify']!).toBeLessThan(60_000);
    }, 600_000);
  },
);
