import { registerHealthcareRoutes } from './routes/healthcare';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Database } from '@medimart/database';
import {
  approveDeviceSchema,
  businessSettingsSchema,
  changePasswordSchema,
  loginSchema,
  ownerRegistrationSchema,
  pairingStatusSchema,
  registerDeviceSchema,
  staffRegistrationSchema,
  uuidSchema,
} from '@medimart/shared';
import type { ApiConfig } from './config';
import { ApiError, errorHandler } from './errors';
import { cookieName, originGuard, requireAuth, requirePermission } from './middleware/security';
import { AuthService, requireActiveContext } from './services/auth';
import { DeviceService } from './services/devices';
import { csrfForToken } from './services/crypto';
import { audit } from './services/audit';
import { registerFinanceRoutes } from './routes/finance';
import { registerInventoryRoutes } from './routes/inventory';
import { registerSalesRoutes } from './routes/sales';
import { registerSyncRoutes, type SyncRouteContext } from './routes/sync';
import { readShopSettings, writeShopSettings } from './services/sales/common';
const meta = (req: Request) => ({
  requestId: req.requestId,
  userAgent: req.get('user-agent') || '',
});
export type AppOptions = {
  /**
   * Folder for backup files, the live database path and the restore-request marker. They are
   * supplied by the entry point so the desktop application can keep every user file in one
   * persistent application-data directory.
   */
  paths?: Partial<SyncRouteContext>;
};

