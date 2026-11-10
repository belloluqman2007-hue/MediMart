import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runNodeBin, runNpm } from './npm-run.mjs';

const root = resolve(import.meta.dirname, '..');
const development = process.argv.includes('--development');
runNpm(['run', development ? 'build:native-dev' : 'build', '-w', '@medimart/web'], { cwd: root });
// Invoke the Capacitor CLI directly: `npm exec` in a workspace plus the Windows `npm.cmd` shim is
// exactly the combination that fails on Windows (EINVAL when spawning a .cmd file).
// The Capacitor CLI entry point (a plain script, no .cmd shim).
const capCli = join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
if (!existsSync(capCli)) throw new Error(`The Capacitor CLI is missing at ${capCli}. Run npm ci.`);
// Capacitor resolves the platform project relative to the web application root (what
// `npm exec -w @medimart/web` used to set), not the repository root.
runNodeBin(capCli, ['sync', 'android'], {
  cwd: join(root, 'apps', 'web'),
  env: { MEDIMART_ANDROID_DEV_HTTP: development ? 'true' : 'false' },
});
console.log(
  development
    ? 'DEVELOPMENT ASSETS ONLY: HTTP is permitted on private LANs. Never distribute this as a release.'
    : 'Release-safe local assets synchronized. This does not build an APK.',
);
