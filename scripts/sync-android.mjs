import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const development = process.argv.includes('--development');
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(command, ['run', development ? 'build:native-dev' : 'build', '-w', '@medimart/web'], {
  stdio: 'inherit',
});
execFileSync(command, ['exec', '-w', '@medimart/web', '--', 'cap', 'sync', 'android'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: { ...process.env, MEDIMART_ANDROID_DEV_HTTP: development ? 'true' : 'false' },
  stdio: 'inherit',
});
console.log(
  development
    ? 'DEVELOPMENT ASSETS ONLY: HTTP is permitted on private LANs. Never distribute this as a release.'
    : 'Release-safe local assets synchronized. This does not build an APK.',
);
