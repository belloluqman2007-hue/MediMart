import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Identity of the bundle being built, compiled into it as `__MEDIMART_BUILD__`.
 *
 * This exists because of a real support dead end: a shop owner installed an APK, saw the
 * "Local storage needs attention" screen, and there was **no way to tell which build was on the
 * phone** — the two APKs available that day reported the same `versionName 0.2.0` / `versionCode 2`
 * while containing different start-up code. A diagnostic code says what failed; the build stamp
 * says which code was running when it failed. Both are needed before anyone can answer "why".
 *
 * Nothing secret is stamped: a package version, a public commit hash, a timestamp and the Vite
 * mode. The commit is read from the checkout; when there is no Git repository (a source tarball) it
 * degrades to `unknown` rather than failing the build.
 */
function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode, command }) => {
  // Read only proxy configuration without leaking the API's NODE_ENV into Vite builds.
  const envPath = resolve(import.meta.dirname, '../../.env');
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  // The canonical application version is the root package version; `tests/build-identity.test.ts`
  // asserts the Android `versionName` equals it, so the phone's app-info screen and the failure
  // screen can never disagree.
  const rootPackage = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
  ) as { version?: string };
  const buildStamp = {
    version: rootPackage.version ?? '0.0.0',
    commit: gitCommit(),
    builtAt: new Date().toISOString(),
    profile: mode,
  };
  return {
    define: { __MEDIMART_BUILD__: JSON.stringify(buildStamp) },
    plugins: [
      react(),
      {
        name: 'bundled-application-csp',
        transformIndexHtml() {
          if (command === 'serve') return [];
          const connect = mode === 'native-development' ? "'self' https: http:" : "'self' https:";
          return [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'`,
              },
              injectTo: 'head-prepend' as const,
            },
          ];
        },
      },
    ],
    base: './',
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: ['.e2b.app', 'localhost'],
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://127.0.0.1:3001',
          changeOrigin: false,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'react-vendor',
                test: /node_modules\/(react|react-dom|react-router|scheduler)(\/|-)/,
              },
              { name: 'validation', test: /node_modules\/zod\// },
            ],
          },
        },
      },
    },
  };
});
