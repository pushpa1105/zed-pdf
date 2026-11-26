import { defineConfig } from '@playwright/test';

// Deterministic settings: fixed viewport, local fonts/assets, pinned Playwright 1.65.1 browsers.
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.mjs',
  timeout: 120_000,
  workers: 4,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4791', viewport: { width: 1200, height: 900 } },
  webServer: { command: 'node scripts/serve.mjs 4791', url: 'http://127.0.0.1:4791/fixtures/invoice.html', reuseExistingServer: true },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, grep: /@compat/ },
    { name: 'webkit', use: { browserName: 'webkit' }, grep: /@compat/ },
  ],
});
