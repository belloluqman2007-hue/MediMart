/**
 * Device pairing and offline synchronization, exercised over the network exactly as an Android
 * installation does it.
 *
 * This proves the part of "does it actually work together?" that does not need a person's data:
 *   1. a MediMart server is started on a real port with a disposable database, listening on all
 *      interfaces (as the Windows application does when it is paired with a phone);
 *   2. the first owner account is created and a staff member is added (the Windows first-run flow);
 *   3. a *device* is registered the way the phone does it — installation id + random secret — and
 *      approved with the operator's eight-digit pairing code;
 *   4. the staff member signs in as that device and receives a bearer token, which is what the
 *      Android app stores in the Keystore (no browser cookie is involved);
 *   5. an offline-captured sale is fingerprinted, pushed through the real `/api/sync/push`
 *      endpoint, replayed to prove idempotency, and the device queue reports it as synchronized;
 *   6. a tampered record is rejected rather than silently applied.
 *
 * Everything is synthetic. The server writes only inside a temporary directory and is stopped at
 * the end.
 *
 * Usage:
 *   node --import=tsx scripts/test-android-pairing.ts                 (starts its own server)
 *   node --import=tsx scripts/test-android-pairing.ts http://10.0.2.2:4191
 *     — the Android emulator's alias for the host machine, which is how the emulator job proves
 *       the phone can reach a server that is not "localhost".
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { canonicalJson, OFFLINE_SCHEMA_VERSION, sha256 } from '@medimart/shared';

const requestedBase = process.argv[2];
const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'medimart-pairing-'));
const bootstrapToken = randomBytes(32).toString('hex');
const startedAt = new Date();

const log = (message: string) => console.log(`  ✓ ${message}`);

async function freePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '0.0.0.0');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())),
  );
  return port;
}

function startServer(port: number) {
  const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      // Production behaviour (secure-by-default config validation) with the documented
      // no-internet LAN exceptions the desktop application sets.
      NODE_ENV: 'production',
      API_HOST: '0.0.0.0',
      API_PORT: String(port),
      DATABASE_PATH: join(directory, 'pairing.sqlite'),
      BACKUP_DIR: join(directory, 'backups'),
      BOOTSTRAP_TOKEN: bootstrapToken,
      COOKIE_SECURE: 'false',
      MEDIMART_MANAGED_DESKTOP: 'true',
      MEDIMART_ALLOW_LAN_HTTP: 'true',
      ALLOWED_ORIGINS: 'https://localhost',
      DESKTOP_ALLOWED_ORIGINS: 'https://localhost',
      SESSION_HOURS: '12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const listening = new Promise<void>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error(`Server did not start: ${output}`)), 25_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('MediMart API listening')) {
        clearTimeout(deadline);
        done();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      fail(new Error(`Server exited with ${code}: ${output}`));
    });
  });
  return { child, listening };
}

type Reply<T> = {
  status: number;
  body: T;
  /** Bearer token, returned only by a device-bound (native) session. */
  token?: string;
  /** Browser session cookie, returned only by a cookie-bound session (an unpaired browser). */
  cookie?: string;
  csrf?: string;
};

/**
 * Two credential transports exist in MediMart and both are exercised here:
 *   - a browser session (the Windows window) uses an HttpOnly cookie plus a CSRF header;
 *   - a paired device session (Android) uses a bearer token and no cookie.
 * The second is what the phone keeps in the Android Keystore.
 */
async function call<T>(
  base: string,
  path: string,
  options: {
    method?: string;
    body?: object;
    token?: string;
    session?: { cookie: string; csrf: string };
  } = {},
): Promise<Reply<T>> {
  const method = options.method ?? 'GET';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // The Android WebView origin (Capacitor androidScheme: 'https'), which the packaged
      // server allow-lists alongside the Windows window's loopback origin. Sending it here means
      // the origin guard is exercised exactly as a phone exercises it.
      Origin: 'https://localhost',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.session
        ? { Cookie: options.session.cookie, 'X-CSRF-Token': options.session.csrf }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    body: parsed as T,
    token: (parsed as { token?: string } | null)?.token,
    cookie: setCookie?.split(';')[0],
    csrf: (parsed as { csrfToken?: string } | null)?.csrfToken,
  };
}

/** Build the envelope exactly as apps/web/src/platform/offline.ts does, including its fingerprint. */
async function envelopeFor(
  deviceId: string,
  capturedByUserId: string,
  record: object,
  operationId = randomUUID(),
) {
  const base = {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    operationId,
    deviceId,
    clientCreatedAt: new Date().toISOString(),
    clientDate: new Date().toISOString().slice(0, 10),
    capturedByUserId,
    record,
  };
  return {
    ...base,
    fingerprint: await sha256(canonicalJson(base)),
  } as Record<string, unknown> & { operationId: string; fingerprint: string };
}

