import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Exercise the compiled entry point, not tsx/source imports. Native addons must stay external.
const directory = mkdtempSync(join(tmpdir(), 'medimart-production-smoke-'));
const reservation = createServer();
reservation.listen(0, '0.0.0.0');
await once(reservation, 'listening');
const port = (reservation.address() as AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    API_HOST: '0.0.0.0',
    API_PORT: String(port),
    DATABASE_PATH: join(directory, 'smoke.sqlite'),
    BOOTSTRAP_TOKEN: '',
    ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
try {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Compiled server did not start: ${output}`)),
      15_000,
    );
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('MediMart API listening')) {
        clearTimeout(deadline);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`Compiled server exited with ${code}: ${output}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { database: string }).database, 'ready');
  const htmlResponse = await fetch(base, { signal: AbortSignal.timeout(5000) });
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert(html.includes('Content-Security-Policy'));
  const asset = html.match(/src="(\.\/assets\/[^"]+\.js)"/)?.[1];
  assert(asset, 'The production HTML must reference a bundled JavaScript entry.');
  assert.equal((await fetch(new URL(asset, `${base}/`))).status, 200);
  assert.equal((await fetch(`${base}/assets/missing-asset.js`)).status, 404);
  const missingApi = await fetch(`${base}/api/missing`);
  assert.equal(missingApi.status, 404);
  assert((missingApi.headers.get('content-type') || '').includes('application/json'));
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  console.log(
    'Compiled API smoke check passed: native SQLite startup, migrations, health, bundled UI/assets, service worker, and JSON/asset 404 boundaries.',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    await exit;
    clearTimeout(force);
  }
  rmSync(directory, { recursive: true, force: true });
}
