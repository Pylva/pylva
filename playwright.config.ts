import { defineConfig, devices } from '@playwright/test';

// Frontend launch §12 — desktop + mobile smoke against a local dev / built
// server. Set `PLAYWRIGHT_BASE_URL` (default http://localhost:3000) to
// target a different origin in CI.
//
// The `setup` project mints an authenticated dashboard session (storageState)
// when E2E_DASHBOARD is set; without it, setup self-skips and the dashboard
// specs are skipped too, so the public-page smoke path is unaffected.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /setup\/.*\.setup\.ts/ },
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      dependencies: ['setup'],
    },
  ],
});
