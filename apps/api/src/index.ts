import { resolve } from 'node:path';
import { openNodeDatabase } from '@medimart/database/node';
import { migrate } from '@medimart/database';
import { createApp } from './app';
import { loadConfig } from './config';
// Restrict new DB/WAL/SHM files and private configuration on POSIX systems.
process.umask(0o077);
const config = loadConfig();
const db = openNodeDatabase(config.databasePath);
try {
  await migrate(db);
  const app = createApp(db, config, resolve(process.cwd(), 'apps/web/dist'));
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `MediMart API listening on ${config.host}:${config.port}. Database migrations are current.`,
    );
    if (config.environment !== 'production')
      console.log(
        'Development/test HTTP configuration. Use HTTPS and secure cookies before handling real business or patient data.',
      );
    if (!config.bootstrapToken)
      console.log(
        'Owner setup is disabled without BOOTSTRAP_TOKEN. Existing users can still sign in.',
      );
  });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    console.log('MediMart is shutting down.');
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      void db.close().then(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
    });
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  server.on('error', (error) => {
    console.error(`Server startup failed: ${error.message}`);
    void db.close().finally(() => process.exit(1));
  });
} catch (error) {
  console.error(
    `Database startup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
  );
  await db.close();
  process.exitCode = 1;
}
