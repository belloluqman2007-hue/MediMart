import type { RequestHandler, Request } from 'express';
import type { Permission } from '@medimart/shared';
import type { ApiConfig } from '../config';
import { ApiError } from '../errors';
import { csrfForToken, secureEqual } from '../services/crypto';
import type { AuthContext, AuthService } from '../services/auth';
declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    auth?: AuthContext;
  }
}
export const cookieName = 'medimart_session';
export const isUnsafe = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
function trustedOrigin(req: Request, origin: string, config: ApiConfig) {
  if (config.allowedOrigins.includes(origin)) return true;
  // Same-origin Vite proxy in development, including the exact Arena preview host.
  // This does NOT allow arbitrary sibling preview origins.
  if (config.environment === 'development') {
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.host === req.get('host');
    } catch {
      return false;
    }
  }
  return false;
}
export function originGuard(config: ApiConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !trustedOrigin(req, origin, config))
      throw new ApiError(
        403,
        'ORIGIN_DENIED',
        'This application origin is not allowed by the server.',
      );
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
      res.status(204).end();
      return;
    }
    if (isUnsafe(req.method) && !req.is('application/json'))
      throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json for API requests.');
    next();
  };
}
export function requireAuth(service: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const authorization = req.get('authorization');
    const cookie = req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const bearer = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (authorization && !bearer)
      throw new ApiError(401, 'SESSION_INVALID', 'A valid session is required.');
    const token = bearer || cookie;
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
    req.auth = await service.authenticate(token, bearer ? 'bearer' : 'cookie');
    if (req.auth.transport === 'cookie' && isUnsafe(req.method)) {
      const csrf = req.get('x-csrf-token');
      if (!csrf || !secureEqual(csrf, csrfForToken(token)))
        throw new ApiError(403, 'CSRF_INVALID', 'Refresh the application before trying again.');
    }
    next();
  };
}
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth?.user.permissions.includes(permission))
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Your account does not have permission to perform this action.',
      );
    next();
  };
