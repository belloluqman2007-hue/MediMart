/**
 * Build the MediMart Windows desktop package.
 *
 * Produces a portable folder — unzip, double-click `MediMart.exe`. No Administrator rights, no
 * Windows Installer database and no code-signing certificate are required, which suits a shop
 * computer that may not have internet access.
 *
 * What goes in:
 *   resources/app      the Electron shell (main.mjs) and application icon
 *   resources/server   the built API bundle, runtime modules and the built web application
 *   electron.exe       renamed to MediMart.exe
 *
 * What does not go in: development tooling, test fixtures, source maps, `.env` files, or any
 * credential. The owner setup token is generated on the user's own machine at first start.
 *
 * Where it must be built and verified
 * -------------------------------
 * Both native modules (better-sqlite3, argon2) are ABI-stable N-API addons and ship per-platform
 * prebuilds inside their npm packages, so the staged tree is checked for a win32-x64 addon before
 * anything is zipped. Packaging can run on any host, but only a Windows machine can start the
 * result: the deliverable is the artifact built and smoke-tested by `.github/workflows/desktop.yml`
 * on `windows-latest`. Output produced elsewhere is labelled `verified: false` in the manifest and
 * must not be shipped without a Windows run.
 *
 * The Electron runtime is downloaded from the official Electron GitHub release over the pinned
 * version, with an optional `MEDIMART_ELECTRON_DIR` override for offline machines.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ELECTRON_VERSION = '38.4.0';
const outRoot = join(root, 'dist', 'desktop');
const stageDir = join(outRoot, 'electron-runtime');
const appDir = join(outRoot, 'MediMart-win32-x64');
const zipPath = join(outRoot, `MediMart-${pkg.version}-win-x64.zip`);
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

if (!isWindows) {
  console.warn(
    '\u26a0 Packaging a Windows distribution on ' +
      process.platform +
      '. The output is UNVERIFIED (\u201cverified: false\u201d in the manifest): only a Windows\n' +
      'machine can start MediMart.exe and smoke-test the package. Ship the artifact built and tested\n' +
      'by .github/workflows/desktop.yml, or run this script (and the packaged smoke test) on Windows.',
  );
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}) for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/** Copy a tree, following the workspace symlinks npm creates for local packages. */
function copyDir(source, destination) {
  cpSync(source, destination, { recursive: true, dereference: true });
}

