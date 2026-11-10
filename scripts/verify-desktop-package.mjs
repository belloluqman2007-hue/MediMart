/**
 * Static verification of a packaged Windows desktop application.
 *
 * Answers one question without needing Windows: does `dist/desktop/MediMart-win32-x64` contain
 * everything the shell, the server and the native modules need to run? It cannot prove the window
 * opens — only `scripts/verify-desktop-runtime`-style execution inside the packaged MediMart.exe on
 * Windows does that (see `.github/workflows/desktop.yml`) — but it catches a missing bundle, a
 * missing native addon or a leaked secret before an artifact is uploaded.
 *
 * Usage: node scripts/verify-desktop-package.mjs [packageDir]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appDir = resolve(root, process.argv[2] ?? 'dist/desktop/MediMart-win32-x64');
const problems = [];

const requireFile = (relative, description) => {
  const full = join(appDir, relative);
  if (!existsSync(full)) problems.push(`missing ${relative} (${description})`);
  return existsSync(full);
};

console.log(`Verifying the Windows package at ${appDir}`);

requireFile('MediMart.exe', 'the Electron runtime, renamed so the shop sees one obvious program');
requireFile('resources/app/package.json', 'tells Electron which entry point to run');
requireFile('resources/app/launch.mjs', 'the launcher Electron executes');
requireFile('resources/app/main.mjs', 'the desktop shell (window + local server)');
requireFile('resources/app/assets/icon.png', 'the window and taskbar icon');
requireFile('resources/server/index.js', 'the compiled MediMart API');
requireFile('resources/server/apps/web/dist/index.html', 'the built interface the server serves');
requireFile('resources/server/node_modules/better-sqlite3/package.json', 'the database driver');
requireFile('resources/server/node_modules/argon2/package.json', 'password hashing');
requireFile('resources/server/node_modules/express/package.json', 'the HTTP server');

const entryManifest = join(appDir, 'resources', 'app', 'package.json');
if (existsSync(entryManifest)) {
  const manifest = JSON.parse(readFileSync(entryManifest, 'utf8'));
  if (manifest.main !== 'launch.mjs')
    problems.push(`resources/app/package.json main is "${manifest.main}", expected "launch.mjs"`);
  if (manifest.type !== 'module')
    problems.push('resources/app/package.json must declare type: module');
}

// Native addons must be the Windows build, whatever host produced the package.
const sqlitePrebuild = join(
  appDir,
  'resources/server/node_modules/better-sqlite3/prebuilds/win32-x64.node',
);
if (!existsSync(sqlitePrebuild)) problems.push('missing better-sqlite3 win32-x64 prebuild');
const argon2PrebuildDir = join(appDir, 'resources/server/node_modules/argon2/prebuilds/win32-x64');
if (
  !existsSync(argon2PrebuildDir) ||
  !readdirSync(argon2PrebuildDir).some((entry) => entry.endsWith('.node'))
)
  problems.push('missing argon2 win32-x64 prebuild');

// The interface must reference assets that are actually present.
const indexHtml = join(appDir, 'resources/server/apps/web/dist/index.html');
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8');
  const assets = [...html.matchAll(/["'](\.\/assets\/[^"']+)["']/g)].map((match) => match[1]);
  if (assets.length === 0) problems.push('the built index.html references no bundled asset');
  for (const asset of assets) {
    const full = join(appDir, 'resources/server/apps/web/dist', asset.replace('./', ''));
    if (!existsSync(full)) problems.push(`index.html references a missing asset: ${asset}`);
  }
}

// Credential-shaped files must never be packaged.
const forbidden = /(^|[\\/])\.env($|\.)|\.(jks|keystore|p12|pfx|pem|key)$|id_rsa/i;
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (forbidden.test(full)) problems.push(`credential-shaped file packaged: ${full}`);
  }
};
if (existsSync(appDir)) walk(appDir);

if (problems.length) {
  console.error('\nThe Windows package is incomplete:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const size = (directory) => {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    total += entry.isDirectory() ? size(full) : statSync(full).size;
  }
  return total;
};
console.log(
  `Windows package verified: every required file, both win32-x64 native addons and the built interface are present (${(size(appDir) / 1024 / 1024).toFixed(0)} MB).`,
);
console.log(
  'This check does not start the application. Only the Windows job in .github/workflows/desktop.yml does that.',
);