export function createApp(
  db: Database,
  config: ApiConfig,
  webRoot?: string,
  options: AppOptions = {},
) {
  const app = express();
  const auth = new AuthService(db, config);
  const devices = new DeviceService(db);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy:
        config.environment === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                fontSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
              },
            }
          : false,
      xFrameOptions: config.environment === 'production' ? { action: 'deny' } : false,
      strictTransportSecurity: config.environment === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const limiter = (limit: number, windowMs: number) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) => {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please wait before trying again.',
            requestId: req.requestId,
          },
        });
      },
    });
  app.use(
    '/api',
    limiter(config.apiRateLimit ?? 300, 60_000),
    originGuard(config),
    express.json({ limit: '64kb', strict: true }),
  );
  const authLimiter = limiter(config.authRateLimit ?? 10, 15 * 60_000);
  const pairingLimiter = limiter(20, 15 * 60_000);
  const authenticated = requireAuth(auth);
  const cookieOptions = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict' as const,
    path: '/api',
  };
  function sendSession(
    res: Response,
    session: Awaited<ReturnType<AuthService['login']>>,
    status = 200,
  ) {
    if (session.transport === 'cookie')
      res.cookie(cookieName, session.token, {
        ...cookieOptions,
        maxAge: Math.max(0, new Date(session.expiresAt).getTime() - Date.now()),
      });
    res.status(status).json({
      user: session.user,
      expiresAt: session.expiresAt,
      ...(session.transport === 'cookie'
        ? { csrfToken: session.csrfToken }
        : { token: session.token }),
    });
  }
  app.get('/api/health', async (_req, res) => {
    await db.all('SELECT 1');
    res.json({ status: 'ok', database: 'ready', phase: 6, sync: 'offline_capture' });
  });
  app.get('/api/auth/bootstrap-status', async (_req, res) => {
    res.json(await auth.bootstrapStatus());
  });
  app.post('/api/auth/register-owner', authLimiter, async (req, res) => {
    sendSession(
      res,
      await auth.registerOwner(ownerRegistrationSchema.parse(req.body), meta(req)),
      201,
    );
  });
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    sendSession(res, await auth.login(loginSchema.parse(req.body), meta(req)));
  });
  app.get('/api/auth/session', authenticated, (req, res) => {
    const context = req.auth!;
    res.json({
      user: context.user,
      expiresAt: context.expiresAt,
      ...(context.transport === 'cookie' ? { csrfToken: csrfForToken(context.rawToken) } : {}),
    });
  });
  app.post('/api/auth/change-password', authenticated, authLimiter, async (req, res) => {
    await auth.changePassword(changePasswordSchema.parse(req.body), req.auth!, meta(req));
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });
  app.post('/api/auth/logout', authenticated, async (req, res) => {
    await auth.logout(req.auth!, meta(req));
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });
  app.post('/api/auth/logout-all', authenticated, async (req, res) => {
    await auth.logout(req.auth!, meta(req), true);
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });
  app.post(
    '/api/staff',
    authenticated,
    requirePermission('staff.manage'),
    authLimiter,
    async (req, res) => {
      res.status(201).json({
        user: await auth.registerStaff(
          staffRegistrationSchema.parse(req.body),
          req.auth!,
          meta(req),
        ),
      });
    },
  );
  app.get('/api/staff', authenticated, requirePermission('staff.view'), async (_req, res) => {
    res.json({
      users: await db.all(
        'SELECT id,full_name,email,status,created_at FROM users WHERE deleted_at IS NULL ORDER BY full_name LIMIT 100',
      ),
    });
  });
  app.get(
    '/api/permissions',
    authenticated,
    requirePermission('permissions.view'),
    async (_req, res) => {
      res.json({
        roles: await db.all('SELECT id,code,name FROM roles ORDER BY name'),
        grants: await db.all(
          'SELECT r.code AS role,p.code AS permission FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id ORDER BY r.code,p.code',
        ),
      });
    },
  );
  app.post('/api/devices/register', pairingLimiter, async (req, res) => {
    res
      .status(201)
      .json(await devices.register(registerDeviceSchema.parse(req.body), req.requestId));
  });
  app.post('/api/devices/status', async (req, res) => {
    const input = pairingStatusSchema.parse(req.body);
    res.json(await devices.status(input.id, input.secret));
  });
  app.get('/api/devices', authenticated, requirePermission('devices.manage'), async (_req, res) => {
    res.json({
      devices: await db.all(
        'SELECT id,name,platform,status,created_at,approved_at,pairing_expires_at FROM devices ORDER BY created_at DESC LIMIT 100',
      ),
    });
  });
  app.post(
    '/api/devices/:id/approve',
    authenticated,
    requirePermission('devices.manage'),
    async (req, res) => {
      await devices.approve(
        uuidSchema.parse(req.params.id),
        approveDeviceSchema.parse(req.body).pairingCode,
        req.auth!,
        req.requestId,
      );
      res.status(204).end();
    },
  );
  app.post(
    '/api/devices/:id/revoke',
    authenticated,
    requirePermission('devices.manage'),
    async (req, res) => {
      z.strictObject({}).parse(req.body);
      await devices.revoke(uuidSchema.parse(req.params.id), req.auth!, req.requestId);
      res.status(204).end();
    },
  );
  app.get('/api/settings', authenticated, requirePermission('settings.view'), async (_req, res) => {
    res.json(await readShopSettings(db));
  });
  app.put(
    '/api/settings',
    authenticated,
    requirePermission('settings.manage'),
    async (req, res) => {
      const input = businessSettingsSchema.parse(req.body);
      const updated = await db.transaction(async (tx) => {
        await requireActiveContext(tx, req.auth!, 'settings.manage');
        const { settings, keys } = await writeShopSettings(tx, input, req.auth!.user.id);
        await audit(tx, {
          action: 'settings.updated',
          actorId: req.auth!.user.id,
          deviceId: req.auth!.deviceId,
          requestId: req.requestId,
          metadata: { keys },
        });
        return settings;
      });
      res.json(updated);
    },
  );
  app.get('/api/audit-logs', authenticated, requirePermission('audit.view'), async (req, res) => {
    const { limit } = z
      .strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    res.json({
      entries: await db.all(
        'SELECT id,actor_user_id,device_id,action,entity_type,entity_id,request_id,metadata_json,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT ?',
        [limit],
      ),
    });
  });
  registerInventoryRoutes(app, db, auth);
  registerSalesRoutes(app, db, auth);
  registerHealthcareRoutes(app, db, auth);
  registerFinanceRoutes(app, db, auth);
  registerSyncRoutes(app, db, auth, config, {
    backupDirectory: resolve(options.paths?.backupDirectory ?? config.backupDir),
    databasePath: options.paths?.databasePath ?? config.databasePath,
    restoreRequestFile: resolve(
      options.paths?.restoreRequestFile ??
        `${options.paths?.databasePath ?? config.databasePath}.restore-request`,
    ),
  });
  app.use('/api', () => {
    throw new ApiError(404, 'NOT_FOUND', 'This API endpoint does not exist.');
  });
  if (webRoot && existsSync(resolve(webRoot, 'index.html'))) {
    app.use(
      '/assets',
      express.static(resolve(webRoot, 'assets'), { maxAge: '1y', immutable: true }),
    );
    app.use('/assets', (_req, res) => {
      res.status(404).end();
    });
    app.use(express.static(webRoot, { index: false, maxAge: 0, etag: true }));
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(webRoot, 'index.html'));
    });
  }
  app.use(errorHandler);
  return app;
}
