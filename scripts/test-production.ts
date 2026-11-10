import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  SessionResponse,
  Patient,
  Prescription,
  Consultation,
  SaleDetail,
} from '@medimart/shared';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Exercise the compiled entry point, not tsx/source imports. Native addons must stay external.
const directory = mkdtempSync(join(tmpdir(), 'medimart-production-smoke-'));
const reservation = createServer();
reservation.listen(0, '0.0.0.0');
await once(reservation, 'listening');
const port = (reservation.address() as AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const bootstrapToken = randomUUID() + randomUUID();
const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    API_HOST: '0.0.0.0',
    API_PORT: String(port),
    DATABASE_PATH: join(directory, 'smoke.sqlite'),
    BOOTSTRAP_TOKEN: bootstrapToken,
    ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
try {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Compiled server did not start: ${output}`)),
      15_000,
    );
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('MediMart API listening')) {
        clearTimeout(deadline);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`Compiled server exited with ${code}: ${output}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { database: string }).database, 'ready');
  const htmlResponse = await fetch(base, { signal: AbortSignal.timeout(5000) });
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert(html.includes('Content-Security-Policy'));
  const asset = html.match(/src="(\.\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset, 'The production HTML must reference a bundled JavaScript entry.');
  assert.equal((await fetch(new URL(asset, `${base}/`))).status, 200);
  assert.equal((await fetch(`${base}/assets/missing-asset.js`)).status, 404);
  const missingApi = await fetch(`${base}/api/missing`);
  assert.equal(missingApi.status, 404);
  assert((missingApi.headers.get('content-type') || '').includes('application/json'));
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  for (const path of [
    '/api/patients',
    '/api/consultations',
    '/api/prescriptions',
    '/api/healthcare/reports',
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 401);
  const post = async <T>(
    path: string,
    body: object,
    session?: { cookie: string; csrf: string },
  ) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      },
      body: JSON.stringify(body),
    });
    assert(response.ok, `Compiled clinical request failed: ${path} (${response.status})`);
    return { response, data: (await response.json()) as T };
  };
  const owner = await post<SessionResponse>('/api/auth/register-owner', {
    fullName: 'Synthetic Smoke Owner',
    email: 'smoke-owner@synthetic.test',
    password: 'Synthetic smoke owner passphrase 2026!',
    bootstrapToken,
  });
  const ownerSession = {
    cookie: owner.response.headers.get('set-cookie')!.split(';')[0]!,
    csrf: owner.data.csrfToken!,
  };
  await post(
    '/api/staff',
    {
      fullName: 'Synthetic Smoke Professional',
      email: 'smoke-clinician@synthetic.test',
      password: 'Synthetic smoke clinical passphrase 2026!',
      roles: ['healthcare_professional', 'pharmacist'],
    },
    ownerSession,
  );
  const clinical = await post<SessionResponse>('/api/auth/login', {
    email: 'smoke-clinician@synthetic.test',
    password: 'Synthetic smoke clinical passphrase 2026!',
  });
  const session = {
    cookie: clinical.response.headers.get('set-cookie')!.split(';')[0]!,
    csrf: clinical.data.csrfToken!,
  };
  const person = (
    await post<Patient>(
      '/api/patients',
      {
        fullName: 'Synthetic Smoke Patient',
        dateOfBirth: '1990-01-01',
        gender: 'unspecified',
        allergies: 'Synthetic smoke allergy',
      },
      session,
    )
  ).data;
  const encounter = (
    await post<Consultation>(
      '/api/consultations',
      {
        patientId: person.id,
        consultedAt: new Date().toISOString(),
        complaints: 'Synthetic smoke complaint',
      },
      session,
    )
  ).data;
  await post(
    `/api/patients/${person.id}/vitals`,
    { measuredAt: new Date().toISOString(), weight: 80, height: 200 },
    session,
  );
  const units = (await (
    await fetch(`${base}/api/units`, { headers: { Cookie: ownerSession.cookie } })
  ).json()) as { units: { id: string; code: string }[] };
  const unit = units.units.find((u) => u.code === 'tablet')!.id;
  const medicine = (
    await post<{ id: string }>(
      '/api/products',
      {
        name: 'Synthetic Smoke Medicine',
        sku: 'SYNTH-SMOKE',
        productType: 'medicine',
        purchaseCostKobo: 100,
        sellingPriceKobo: 200,
        reorderLevel: 0,
        baseUnitId: unit,
        isExpiryTracked: true,
        status: 'active',
        units: [],
      },
      ownerSession,
    )
  ).data;
  await post(
    '/api/stock/receive',
    {
      operationId: randomUUID(),
      productId: medicine.id,
      unitId: unit,
      quantity: 10,
      unitCostKobo: 100,
      batchNumber: 'SYNTH-SMOKE-BATCH',
      expiryDate: '2031-01-01',
      reason: 'Synthetic smoke fixture',
    },
    ownerSession,
  );
  const draft = (
    await post<{ prescription: Prescription }>(
      '/api/prescriptions',
      {
        patientId: person.id,
        consultationId: encounter.id,
        prescribedAt: new Date().toISOString(),
        items: [
          {
            productId: medicine.id,
            strength: '10mg',
            dosage: 'One tablet',
            route: 'Oral',
            frequency: 'Daily',
            duration: '4 days',
            quantity: 4,
          },
        ],
      },
      session,
    )
  ).data.prescription;
  await post(`/api/prescriptions/${draft.id}/authorize`, { reviewedWarnings: true }, session);
  const saleBody = {
    operationId: randomUUID(),
    prescription: { id: draft.id, reviewedWarnings: true },
    items: [{ productId: medicine.id, unitId: unit, quantity: 3 }],
    payments: [{ method: 'cash', amountKobo: 600 }],
  };
  const sale = (await post<SaleDetail>('/api/sales', saleBody, session)).data;
  assert.equal((await post<SaleDetail>('/api/sales', saleBody, session)).data.id, sale.id);
  const final = (
    await post<{ prescription: Prescription }>(
      `/api/prescriptions/${draft.id}/dispense`,
      {
        operationId: randomUUID(),
        reviewedWarnings: true,
        items: [{ itemId: draft.items[0]!.id, quantity: 1 }],
      },
      session,
    )
  ).data;
  assert.equal(final.prescription.status, 'dispensed');
  assert.equal(final.prescription.items[0]!.dispensed, 4);
  console.log(
    'Compiled API smoke check passed: native SQLite startup, migrations, health, bundled UI/assets, service worker, JSON/asset 404 boundaries, healthcare auth boundaries, synthetic registration/consultation/vitals, authorization, POS partial dispensing/replay and full dispensing.',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    await exit;
    clearTimeout(force);
  }
  rmSync(directory, { recursive: true, force: true });
}
