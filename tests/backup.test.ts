import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, migrations, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import type { SessionResponse } from '@medimart/shared';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';

/**
 * Phase 6 backup and restore tests against real files on disk.
 *
 * A backup must be a complete, self-consistent copy of the business database, and a restore must
 * be refused unless the file is intact and the operator confirms it.
 */
const workDir = mkdtempSync(join(tmpdir(), 'medimart-backup-'));
const backupDir = join(workDir, 'backups');
/** A fresh file per test so no previous owner account or backup row survives. */
const freshDatabase = () => join(workDir, `central-${randomUUID()}.sqlite`);
let databasePath = freshDatabase();
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath,
  bootstrapToken: 'b'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  backupDir,
  managedDesktop: true,
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
  fullName: 'Backup Test Owner',
  email: 'backup-owner@medimart.test',
  password: 'A long private backup owner passphrase',
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

beforeEach(async () => {
  databasePath = freshDatabase();
  db = openNodeDatabase(databasePath);
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
  for (const suffix of ['', '-wal', '-shm', '.restore-request']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
});

describe.skipIf(process.platform === 'win32')('Phase 6: backup and restore', () => {
  it('writes a verified backup file with a checksum and business row counts', async () => {
    const unit = (await db.all<{ id: string }>("SELECT id FROM units WHERE code = 'tablet'"))[0]!
      .id;
    const product = await cookies(owner, ownerSession).post('/api/products', {
      name: 'Ibuprofen 400mg',
      sku: 'BK-IBU-001',
      productType: 'medicine',
      purchaseCostKobo: 3_000,
      sellingPriceKobo: 7_500,
      reorderLevel: 10,
      baseUnitId: unit,
      isExpiryTracked: true,
      status: 'active',
      units: [],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);

    const created = await cookies(owner, ownerSession).post('/api/backups', {
      note: 'Closing shift',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const summary = created.body;
    expect(summary.verified).toBe(true);
    expect(summary.fileName).toMatch(/^medimart-backup-\d{8}T\d{6}\d{3}Z-manual\.sqlite$/);
    expect(summary.sizeBytes).toBeGreaterThan(0);
    expect(summary.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.tableCounts.products).toBe(1);
    expect(summary.tableCounts.users).toBe(1);
    expect(summary.tableCounts.database_migrations).toBeUndefined();

    const file = join(backupDir, summary.fileName);
    expect(existsSync(file)).toBe(true);

    const verified = await cookies(owner, ownerSession).get(
      `/api/backups/${summary.fileName}/verify`,
    );
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.integrityOk).toBe(true);
    expect(verified.body.checksumOk).toBe(true);
    expect(verified.body.expectedChecksum).toBe(summary.checksum);
    expect(verified.body.migrationVersion).toBe(migrations.length);
  });

  it('lists backups with dates and contents and refuses to restore a corrupt file', async () => {
    const created = await cookies(owner, ownerSession).post('/api/backups', {});
    expect(created.status).toBe(201);
    const list = await cookies(owner, ownerSession).get('/api/backups');
    expect(list.status).toBe(200);
    expect(list.body.directory).toBe(backupDir);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].countsTotal).toBeGreaterThan(0);

    // A truncated file must fail verification rather than being restored.
    const path = join(backupDir, created.body.fileName);
    const content = readFileSync(path);
    writeFileSync(path, content.subarray(0, Math.floor(content.length / 3)));
    const verified = await cookies(owner, ownerSession).get(
      `/api/backups/${created.body.fileName}/verify`,
    );
    expect(verified.status).toBe(200);
    expect(verified.body.integrityOk).toBe(false);
    const restore = await cookies(owner, ownerSession).post('/api/backups/restore', {
      fileName: created.body.fileName,
    });
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('BACKUP_CORRUPT');
  });

  it('prepares a verified restore without overwriting the running database', async () => {
    const productId = randomUUID();
    const unit = (await db.all<{ id: string }>("SELECT id FROM units WHERE code = 'tablet'"))[0]!
      .id;
    await db.run(
      `INSERT INTO products (id,name,sku,product_type,purchase_cost_kobo,selling_price_kobo,reorder_level,base_unit_id,is_expiry_tracked,status)
       VALUES (?,'Restore Marker 500mg','RESTORE-1','medicine',100,200,5,?,1,'active')`,
      [productId, unit],
    );
    const settings = await cookies(owner, ownerSession).put('/api/backups/settings', {
      directory: backupDir,
      automaticEnabled: false,
      intervalHours: 24,
      retentionCount: 14,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const created = await cookies(owner, ownerSession).post('/api/backups', {});
    expect(created.status).toBe(201);

    const restore = await cookies(owner, ownerSession).post('/api/backups/restore', {
      fileName: created.body.fileName,
    });
    expect(restore.status, JSON.stringify(restore.body)).toBe(202);
    expect(restore.body.verified).toBe(true);
    // The verified copy and a request marker are staged beside the live database, which stays
    // untouched until the application is restarted and performs the swap.
    const { readdirSync } = await import('node:fs');
    const staged = readdirSync(workDir).filter((name) => name.includes('restore'));
    expect(staged.length, staged.join(', ')).toBeGreaterThanOrEqual(2);
    expect(restore.body.copiedTo.endsWith('.restore-pending')).toBe(true);
    expect((await db.all('SELECT id FROM products WHERE id = ?', [productId])).length).toBe(1);
  });

  it('requires sync.manage and refuses an unsafe backup destination', async () => {
    const cashier = await cookies(owner, ownerSession).post('/api/staff', {
      fullName: 'Backup Cashier',
      email: 'backup-cashier@medimart.test',
      password: 'A long private cashier passphrase',
      roles: ['cashier'],
    });
    expect(cashier.status, JSON.stringify(cashier.body)).toBe(201);
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').set('Origin', origin).send({
      email: 'backup-cashier@medimart.test',
      password: 'A long private cashier passphrase',
    });
    expect(login.status).toBe(200);
    const denied = await agent
      .post('/api/backups')
      .set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken)
      .send({});
    expect(denied.status).toBe(403);

    const unsafe = await cookies(owner, ownerSession).post('/api/backups', {
      directory: workDir,
    });
    expect(unsafe.status, JSON.stringify(unsafe.body)).toBe(400);
    expect(unsafe.body.error.code).toBe('PATH_INVALID');
    // A backup folder that would contain the live database (or sit inside it) is refused.
    const inside = await cookies(owner, ownerSession).put('/api/backups/settings', {
      directory: workDir,
      automaticEnabled: true,
      intervalHours: 24,
      retentionCount: 14,
    });
    expect(inside.status).toBe(400);
    expect(inside.body.error.code).toBe('PATH_INVALID');
  });

  it('never overwrites a backup when two are taken within the same second', async () => {
    const first = await cookies(owner, ownerSession).post('/api/backups', { note: 'Before count' });
    const second = await cookies(owner, ownerSession).post('/api/backups', { note: 'After count' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.fileName).not.toBe(first.body.fileName);
    expect(existsSync(join(backupDir, second.body.fileName))).toBe(true);
    const list = await cookies(owner, ownerSession).get('/api/backups');
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the newest backups according to the retention setting', async () => {
    const settings = await cookies(owner, ownerSession).put('/api/backups/settings', {
      directory: backupDir,
      automaticEnabled: false,
      intervalHours: 24,
      retentionCount: 2,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    for (let index = 0; index < 3; index++) {
      const created = await cookies(owner, ownerSession).post('/api/backups', {
        note: `shift ${index}`,
      });
      expect(created.status).toBe(201);
      // Timestamps have second precision; keep the ordering deterministic.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const files = readFileSafe(backupDir);
    expect(files.length).toBe(2);
  });
});

function readFileSafe(directory: string) {
  try {
    return readdirSync(directory).filter((name) => name.startsWith('medimart-backup-'));
  } catch {
    return [];
  }
}
