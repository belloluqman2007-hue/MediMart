import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig(({ mode, command }) => {
  // Read only proxy configuration without leaking the API's NODE_ENV into Vite builds.
  const envPath = resolve(import.meta.dirname, '../../.env');
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return {
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
