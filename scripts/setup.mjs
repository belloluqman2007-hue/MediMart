import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('.env already exists; no settings or secrets were overwritten.');
} else {
  const text = readFileSync('.env.example', 'utf8').replace(
    'BOOTSTRAP_TOKEN=',
    `BOOTSTRAP_TOKEN=${randomBytes(32).toString('hex')}`,
  );
  writeFileSync('.env', text, { mode: 0o600, flag: 'wx' });
  console.log(
    'Created .env with a one-time owner setup token. Read BOOTSTRAP_TOKEN locally when creating the first owner. Do not share or commit this file.',
  );
}
