import { defineConfig } from '@playwright/test';
import { sandboxBrowserOptions } from './scripts/browser-options';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // In CI, the github reporter attaches each failing test as an annotation, so a failure names
  // itself even when the log download is unavailable.
  reporter: process.env.GITHUB_ACTIONS
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions:
      process.env.MEDIMART_SANDBOX_BROWSER === '1' ? await sandboxBrowserOptions() : {},
  },
  webServer: {
    command: 'node --import=tsx scripts/test-server.ts',
    url: 'http://localhost:4173/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
