import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate, type Database } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import { loadConfig, type ApiConfig } from '../apps/api/src/config';
import { staffRegistrationSchema, type SessionResponse } from '@medimart/shared';
import { AuthService } from '../apps/api/src/services/auth';
import { hashToken, opaqueToken } from '../apps/api/src/services/crypto';
let db: Database;
let app: ReturnType<typeof createApp>;
let owner: ReturnType<typeof request.agent>;
let ownerSession: SessionResponse;
const origin = 'https://trusted.medimart.test';
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 3001,
  databasePath: ':memory:',
  bootstrapToken: 'f'.repeat(64),
  allowedOrigins: [origin, 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
};
const ownerBody = {
  fullName: 'Test Owner',
  email: 'owner@example.test',
  password: 'A long private owner passphrase',
  bootstrapToken: config.bootstrapToken,
};
const staffBody = {
  fullName: 'Test Cashier',
  email: 'cashier@example.test',
  password: 'A long individual staff passphrase',
  roles: ['cashier'],
};
async function bootstrap() {
  const response = await owner
    .post('/api/auth/register-owner')
    .set('Origin', origin)
    .send(ownerBody);
  expect(response.status).toBe(201);
  ownerSession = response.body;
  return response;
}
async function addStaff(body = staffBody) {
  return owner.post('/api/staff').set('X-CSRF-Token', ownerSession.csrfToken!).send(body);
}
beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db);
  app = createApp(db, config);
  owner = request.agent(app);
});
afterEach(async () => {
  await db.close();
});
describe('registration, sessions, and password security', () => {
  it('allows one controlled owner and never creates default credentials', async () => {
    expect((await request(app).get('/api/auth/bootstrap-status')).body).toEqual({
      required: true,
      enabled: true,
    });
    expect(
      (
        await request(app)
          .post('/api/auth/register-owner')
          .send({ ...ownerBody, bootstrapToken: '0'.repeat(64) })
      ).status,
    ).toBe(403);
    const response = await bootstrap();
    expect(response.body.user.roles).toEqual(['owner']);
    expect(response.body.token).toBeUndefined();
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(response.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
    expect((await request(app).post('/api/auth/register-owner').send(ownerBody)).status).toBe(409);
    expect((await request(app).get('/api/auth/bootstrap-status')).body.required).toBe(false);
    const stored = (await db.all<{ password_hash: string }>('SELECT password_hash FROM users'))[0]!
      .password_hash;
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(stored).not.toContain(ownerBody.password);
  });
  it('serializes simultaneous owner-registration attempts', async () => {
    const result = await Promise.all([
      request(app).post('/api/auth/register-owner').send(ownerBody),
      request(app)
        .post('/api/auth/register-owner')
        .send({ ...ownerBody, email: 'other@example.test' }),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.all('SELECT * FROM users')).toHaveLength(1);
  });
  it('rejects weak passwords, unknown fields, and SQL-shaped inputs', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/register-owner')
          .send({ ...ownerBody, password: 'short' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/register-owner')
          .send({ ...ownerBody, roles: ['owner'] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: "x' OR 1=1 --", password: 'anything' })
      ).status,
    ).toBe(400);
    expect(await db.all('SELECT * FROM users')).toHaveLength(0);
  });
  it('uses a hashed opaque session and restores identity without exposing secrets', async () => {
    const response = await bootstrap();
    const cookie = response.headers['set-cookie']![0]!.match(/medimart_session=([a-f0-9]+)/)![1]!;
    const row = (await db.all<{ token_hash: string }>('SELECT token_hash FROM user_sessions'))[0]!;
    expect(row.token_hash).toBe(hashToken(cookie));
    expect(row.token_hash).not.toBe(cookie);
    const session = await owner.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(ownerBody.email);
    expect(session.body.token).toBeUndefined();
    expect(JSON.stringify(session.body)).not.toContain('password_hash');
  });
  it('normalizes emails and refuses nil or malformed device IDs at the API boundary', async () => {
    await bootstrap();
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: ' OWNER@example.test ', password: ownerBody.password })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app).post('/api/devices/register').send({
          id: '00000000-0000-0000-0000-000000000000',
          name: 'Test phone',
          platform: 'android',
          secret: opaqueToken(),
        })
      ).status,
    ).toBe(400);
    const upper = crypto.randomUUID().toUpperCase();
    const response = await request(app)
      .post('/api/devices/register')
      .send({ id: upper, name: 'Normalized phone', platform: 'android', secret: opaqueToken() });
    expect(response.status).toBe(201);
    expect(response.body.id).toBe(upper.toLowerCase());
  });
  it('revokes sessions on logout and on logout-all', async () => {
    await bootstrap();
    const second = request.agent(app);
    await second
      .post('/api/auth/login')
      .send({ email: ownerBody.email, password: ownerBody.password });
    expect(
      (
        await owner
          .post('/api/auth/logout-all')
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({})
      ).status,
    ).toBe(204);
    expect((await owner.get('/api/auth/session')).status).toBe(401);
    expect((await second.get('/api/auth/session')).status).toBe(401);
    const login = await owner
      .post('/api/auth/login')
      .send({ email: ownerBody.email, password: ownerBody.password });
    expect(
      (await owner.post('/api/auth/logout').set('X-CSRF-Token', login.body.csrfToken).send({}))
        .status,
    ).toBe(204);
    expect((await owner.get('/api/auth/session')).status).toBe(401);
  });
  it('rejects expired sessions and disabled staff accounts', async () => {
    await bootstrap();
    await db.run(
      "UPDATE user_sessions SET created_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-02T00:00:00.000Z'",
    );
    expect((await owner.get('/api/auth/session')).status).toBe(401);
    await owner
      .post('/api/auth/login')
      .send({ email: ownerBody.email, password: ownerBody.password });
    await db.run("UPDATE users SET status='disabled'");
    expect((await owner.get('/api/auth/session')).status).toBe(401);
  });
  it('changes an individual password only with reauthentication and revokes every session', async () => {
    await bootstrap();
    const second = request.agent(app);
    await second
      .post('/api/auth/login')
      .send({ email: ownerBody.email, password: ownerBody.password });
    const newPassword = 'A new and different individual passphrase';
    expect(
      (
        await owner
          .post('/api/auth/change-password')
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ currentPassword: 'wrong', newPassword })
      ).status,
    ).toBe(401);
    expect((await owner.get('/api/auth/session')).status).toBe(200);
    expect(
      (
        await owner
          .post('/api/auth/change-password')
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ currentPassword: ownerBody.password, newPassword })
      ).status,
    ).toBe(204);
    expect((await second.get('/api/auth/session')).status).toBe(401);
    expect((await owner.get('/api/auth/session')).status).toBe(401);
    expect(
      (
        await owner
          .post('/api/auth/login')
          .send({ email: ownerBody.email, password: ownerBody.password })
      ).status,
    ).toBe(401);
    expect(
      (await owner.post('/api/auth/login').send({ email: ownerBody.email, password: newPassword }))
        .status,
    ).toBe(200);
    expect((await db.all<{ version: number }>('SELECT version FROM users'))[0]!.version).toBe(2);
  });
  it('persists failed attempts and enforces account lockout', async () => {
    await bootstrap();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post('/api/auth/login')
            .send({ email: ownerBody.email, password: 'wrong' })
        ).status,
      ).toBe(401);
    const row = (
      await db.all<{ failed_login_count: number; locked_until: string }>(
        'SELECT failed_login_count,locked_until FROM users',
      )
    )[0]!;
    expect(row.failed_login_count).toBe(5);
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now());
    expect(
      (
        await owner
          .post('/api/auth/login')
          .send({ email: ownerBody.email, password: ownerBody.password })
      ).status,
    ).toBe(401);
    await db.run("UPDATE users SET locked_until='2020-01-01T00:00:00.000Z'");
    expect(
      (
        await owner
          .post('/api/auth/login')
          .send({ email: ownerBody.email, password: ownerBody.password })
      ).status,
    ).toBe(200);
    expect(
      (await db.all<{ failed_login_count: number }>('SELECT failed_login_count FROM users'))[0]!
        .failed_login_count,
    ).toBe(0);
  });
});
describe('authorization and API boundaries', () => {
  it('requires authentication and permission on protected resources', async () => {
    expect((await request(app).get('/api/staff')).status).toBe(401);
    await bootstrap();
    expect((await addStaff()).status).toBe(201);
    const cashier = request.agent(app);
    const login = await cashier
      .post('/api/auth/login')
      .send({ email: staffBody.email, password: staffBody.password });
    expect(login.body.user.permissions).toContain('pos.access');
    expect(login.body.user.permissions).not.toContain('patients.view');
    expect((await cashier.get('/api/staff')).status).toBe(403);
    expect((await cashier.get('/api/audit-logs')).status).toBe(403);
    expect(
      (
        await cashier
          .post('/api/staff')
          .set('X-CSRF-Token', login.body.csrfToken)
          .send({ ...staffBody, email: 'new@example.test' })
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier
          .put('/api/settings')
          .set('X-CSRF-Token', login.body.csrfToken)
          .send({ businessName: 'Not allowed' })
      ).status,
    ).toBe(403);
  });
  it('forbids owner creation through staff registration and administrator escalation', async () => {
    await bootstrap();
    expect((await addStaff({ ...staffBody, roles: ['owner'] })).status).toBe(400);
    expect((await addStaff({ ...staffBody, roles: ['administrator'] })).status).toBe(201);
    const admin = request.agent(app);
    const login = await admin
      .post('/api/auth/login')
      .send({ email: staffBody.email, password: staffBody.password });
    expect(
      (
        await admin
          .post('/api/staff')
          .set('X-CSRF-Token', login.body.csrfToken)
          .send({ ...staffBody, email: 'other@example.test', roles: ['administrator'] })
      ).status,
    ).toBe(403);
  });
  it('revalidates a session inside security-sensitive writes after asynchronous password work', async () => {
    const response = await bootstrap();
    const token = response.headers['set-cookie']![0]!.match(/medimart_session=([a-f0-9]+)/)![1]!;
    const service = new AuthService(db, config);
    const context = await service.authenticate(token, 'cookie');
    await db.run('UPDATE user_sessions SET revoked_at=?', [new Date().toISOString()]);
    await expect(
      service.registerStaff(staffRegistrationSchema.parse(staffBody), context, {
        requestId: crypto.randomUUID(),
        userAgent: 'test',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(await db.all('SELECT id FROM users')).toHaveLength(1);
  });
  it('checks delegated capabilities against live database grants, not a stale role catalog', async () => {
    await bootstrap();
    await addStaff({ ...staffBody, roles: ['administrator'] });
    const admin = request.agent(app);
    const login = await admin
      .post('/api/auth/login')
      .send({ email: staffBody.email, password: staffBody.password });
    await db.run(
      "INSERT INTO role_permissions (id,role_id,permission_id) SELECT ?,r.id,p.id FROM roles r,permissions p WHERE r.code='cashier' AND p.code='permissions.manage'",
      [crypto.randomUUID()],
    );
    expect(
      (
        await admin
          .post('/api/staff')
          .set('X-CSRF-Token', login.body.csrfToken)
          .send({ ...staffBody, email: 'new-cashier@example.test', roles: ['cashier'] })
      ).status,
    ).toBe(403);
  });
  it('rechecks effective permissions on every request', async () => {
    await bootstrap();
    expect((await owner.get('/api/audit-logs')).status).toBe(200);
    await db.run(
      "DELETE FROM role_permissions WHERE permission_id=(SELECT id FROM permissions WHERE code='audit.view')",
    );
    expect((await owner.get('/api/audit-logs')).status).toBe(403);
  });
  it('requires CSRF proof and denies untrusted origins', async () => {
    await bootstrap();
    expect((await owner.put('/api/settings').send({ businessName: 'Denied' })).status).toBe(403);
    expect(
      (
        await owner
          .put('/api/settings')
          .set('X-CSRF-Token', 'wrong')
          .send({ businessName: 'Denied' })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner
          .put('/api/settings')
          .set('Origin', 'https://attacker.test')
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ businessName: 'Denied' })
      ).status,
    ).toBe(403);
    expect(
      (
        await owner
          .put('/api/settings')
          .set('Origin', origin)
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ businessName: 'Local pharmacy' })
      ).status,
    ).toBe(200);
    expect((await owner.get('/api/settings')).body.businessName).toBe('Local pharmacy');
  });
  it('validates content types, JSON, body limits, and routes consistently', async () => {
    expect(
      (await request(app).post('/api/auth/login').type('form').send('email=test')).status,
    ).toBe(415);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send('{bad')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ huge: 'a'.repeat(70_000) })
      ).status,
    ).toBe(413);
    const missing = await request(app).get('/api/sales');
    expect(missing.status).toBe(404);
    expect(missing.body.error.requestId).toBeTruthy();
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.body.sync).toBe('not_implemented');
  });
  it('rate limits expensive authentication attempts', async () => {
    for (let i = 0; i < 10; i++)
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'none@example.test', password: 'invalid' });
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'none@example.test', password: 'invalid' });
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeTruthy();
  });
  it('sets production security headers and secure cookies while allowing explicit native CORS', async () => {
    const production = createApp(db, { ...config, environment: 'production', secureCookies: true });
    const preflight = await request(production)
      .options('/api/auth/login')
      .set('Origin', 'https://localhost')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://localhost');
    const response = await request(production)
      .post('/api/auth/register-owner')
      .set('Origin', origin)
      .send(ownerBody);
    expect(response.status).toBe(201);
    expect(response.headers['set-cookie']?.[0]).toContain('Secure');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['strict-transport-security']).toBeTruthy();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(
      (
        await request(production)
          .options('/api/auth/login')
          .set('Origin', 'https://untrusted.example')
      ).status,
    ).toBe(403);
  });
  it('fails closed on insecure production configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      'secure cookies',
    );
    expect(() =>
      loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://unsafe.test' }),
    ).toThrow('HTTPS');
    expect(loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: origin }).secureCookies).toBe(
      true,
    );
  });
});
describe('pairing and audit foundations', () => {
  it('requires verified pairing for native bearer sessions and immediately honors revocation', async () => {
    await bootstrap();
    const device = {
      id: crypto.randomUUID(),
      name: 'Front counter phone',
      platform: 'android',
      secret: opaqueToken(),
    };
    const pending = await request(app).post('/api/devices/register').send(device);
    expect(pending.status).toBe(201);
    expect(pending.body.pairingCode).toMatch(/^\d{8}$/);
    const credentials = {
      email: ownerBody.email,
      password: ownerBody.password,
      device: { id: device.id, secret: device.secret },
    };
    expect((await request(app).post('/api/auth/login').send(credentials)).status).toBe(403);
    expect(
      (
        await owner
          .post(`/api/devices/${device.id}/approve`)
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ pairingCode: pending.body.pairingCode })
      ).status,
    ).toBe(204);
    const login = await request(app).post('/api/auth/login').send(credentials);
    expect(login.status).toBe(200);
    expect(login.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(
      (
        await request(app)
          .get('/api/auth/session')
          .set('Authorization', `Bearer ${login.body.token}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/auth/session')
          .set('Cookie', `medimart_session=${login.body.token}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await owner
          .post(`/api/devices/${device.id}/revoke`)
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({})
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get('/api/auth/session')
          .set('Authorization', `Bearer ${login.body.token}`)
      ).status,
    ).toBe(401);
    expect((await request(app).post('/api/devices/register').send(device)).status).toBe(403);
  });
  it('supports safe registration retries but not replacement of a device secret', async () => {
    const device = {
      id: crypto.randomUUID(),
      name: 'Phone registration',
      platform: 'android',
      secret: opaqueToken(),
    };
    await request(app).post('/api/devices/register').send(device);
    expect((await request(app).post('/api/devices/register').send(device)).status).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/devices/register')
          .send({ ...device, secret: opaqueToken() })
      ).status,
    ).toBe(409);
    expect(await db.all('SELECT id FROM devices')).toHaveLength(1);
    const stored = (await db.all<{ secret_hash: string }>('SELECT secret_hash FROM devices'))[0]!;
    expect(stored.secret_hash).toBe(hashToken(device.secret));
  });
  it('persists wrong pairing attempts and rejects expired pairing codes', async () => {
    await bootstrap();
    const device = {
      id: crypto.randomUUID(),
      name: 'Pending phone',
      platform: 'android',
      secret: opaqueToken(),
    };
    const registration = await request(app).post('/api/devices/register').send(device);
    const wrong = registration.body.pairingCode === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++)
      expect(
        (
          await owner
            .post(`/api/devices/${device.id}/approve`)
            .set('X-CSRF-Token', ownerSession.csrfToken!)
            .send({ pairingCode: wrong })
        ).status,
      ).toBe(400);
    expect(
      (await db.all<{ pairing_attempts: number }>('SELECT pairing_attempts FROM devices'))[0]!
        .pairing_attempts,
    ).toBe(5);
    expect(
      (
        await owner
          .post(`/api/devices/${device.id}/approve`)
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ pairingCode: registration.body.pairingCode })
      ).status,
    ).toBe(410);
    await request(app).post('/api/devices/register').send(device);
    await db.run("UPDATE devices SET pairing_expires_at='2020-01-01T00:00:00.000Z'");
    expect(
      (
        await owner
          .post(`/api/devices/${device.id}/approve`)
          .set('X-CSRF-Token', ownerSession.csrfToken!)
          .send({ pairingCode: registration.body.pairingCode })
      ).status,
    ).toBe(410);
  });
  it('audits important actions without recording credentials, tokens, or pairing secrets', async () => {
    await bootstrap();
    await addStaff();
    await request(app).post('/api/auth/login').send({ email: staffBody.email, password: 'wrong' });
    const entries = (await owner.get('/api/audit-logs')).body.entries as { action: string }[];
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['owner.registered', 'staff.registered', 'auth.login_failed']),
    );
    const text = JSON.stringify(entries);
    for (const secret of [
      ownerBody.password,
      staffBody.password,
      config.bootstrapToken,
      ownerSession.csrfToken!,
    ])
      expect(text).not.toContain(secret);
  });
});
