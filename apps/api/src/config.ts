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
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const value = envSchema.parse(env);
  const secureCookies = value.COOKIE_SECURE
    ? value.COOKIE_SECURE === 'true'
    : value.NODE_ENV === 'production';
  if (value.NODE_ENV === 'production' && !secureCookies)
    throw new Error('Production requires secure cookies and HTTPS.');
  const allowedOrigins = value.ALLOWED_ORIGINS.split(',').map((s) => new URL(s.trim()).origin);
  if (value.NODE_ENV === 'production' && allowedOrigins.some((s) => !s.startsWith('https://')))
    throw new Error('Production allowed origins must use HTTPS.');
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
  };
}
