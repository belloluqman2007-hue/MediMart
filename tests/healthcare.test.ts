import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import type { SessionResponse } from '@medimart/shared';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: ':memory:',
  bootstrapToken: 'f'.repeat(64),
  allowedOrigins: ['https://trusted.medimart.test'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  backupDir: '.artifacts/backups',
  managedDesktop: false,
  desktopOrigins: [],
  allowLanHttp: false,
};
const origin = config.allowedOrigins[0]!;
let db: Database,
  app: ReturnType<typeof createApp>,
  owner: SessionResponse,
  clinician: SessionResponse,
  pharmacist: SessionResponse,
  cashier: SessionResponse;
const cookies = new WeakMap<SessionResponse, string>();
function client(s: SessionResponse) {
  return {
    get: (p: string) => request(app).get(p).set('Cookie', cookies.get(s)!),
    post: (p: string, b: object = {}) =>
      request(app).post(p).set('Cookie', cookies.get(s)!).set('X-CSRF-Token', s.csrfToken!).send(b),
    put: (p: string, b: object) =>
      request(app).put(p).set('Cookie', cookies.get(s)!).set('X-CSRF-Token', s.csrfToken!).send(b),
  };
}
async function staff(role: string) {
  const email = `${role}@synthetic.test`,
    password = 'Synthetic test passphrase 2026!';
  const result = await client(owner).post('/api/staff', {
    fullName: `Synthetic ${role}`,
    email,
    password,
    roles: [role],
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const login = await request(app)
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ email, password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const session = login.body as SessionResponse;
  cookies.set(session, login.headers['set-cookie']![0]!);
  return session;
}
const patientInput = {
  fullName: 'Synthetic Patient Alpha',
  dateOfBirth: '1990-01-01',
  gender: 'female',
  phone: '000-555-0100',
  allergies: 'Penicillin',
  conditions: 'Synthetic condition only',
};
async function register() {
  const r = await client(clinician).post('/api/patients', patientInput);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; patientCode: string };
}
async function medicine() {
  const unit = (await db.all<{ id: string }>("SELECT id FROM units WHERE code='tablet'"))[0]!.id;
  const p = await client(owner).post('/api/products', {
    name: 'Synthetic Medicine',
    genericName: 'Synthetic ingredient',
    sku: 'SYNTH-01',
    productType: 'medicine',
    purchaseCostKobo: 100,
    sellingPriceKobo: 200,
    reorderLevel: 0,
    baseUnitId: unit,
    isExpiryTracked: true,
    status: 'active',
    units: [],
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id as string, unit };
}
async function stock(
  productId: string,
  unitId: string,
  batchNumber: string,
  quantity: number,
  expiryDate: string,
) {
  const r = await client(owner).post('/api/stock/receive', {
    operationId: randomUUID(),
    productId,
    unitId,
    quantity,
    unitCostKobo: 100,
    batchNumber,
    expiryDate,
    reason: 'Synthetic test stock',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
async function draft(patientId: string, productId: string, quantity = 10, consultationId?: string) {
  const r = await client(clinician).post('/api/prescriptions', {
    patientId,
    consultationId: consultationId ?? null,
    prescribedAt: new Date().toISOString(),
    items: [
      {
        productId,
        strength: '10mg',
        dosage: 'One tablet',
        route: 'Oral',
        frequency: 'Daily',
        duration: '10 days',
        quantity,
        instructions: 'Synthetic fixture only',
      },
    ],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
beforeEach(async () => {
  db = await openNodeDatabase(':memory:');
  await migrate(db);
  app = createApp(db, config);
  const r = await request(app).post('/api/auth/register-owner').set('Origin', origin).send({
    fullName: 'Synthetic Owner',
    email: 'owner@synthetic.test',
    password: 'Synthetic owner test passphrase 2026!',
    bootstrapToken: config.bootstrapToken,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  owner = r.body;
  cookies.set(owner, r.headers['set-cookie']![0]!);
  clinician = await staff('healthcare_professional');
  pharmacist = await staff('pharmacist');
  cashier = await staff('cashier');
});
afterEach(async () => {
  await db.close();
});
describe('Phase 4 patient care', () => {
  it('registers, detects duplicates, searches, edits, audits and protects patient profiles', async () => {
    const p = await register();
    expect((await client(clinician).post('/api/patients', patientInput)).status).toBe(409);
    for (const search of ['Alpha', '0005550100', p.patientCode]) {
      const r = await client(clinician).get(`/api/patients?search=${search}`);
      expect(r.body.items[0].id).toBe(p.id);
    }
    expect(
      (
        await client(clinician).put(`/api/patients/${p.id}`, {
          ...patientInput,
          address: 'Synthetic test address',
        })
      ).status,
    ).toBe(200);
    const profile = await client(clinician).get(`/api/patients/${p.id}`);
    expect(profile.body.patient.address).toBe('Synthetic test address');
    expect((await client(cashier).get(`/api/patients/${p.id}`)).status).toBe(403);
    expect((await request(app).get('/api/patients')).status).toBe(401);
    expect(
      (
        await client(clinician).post('/api/patients', {
          ...patientInput,
          fullName: 'Invalid',
          age: null,
          dateOfBirth: null,
        })
      ).status,
    ).toBe(400);
    const logs = await db.all<{ action: string; metadata_json: string }>(
      "SELECT action,metadata_json FROM audit_logs WHERE action LIKE 'healthcare.%'",
    );
    expect(logs.map((l) => l.action)).toContain('healthcare.patient_updated');
    expect(JSON.stringify(logs)).not.toContain(patientInput.fullName);
  });
  it('records consultations and vitals without inventing measurements; filters dates and redacts clinical history', async () => {
    const p = await register();
    const r = await client(clinician).post('/api/consultations', {
      patientId: p.id,
      consultedAt: new Date().toISOString(),
      complaints: 'Synthetic complaint',
      impression: 'Professional documentation only',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const v = await client(clinician).post(`/api/patients/${p.id}/vitals`, {
      measuredAt: new Date().toISOString(),
      weight: 80,
      height: 200,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.bmi).toBe(20);
    expect(v.body.temperature).toBeNull();
    expect(
      (
        await client(clinician).post(`/api/patients/${p.id}/vitals`, {
          measuredAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await client(pharmacist).get(`/api/patients/${p.id}`)).body.consultations,
    ).toBeUndefined();
    expect((await client(cashier).get('/api/consultations')).status).toBe(403);
    expect(
      (await client(clinician).get(`/api/consultations?patientId=${p.id}`)).body.items,
    ).toHaveLength(1);
    expect(
      (await client(clinician).get('/api/consultations?from=2099-01-01')).body.items,
    ).toHaveLength(0);
  });
  it('enforces professional creation/authorization, flags allergies, edits drafts and cancels with audit', async () => {
    const p = await register(),
      m = await medicine(),
      r = await draft(p.id, m.id);
    expect(r.warnings.allergies).toBe('Penicillin');
    expect(
      (
        await client(owner).post(`/api/prescriptions/${r.prescription.id}/authorize`, {
          reviewedWarnings: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client(pharmacist).post(`/api/prescriptions/${r.prescription.id}/authorize`, {
          reviewedWarnings: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client(clinician).post(`/api/prescriptions/${r.prescription.id}/authorize`, {
          reviewedWarnings: false,
        })
      ).status,
    ).toBe(400);
    const edited = await client(clinician).put(`/api/prescriptions/${r.prescription.id}`, {
      patientId: p.id,
      prescribedAt: new Date().toISOString(),
      items: r.prescription.items.map((i: Record<string, unknown>) => {
        const input = Object.fromEntries(
          Object.entries(i).filter(([k]) => !['id', 'medicineName', 'dispensed'].includes(k)),
        );
        return { ...input, quantity: 8 };
      }),
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(
      (
        await client(clinician).post(`/api/prescriptions/${r.prescription.id}/cancel`, {
          reason: 'Synthetic cancellation test',
        })
      ).body.status,
    ).toBe('cancelled');
    expect(
      (await db.all("SELECT id FROM audit_logs WHERE action='healthcare.prescription_cancelled'"))
        .length,
    ).toBe(1);
  });
  it('dispenses partial then full with FEFO, exactly-once ledger entries and atomic retry conflict', async () => {
    const p = await register(),
      m = await medicine();
    await stock(m.id, m.unit, 'LATE', 7, '2031-01-01');
    await stock(m.id, m.unit, 'EARLY', 5, '2030-01-01');
    const r = await draft(p.id, m.id, 10),
      rx = r.prescription;
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id=?',
          [m.id],
        )
      )[0]!.quantity,
    ).toBe(12);
    expect(
      (
        await client(clinician).post(`/api/prescriptions/${rx.id}/authorize`, {
          reviewedWarnings: true,
        })
      ).status,
    ).toBe(200);
    const input = {
      operationId: randomUUID(),
      reviewedWarnings: true,
      items: [{ itemId: rx.items[0].id, quantity: 6 }],
    };
    const partial = await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, input);
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.prescription.status).toBe('partial');
    expect(partial.body.allocations.map((a: { quantity: number }) => a.quantity)).toEqual([5, 1]);
    const replay = await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, input);
    expect(replay.body).toEqual(partial.body);
    expect(
      (
        await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, {
          ...input,
          items: [{ itemId: rx.items[0].id, quantity: 3 }],
        })
      ).status,
    ).toBe(409);
    const full = await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, {
      ...input,
      operationId: randomUUID(),
      items: [{ itemId: rx.items[0].id, quantity: 4 }],
    });
    expect(full.body.prescription.status).toBe('dispensed');
    const ledger = await db.all<{ quantity: number }>(
      'SELECT quantity FROM stock_movements WHERE reference_id=?',
      [rx.id],
    );
    expect(ledger.reduce((n, r) => n + r.quantity, 0)).toBe(-10);
    expect(ledger).toHaveLength(3);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id=?',
          [m.id],
        )
      )[0]!.quantity,
    ).toBe(2);
    expect(
      (await client(clinician).get(`/api/healthcare/reports?patientId=${p.id}`)).body.dispensed,
    ).toBe(1);
  });
  it('checks out a prescription atomically through existing POS without duplicate stock or payments', async () => {
    const p = await register(),
      m = await medicine();
    await stock(m.id, m.unit, 'POS-BATCH', 20, '2031-01-01');
    const rx = (await draft(p.id, m.id, 10)).prescription;
    await client(clinician).post(`/api/prescriptions/${rx.id}/authorize`, {
      reviewedWarnings: true,
    });
    const payload = {
      operationId: randomUUID(),
      prescription: { id: rx.id, reviewedWarnings: true },
      items: [{ productId: m.id, unitId: m.unit, quantity: 4 }],
      payments: [{ method: 'cash', amountKobo: 800 }],
    };
    expect((await client(cashier).post('/api/sales', payload)).status).toBe(403);
    const sale = await client(pharmacist).post('/api/sales', payload);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await client(pharmacist).post('/api/sales', payload)).body.id).toBe(sale.body.id);
    expect(
      (await db.all('SELECT id FROM prescription_dispensing WHERE sale_id=?', [sale.body.id]))
        .length,
    ).toBe(1);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id=?',
          [m.id],
        )
      )[0]!.quantity,
    ).toBe(16);
    expect(
      (await client(clinician).get(`/api/prescriptions/${rx.id}`)).body.prescription.items[0]
        .dispensed,
    ).toBe(4);
    const bad = await client(pharmacist).post('/api/sales', {
      ...payload,
      operationId: randomUUID(),
      items: [{ productId: m.id, unitId: m.unit, quantity: 7 }],
      payments: [{ method: 'cash', amountKobo: 1400 }],
    });
    expect(bad.status).toBe(409);
    expect(
      (
        await db.all<{ quantity: number }>(
          'SELECT quantity FROM stock_balances WHERE product_id=?',
          [m.id],
        )
      )[0]!.quantity,
    ).toBe(16);
    expect((await db.all('SELECT id FROM sales')).length).toBe(1);
    expect(
      (
        await client(owner).post(`/api/sales/${sale.body.id}/void`, {
          operationId: randomUUID(),
          reason: 'Synthetic review required',
        })
      ).status,
    ).toBe(409);
  });
  it('stores professional medicine warnings, forbids inventory-only warning edits, and validates duplicate lines', async () => {
    const p = await register(),
      m = await medicine();
    expect(
      (
        await client(pharmacist).put(`/api/healthcare/medicines/${m.id}/warning`, {
          warning: 'Synthetic medicine warning',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await client(clinician).put(`/api/healthcare/medicines/${m.id}/warning`, {
          warning: 'Synthetic medicine warning',
        })
      ).status,
    ).toBe(200);
    const rx = await draft(p.id, m.id);
    expect(rx.warnings.medicineWarnings[0].description).toBe('Synthetic medicine warning');
    const item = {
      productId: m.id,
      strength: '10mg',
      dosage: '1',
      route: 'Oral',
      frequency: 'Daily',
      duration: '3 days',
      quantity: 3,
    };
    expect(
      (
        await client(clinician).post('/api/prescriptions', {
          patientId: p.id,
          prescribedAt: new Date().toISOString(),
          items: [item, item],
        })
      ).status,
    ).toBe(400);
  });
  it('blocks expired-only stock, unapproved dispensing, mismatched patient references and overdispensing', async () => {
    const p = await register(),
      m = await medicine();
    await stock(m.id, m.unit, 'EXPIRED', 5, '2030-01-01');
    await db.run("UPDATE product_batches SET expiry_date='2020-01-01' WHERE product_id=?", [m.id]);
    const rx = (await draft(p.id, m.id, 3)).prescription;
    const input = {
      operationId: randomUUID(),
      reviewedWarnings: true,
      items: [{ itemId: rx.items[0].id, quantity: 3 }],
    };
    expect(
      (await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, input)).status,
    ).toBe(409);
    await client(clinician).post(`/api/prescriptions/${rx.id}/authorize`, {
      reviewedWarnings: true,
    });
    const blocked = await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, input);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect((await db.all('SELECT * FROM prescription_dispensing')).length).toBe(0);
    expect((await client(cashier).post(`/api/prescriptions/${rx.id}/dispense`, input)).status).toBe(
      403,
    );
    expect(
      (
        await client(pharmacist).post(`/api/prescriptions/${rx.id}/dispense`, {
          ...input,
          items: [{ itemId: rx.items[0].id, quantity: 4 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client(clinician).post('/api/prescriptions', {
          patientId: p.id,
          consultationId: randomUUID(),
          prescribedAt: new Date().toISOString(),
          items: [
            {
              productId: m.id,
              strength: '10mg',
              dosage: '1',
              route: 'Oral',
              frequency: 'Daily',
              duration: '3 days',
              quantity: 3,
            },
          ],
        })
      ).status,
    ).toBe(400);
  });
});