/** Extract a zip with whatever the host provides (Windows ships bsdtar as `tar`). */
function extractZip(zip, destination) {
  mkdirSync(destination, { recursive: true });
  if (isWindows) execFileSync('tar', ['-xf', zip, '-C', destination], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', zip, '-d', destination], { stdio: 'inherit' });
}

function makeZip(zip, folderName, cwd) {
  rmSync(zip, { force: true });
  if (isWindows)
    execFileSync('tar', ['-a', '-c', '-f', zip, folderName], { cwd, stdio: 'inherit' });
  else execFileSync('zip', ['-qr', zip, folderName], { cwd, stdio: 'inherit' });
}

async function ensureElectronRuntime() {
  const override = process.env.MEDIMART_ELECTRON_DIR;
  if (override && existsSync(override)) return override;
  const local = join(root, 'node_modules', 'electron', 'dist');
  if (existsSync(join(local, 'electron.exe')) || existsSync(join(local, 'electron'))) return local;
  mkdirSync(outRoot, { recursive: true });
  if (!existsSync(join(stageDir, 'electron.exe'))) {
    const zip = join(outRoot, `electron-v${ELECTRON_VERSION}-win32-x64.zip`);
    if (!existsSync(zip)) {
      console.log(`Downloading the Electron ${ELECTRON_VERSION} Windows runtime…`);
      await download(
        `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`,
        zip,
      );
    }
    console.log('Extracting the Electron runtime…');
    rmSync(stageDir, { recursive: true, force: true });
    extractZip(zip, stageDir);
  }
  return stageDir;
}

/**
 * Verify the staged tree carries a loadable win32-x64 native addon for each native module. Both
 * are ABI-stable N-API addons (prebuildify) with per-platform prebuilds inside their packages —
 * the package is for Windows, so the win32-x64 addon must be present no matter which host packed
 * it. A missing addon means the server would not start; distribution is refused.
 */
function verifyNativeModules(target) {
  const betterSqlite = join(target, 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  const argon2Dir = join(target, 'argon2', 'prebuilds', 'win32-x64');
  const argon2Ok =
    (existsSync(argon2Dir) && readdirSync(argon2Dir).some((entry) => entry.endsWith('.node'))) ||
    existsSync(join(target, 'argon2', 'build', 'Release', 'argon2.node'));
  if (
    !existsSync(betterSqlite) &&
    !existsSync(join(target, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))
  )
    throw new Error(
      `No win32-x64 better-sqlite3 addon at ${betterSqlite}. Distribution refused: the server would not start.`,
    );
  if (!argon2Ok)
    throw new Error(
      'No win32-x64 argon2 addon (N-API prebuild or compiled build). Distribution refused.',
    );
  console.log(`    native addons staged: better-sqlite3 + argon2 (win32-x64, N-API)`);
}

/**
 * Copy the runtime module closure: the named packages plus every transitive runtime dependency,
 * resolved against the flat root node_modules. `dereference` flattens the workspace symlinks that
 * npm creates for local packages.
 */
function copyModules(target) {
  const roots = [
    'better-sqlite3',
    'argon2',
    'express',
    'express-rate-limit',
    'helmet',
    'zod',
    'bindings',
    'file-uri-to-path',
    'prebuild-install',
    'node-addon-api',
    'node-gyp-build',
  ];
  mkdirSync(target, { recursive: true });
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const source = join(root, 'node_modules', name);
    if (!existsSync(source)) continue;
    copyDir(source, join(target, name));
    const manifest = join(source, 'package.json');
    if (!existsSync(manifest)) continue;
    const dependencies = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
    queue.push(...Object.keys(dependencies));
  }
  // A deliverable must carry a loadable win32-x64 addon for each native module (N-API prebuild
  // or compiled build). Distribution is refused without them.
  verifyNativeModules(target);
}

async function main() {
  const runtime = await ensureElectronRuntime();

  console.log('1/5 Building the web application and the API bundle…');
  execFileSync(npm, ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });

  console.log('2/5 Staging the Electron runtime…');
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  copyDir(runtime, appDir);
  // The runtime shipped for development may include a default app; the shell replaces it.
  rmSync(join(appDir, 'resources', 'default_app.asar'), { force: true });

  console.log('3/5 Copying the shell, server bundle and web build…');
  const resources = join(appDir, 'resources');
  mkdirSync(join(resources, 'app'), { recursive: true });
  mkdirSync(join(resources, 'server'), { recursive: true });
  copyDir(join(root, 'apps', 'desktop', 'main.mjs'), join(resources, 'app', 'main.mjs'));
  copyDir(join(root, 'apps', 'desktop', 'package.json'), join(resources, 'app', 'package.json'));
  const iconDir = join(root, 'apps', 'desktop', 'assets');
  if (!existsSync(join(iconDir, 'icon.png'))) {
    throw new Error('Missing apps/desktop/assets/icon.png. Run: node scripts/generate-icons.mjs');
  }
  copyDir(iconDir, join(resources, 'app', 'assets'));
  // Windows picks the taskbar icon from the executable; the runtime ships a generic one. The
  // .exe is not rewritten (that would need a resource editor and code signing), so the window and
  // taskbar icon come from the BrowserWindow icon above, and Setup/desktop shortcuts use the PNGs.
  for (const size of [256, 128, 64]) {
    const candidate = join(iconDir, `icon-${size}.png`);
    if (existsSync(candidate))
      copyDir(candidate, join(resources, 'app', 'assets', `icon-${size}.png`));
  }
  copyDir(join(root, 'apps', 'api', 'dist'), join(resources, 'server'));
  mkdirSync(join(resources, 'server', 'apps', 'web'), { recursive: true });
  copyDir(join(root, 'apps', 'web', 'dist'), join(resources, 'server', 'apps', 'web', 'dist'));
  writeFileSync(
    join(resources, 'app', 'package.json'),
    JSON.stringify(
      {
        name: 'medimart-desktop',
        productName: 'MediMart',
        version: pkg.version,
        main: 'main.mjs',
        type: 'module',
      },
      null,
      2,
    ),
  );
  copyModules(join(resources, 'server', 'node_modules'));

  console.log('4/5 Naming the launcher…');
  const electronExe = join(appDir, 'electron.exe');
  const launcher = join(appDir, 'MediMart.exe');
  if (existsSync(electronExe)) renameSync(electronExe, launcher);
  if (!existsSync(launcher))
    throw new Error('Electron binary missing from the staged runtime. Distribution refused.');

  console.log('5/5 Writing the manifest and the distributable zip…');
  writeFileSync(
    join(outRoot, 'build-manifest.json'),
    JSON.stringify(
      {
        name: 'MediMart',
        version: pkg.version,
        platform: 'win32-x64',
        electron: ELECTRON_VERSION,
        builtAt: new Date().toISOString(),
        builtOn: isWindows ? 'win32' : process.platform,
        verified: isWindows,
        nativeAddons: 'better-sqlite3 + argon2 (win32-x64 N-API prebuilds, staged and checked)',
        entry: 'MediMart.exe',
        server: 'resources/server/index.js',
        web: 'resources/server/apps/web/dist',
        dataDirectory: '%APPDATA%\\MediMart\\data',
        backupDirectory: '%APPDATA%\\MediMart\\backups',
      },
      null,
      2,
    ),
  );
  makeZip(zipPath, 'MediMart-win32-x64', outRoot);
  console.log('Desktop package:', appDir);
  console.log(
    'Distributable:  ',
    zipPath,
    `(${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`,
  );
  if (!isWindows)
    console.log(
      'REMINDER: packaged on ' +
        process.platform +
        ' — verified: false. Ship the artifact built and smoke-tested by .github/workflows/desktop.yml.',
    );
}

await main();
