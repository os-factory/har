// Playwright config tuned for HAR agent slots and CI.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30 * 1000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.har/artifacts/browser-e2e/playwright-report' }],
  ],
  outputDir: '.har/artifacts/browser-e2e/test-results',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3847',
    headless: true,
    screenshot: process.env.PW_SCREENSHOT || 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
