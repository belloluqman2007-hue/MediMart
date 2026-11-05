import chromium from '@sparticuz/chromium';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import type { LaunchOptions } from '@playwright/test';
/** Optional npm-distributed browser for restricted sandboxes. Normal CI uses Playwright's browser. */
export async function sandboxBrowserOptions(): Promise<LaunchOptions> {
  const require = createRequire(import.meta.url);
  const location = dirname(require.resolve('@sparticuz/chromium'));
  const { inflate } = (await import(pathToFileURL(resolve(location, 'lambdafs.js')).href)) as {
    inflate(path: string): Promise<string>;
  };
  await inflate(resolve(location, '../bin/al2023.tar.br'));
  return {
    executablePath: await chromium.executablePath(),
    // Keep web security ON; disabling it would invalidate browser security checks.
    args: chromium.args.filter(
      (arg) =>
        ![
          '--disable-web-security',
          '--allow-running-insecure-content',
          '--single-process',
        ].includes(arg),
    ),
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [join(tmpdir(), 'al2023/lib'), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(':'),
    } as Record<string, string>,
    headless: true,
  };
}
