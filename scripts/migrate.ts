import { openNodeDatabase } from '@medimart/database/node';
import { migrate } from '@medimart/database';
const db = openNodeDatabase(process.env.DATABASE_PATH || './var/medimart.sqlite');
try {
  await migrate(db);
  console.log('Database migrations are up to date.');
} finally {
  await db.close();
}
