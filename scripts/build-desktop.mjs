/**
 * Build the MediMart Windows desktop package.
 *
 * Produces a portable folder — unzip, double-click `MediMart.exe`. No Administrator rights, no
 * Windows Installer database and no code-signing certificate are required, which suits a shop
 * computer that may not have internet access.
 *
 * What goes in:
 *   resources/app      the Electron shell (main.mjs) and application icon
 *   resources/server   the built API bundle, native modules and the built web application
 *   electron.exe       renamed to MediMart.exe
 *
 * What does not go in: development tooling, test fixtures, source maps, `.env` files, or any
 * credential. The owner setup token is generated on the user's own machine at first start.
 *
 * The Electron runtime is downloaded from the official Electron GitHub release over the pinned
 * version, with an optional `MEDIMART_ELECTRON_DIR` override for offline machines.
 */
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}) for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
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
    mkdirSync(stageDir, { recursive: true });
    execFileSync('unzip', ['-q', zip, '-d', stageDir], { stdio: 'inherit' });
  }
  return stageDir;
}

function copyModules(target) {
  /*
   * Only runtime dependencies are copied: no dev tooling, no test fixtures, no source maps.
   * `dereference` flattens the workspace symlinks that npm creates for local packages.
   */
  const modules = [
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
  for (const name of modules) {
    const source = join(root, 'node_modules', name);
    if (!existsSync(source)) continue;
    execFileSync('cp', ['-RL', source, join(target, name)], { stdio: 'inherit' });
  }
  const nativeBuild = join(root, 'node_modules', 'better-sqlite3', 'build');
  if (existsSync(nativeBuild)) {
    rmSync(join(target, 'better-sqlite3', 'build'), { recursive: true, force: true });
    execFileSync('cp', ['-RL', nativeBuild, join(target, 'better-sqlite3', 'build')], {
      stdio: 'inherit',
    });
  }
}

async function main() {
  const runtime = await ensureElectronRuntime();

  console.log('1/5 Building the web application and the API bundle…');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });

  console.log('2/5 Staging the Electron runtime…');
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  execFileSync('cp', ['-RL', `${runtime}/.`, appDir], { stdio: 'inherit' });
  // The runtime shipped for development may include a default app; the shell replaces it.
  rmSync(join(appDir, 'resources', 'default_app.asar'), { force: true });

  console.log('3/5 Copying the shell, server bundle and web build…');
  const resources = join(appDir, 'resources');
  mkdirSync(join(resources, 'app'), { recursive: true });
  mkdirSync(join(resources, 'server'), { recursive: true });
  execFileSync('cp', ['-R', join(root, 'apps', 'desktop', 'main.mjs'), join(resources, 'app')]);
  execFileSync('cp', ['-R', join(root, 'apps', 'desktop', 'package.json'), join(resources, 'app')]);
  const iconDir = join(root, 'apps', 'desktop', 'assets');
  if (!existsSync(join(iconDir, 'icon.png'))) {
    throw new Error('Missing apps/desktop/assets/icon.png. Run: node scripts/generate-icons.mjs');
  }
  execFileSync('cp', ['-R', iconDir, join(resources, 'app', 'assets')]);
  // Windows picks the taskbar icon from the executable; the runtime ships a generic one. The
  // .exe is not rewritten (that would need a resource editor and code signing), so the window and
  // taskbar icon come from the BrowserWindow icon above, and Setup/desktop shortcuts use the PNGs.
  for (const size of [256, 128, 64]) {
    const candidate = join(iconDir, `icon-${size}.png`);
    if (existsSync(candidate))
      execFileSync('cp', [candidate, join(resources, 'app', 'assets', `icon-${size}.png`)]);
  }
  execFileSync('cp', ['-R', `${join(root, 'apps', 'api', 'dist')}/.`, join(resources, 'server')]);
  mkdirSync(join(resources, 'server', 'apps', 'web'), { recursive: true });
  execFileSync('cp', [
    '-R',
    `${join(root, 'apps', 'web', 'dist')}/.`,
    join(resources, 'server', 'apps', 'web', 'dist'),
  ]);
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
  console.log('    launcher:', existsSync(launcher) ? launcher : 'Electron binary missing');

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
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-qr', zipPath, 'MediMart-win32-x64'], { cwd: outRoot, stdio: 'inherit' });
  console.log('Desktop package:', appDir);
  console.log('Distributable:  ', zipPath);
}

await main();
