import { z } from 'zod';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./var/medimart.sqlite'),
  BOOTSTRAP_TOKEN: z.union([z.literal(''), z.string().min(32).max(128)]).default(''),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:3001,https://localhost'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** Folder for written backups. The desktop shell points this at the user's Documents folder. */
  BACKUP_DIR: z.string().min(1).default('./var/backups'),
  /**
   * Set by the packaged desktop application. It allows preparing an in-app restore (the shell
   * performs the file swap at the next controlled start) and is never enabled by a plain server.
   */
  MEDIMART_MANAGED_DESKTOP: z.enum(['true', 'false']).default('false'),
  /** Enables the bundled-desktop origin allowance for the packaged application only. */
  DESKTOP_ALLOWED_ORIGINS: z.string().default(''),
  /**
   * Explicit owner opt-in for unencrypted HTTP on a private shop network so Android devices can
   * reach the central computer without internet or a purchased certificate.
   */
  MEDIMART_ALLOW_LAN_HTTP: z.enum(['true', 'false']).default('false'),
});
export interface ApiConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  bootstrapToken: string;
  allowedOrigins: string[];
  trustProxyHops: number;
  sessionHours: number;
  secureCookies: boolean;
  /** Authentication attempts allowed per 15-minute window. Production uses the default of 10. */
  authRateLimit?: number;
  /**
   * General API requests allowed per minute, per client. Production uses the default of 300. Only
   * the disposable end-to-end test server raises it, because one suite makes hundreds of requests
   * from a single address; the production default is never relaxed by this.
   */
  apiRateLimit?: number;
  /** Absolute or relative folder where backup files are written. */
  backupDir: string;
  /** True only when started by the packaged desktop shell. */
  managedDesktop: boolean;
  /** Extra origins (the packaged desktop application) trusted in addition to ALLOWED_ORIGINS. */
  desktopOrigins: string[];
  /** True when the owner explicitly enabled unencrypted local-network HTTP. */
  allowLanHttp: boolean;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const value = envSchema.parse(env);
  const secureCookies = value.COOKIE_SECURE
    ? value.COOKIE_SECURE === 'true'
    : value.NODE_ENV === 'production';
  const managedDesktop = value.MEDIMART_MANAGED_DESKTOP === 'true';
  const allowLanHttp = value.MEDIMART_ALLOW_LAN_HTTP === 'true';
  /*
   * Production normally requires HTTPS and Secure cookies. Two explicit, documented exceptions
   * exist for a shop computer with no internet access:
   *   - the packaged desktop application talking to its own loopback server, and
   *   - an owner opt-in for private-network HTTP so Android devices can reach the shop computer.
   * Both are refused unless the configuration says so, and both are recorded in the security docs.
   */
  if (value.NODE_ENV === 'production' && !secureCookies && !managedDesktop && !allowLanHttp)
    throw new Error('Production requires secure cookies and HTTPS.');
  const desktopOrigins = value.DESKTOP_ALLOWED_ORIGINS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => new URL(entry).origin);
  const allowedOrigins = [
    ...value.ALLOWED_ORIGINS.split(',').map((s) => new URL(s.trim()).origin),
    ...desktopOrigins,
  ];
  if (value.NODE_ENV === 'production' && allowedOrigins.some((s) => !s.startsWith('https://'))) {
    const loopback = (origin: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    const tolerated = allowedOrigins.every(
      (s) => s.startsWith('https://') || (managedDesktop && loopback(s)),
    );
    if (!tolerated)
      throw new Error(
        'Production allowed origins must use HTTPS. Set MEDIMART_MANAGED_DESKTOP=true only for the packaged desktop application.',
      );
  }
  return {
    environment: value.NODE_ENV,
    host: value.API_HOST,
    port: value.API_PORT,
    databasePath: value.DATABASE_PATH,
    bootstrapToken: value.BOOTSTRAP_TOKEN,
    allowedOrigins,
    trustProxyHops: value.TRUST_PROXY_HOPS,
    sessionHours: value.SESSION_HOURS,
    secureCookies,
    backupDir: value.BACKUP_DIR,
    managedDesktop,
    desktopOrigins,
    allowLanHttp,
  };
}