async function main() {
  const external = requestedBase?.replace(/\/$/, '');
  // When the caller supplies the address a phone will use (the emulator's host alias), the server
  // must listen on *that* port; otherwise the test would prove nothing about reaching it.
  const port = external ? Number(new URL(external).port || 80) : await freePort();
  const base = external ?? `http://127.0.0.1:${port}`;
  const server = startServer(port);
  const cleanup = () => {
    server.child.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  try {
    await server.listening;
    log(`MediMart server is reachable by the phone at ${base}`);

    const health = await call<{ status: string; database: string }>(base, '/api/health');
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.database, 'ready');
    log('health answers across the device network path');

    // 1. First owner — the call the Windows window makes on first run.
    const owner = await call<{ user: { id: string; fullName: string }; token: string }>(
      base,
      '/api/auth/register-owner',
      {
        method: 'POST',
        body: {
          fullName: 'Synthetic Owner',
          email: 'owner@synthetic.test',
          password: 'Synthetic owner passphrase 2026!',
          bootstrapToken,
        },
      },
    );
    assert.equal(owner.status, 201, JSON.stringify(owner.body));
    assert(owner.cookie, 'The Windows window receives a session cookie.');
    assert(owner.csrf, 'A browser session also receives a CSRF token.');
    const ownerSession = { cookie: owner.cookie, csrf: owner.csrf };
    log('first owner account created (browser session cookie + CSRF, as the Windows window uses)');

    // 2. Staff account, created by the owner (Settings → Staff access).
    const staffEmail = 'cashier@synthetic.test';
    const staffPassword = 'Synthetic cashier passphrase 2026!';
    const staff = await call<{ user: { id: string } }>(base, '/api/staff', {
      method: 'POST',
      session: ownerSession,
      body: {
        fullName: 'Synthetic Cashier',
        email: staffEmail,
        password: staffPassword,
        roles: ['cashier'],
      },
    });
    assert.equal(staff.status, 201, JSON.stringify(staff.body));
    log('staff account created');

    // 3. Device registration, exactly as Settings → Connection & storage does it.
    const device = { id: randomUUID(), secret: randomBytes(32).toString('hex') };
    const registration = await call<{ status: string; pairingCode: string; expiresAt: string }>(
      base,
      '/api/devices/register',
      {
        method: 'POST',
        body: { ...device, name: 'Synthetic Android phone', platform: 'android' },
      },
    );
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(registration.body.status, 'pending');
    assert.match(registration.body.pairingCode, /^\d{8}$/);
    log('device registered and issued an 8-digit pairing code');

    const premature = await call(base, '/api/auth/login', {
      method: 'POST',
      body: { email: staffEmail, password: staffPassword, device },
    });
    assert.equal(premature.status, 403, 'An unapproved device must not obtain a session.');
    log('an unapproved device is refused a session');

    const wrongCode = await call(base, `/api/devices/${device.id}/approve`, {
      method: 'POST',
      session: ownerSession,
      body: { pairingCode: '00000000' },
    });
    assert(wrongCode.status >= 400, 'A wrong pairing code must not approve the device.');
    log('a wrong pairing code is refused');

    const approval = await call(base, `/api/devices/${device.id}/approve`, {
      method: 'POST',
      session: ownerSession,
      body: { pairingCode: registration.body.pairingCode },
    });
    assert.equal(approval.status, 204, JSON.stringify(approval.body));
    const status = await call<{ status: string }>(base, '/api/devices/status', {
      method: 'POST',
      body: device,
    });
    assert.equal(status.body.status, 'approved');
    log('operator approval completes the pairing');

    // 4. Staff sign-in as the paired device → the token the Android app stores in the Keystore.
    const login = await call<{ user: { id: string; permissions: string[] }; token?: string }>(
      base,
      '/api/auth/login',
      { method: 'POST', body: { email: staffEmail, password: staffPassword, device } },
    );
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const deviceToken = login.token;
    assert.match(deviceToken ?? '', /^[a-f0-9]{64}$/);
    const cashierId = login.body.user.id;
    log('staff signed in from the paired device (bearer session)');

    // 5. Inventory access from the device: a cashier may read the POS catalogue but not manage stock.
    const catalogue = await call<{ products: unknown[] }>(base, '/api/pos/products?search=', {
      token: deviceToken,
    });
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.body));
    log(`cashier can read the POS catalogue (${catalogue.body.products?.length ?? 0} products)`);
    const forbidden = await call(base, '/api/inventory/movements', { token: deviceToken });
    assert(
      forbidden.status === 403 || forbidden.status === 404,
      `A cashier must not read inventory movements (got ${forbidden.status}).`,
    );
    log('inventory records stay closed to a cashier session');

    // 6. Offline capture → push → replay → read back. The owner creates stock so the sale is valid.
    const units = await call<{ units: { id: string; code: string }[] }>(base, '/api/units', {
      session: ownerSession,
    });
    const unit = units.body.units.find((entry) => entry.code === 'tablet') ?? units.body.units[0]!;
    const created = await call<{ id: string; name: string }>(base, '/api/products', {
      method: 'POST',
      session: ownerSession,
      body: {
        name: 'Synthetic Offline Paracetamol',
        sku: 'SYNTH-OFFLINE-1',
        productType: 'medicine',
        purchaseCostKobo: 5_000,
        sellingPriceKobo: 10_000,
        reorderLevel: 0,
        baseUnitId: unit.id,
        isExpiryTracked: false,
        status: 'active',
        units: [],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const received = await call(base, '/api/stock/receive', {
      method: 'POST',
      session: ownerSession,
      body: {
        operationId: randomUUID(),
        productId: created.body.id,
        unitId: unit.id,
        quantity: 50,
        unitCostKobo: 5_000,
        reason: 'Synthetic pairing fixture',
      },
    });
    assert(received.status === 200 || received.status === 201, JSON.stringify(received.body));
    log('owner added a product and received stock');

    const saleRecord = {
      recordType: 'sale',
      requiresOnlineReview: false,
      payload: {
        customerId: null,
        customerDraft: null,
        items: [{ productId: created.body.id, unitId: unit.id, quantity: 2, lineDiscountKobo: 0 }],
        cartDiscountKobo: 0,
        discountReason: null,
        payments: [{ method: 'cash', amountKobo: 20_000, reference: null }],
        dueDate: null,
        notes: 'Synthetic offline sale',
      },
    };
    const envelope = await envelopeFor(device.id, cashierId, saleRecord);
    const push = await call<{
      accepted: { outcome: string; receiptNumber: string | null; reference: string }[];
      rejected: { code: string; message: string }[];
      conflicts: unknown[];
    }>(base, '/api/sync/push', {
      method: 'POST',
      token: deviceToken,
      body: { envelopes: [envelope] },
    });
    assert.equal(push.status, 200, JSON.stringify(push.body));
    assert.equal(
      push.body.accepted.length,
      1,
      `The offline sale was not accepted: ${JSON.stringify(push.body)}`,
    );
    assert.equal(push.body.accepted[0]!.outcome, 'applied');
    log(
      `offline sale synchronized with a real receipt: ${push.body.accepted[0]!.receiptNumber ?? push.body.accepted[0]!.reference}`,
    );

    const replay = await call<{ accepted: { outcome: string }[]; rejected: unknown[] }>(
      base,
      '/api/sync/push',
      { method: 'POST', token: deviceToken, body: { envelopes: [envelope] } },
    );
    assert.equal(replay.status, 200);
    assert.equal(
      replay.body.accepted[0]?.outcome,
      'duplicate',
      'A replayed record must be recognised as a duplicate, not applied twice.',
    );
    log('replaying the same record is idempotent (answered as duplicate)');

    const tampered = await envelopeFor(device.id, cashierId, saleRecord);
    tampered.fingerprint = 'a'.repeat(64);
    const alterResponse = await call<{ rejected: { code: string }[]; accepted: unknown[] }>(
      base,
      '/api/sync/push',
      { method: 'POST', token: deviceToken, body: { envelopes: [tampered] } },
    );
    assert(
      alterResponse.status >= 400 ||
        alterResponse.body.rejected.length > 0 ||
        alterResponse.body.accepted.length === 0,
      'A record whose fingerprint does not match must be refused.',
    );
    log('a tampered record is refused');

    const syncStatus = await call<{
      pending: number;
      synced: number;
      device: { status: string } | null;
    }>(base, '/api/sync/status', { token: deviceToken });
    assert.equal(syncStatus.status, 200, JSON.stringify(syncStatus.body));
    assert.equal(syncStatus.body.device?.status, 'approved');
    log(`device queue reports pending=${syncStatus.body.pending} synced=${syncStatus.body.synced}`);

    // 7. Backup without risking real data: a verified file in the temporary directory.
    const backup = await call<{ fileName: string }>(base, '/api/backups', {
      method: 'POST',
      session: ownerSession,
      body: { note: 'Synthetic pairing verification' },
    });
    assert.equal(backup.status, 201, JSON.stringify(backup.body));
    log(`verified backup written: ${backup.body.fileName}`);

    // 8. Revocation: a revoked installation can no longer push.
    const revoke = await call(base, `/api/devices/${device.id}/revoke`, {
      method: 'POST',
      session: ownerSession,
      body: {},
    });
    assert.equal(revoke.status, 204, JSON.stringify(revoke.body));
    const afterRevoke = await call(base, '/api/sync/push', {
      method: 'POST',
      token: deviceToken,
      body: { envelopes: [await envelopeFor(device.id, cashierId, saleRecord)] },
    });
    assert(afterRevoke.status >= 400, 'A revoked device must lose its access.');
    log('revoked device is refused');

    console.log(
      `\nDevice pairing and offline synchronization verified over the network in ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s.`,
    );
  } finally {
    cleanup();
  }
}

await main();
