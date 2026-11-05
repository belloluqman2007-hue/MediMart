import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from '@medimart/database';
import { openNodeDatabase } from '@medimart/database/node';
import { createApp } from '../apps/api/src/app';
import type { ApiConfig } from '../apps/api/src/config';
// Disposable fixture database. Never read .env or point this runner at the application DB.
const path = resolve('.artifacts/e2e/server.sqlite');
mkdirSync(resolve('.artifacts/e2e'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
const db = openNodeDatabase(path);
await migrate(db);
const config: ApiConfig = {
  environment: 'test',
  host: '0.0.0.0',
  port: 4173,
  databasePath: path,
  bootstrapToken: 'e2e-only-not-a-real-credential-00000000000000',
  allowedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173', 'https://localhost'],
  trustProxyHops: 0,
  sessionHours: 8,
  secureCookies: false,
  // The browser suite signs in once per scenario; keep the 10-per-15-minute production default out of its way.
  authRateLimit: 200,
};
const server = createApp(db, config, resolve('apps/web/dist')).listen(config.port, config.host);
const stop = () =>
  server.close(() => {
    void db.close().then(() => process.exit(0));
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
