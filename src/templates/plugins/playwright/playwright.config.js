// Playwright config for the HAR `browser-e2e` verification stage.
//
// Harness integration
// -------------------
// - Stage id: `browser-e2e` (`.har/stages/browser-e2e.sh`, registered in `stages.json`).
// - Runs automatically on FULL verify only — not on quick verify:
//     har env verify <id> --full
//     har env verify <id> --full
//     har env complete <id>          # always full; required before declaring done
// - Quick verify (`verify.sh <id>`) stops at typecheck / unit tests / api-health.
//
// Prerequisites
// -------------
// 1. Launch a slot first:     har env launch <id>
// 2. Install browsers once:     npx playwright install chromium
//
// Environment (injected by browser-e2e.sh — never hardcode slot ports in specs)
// ------------------------------------------------------------------------------
// BASE_URL       Frontend origin for page.goto('/') and UI specs
// API_URL        API origin for tests/api (defaults to BASE_URL when FE/API share a port)
// PW_SCREENSHOT  Playwright screenshot mode (default: on)
// CI             Set in CI for retries, worker cap, and forbidOnly
//
// Test layout — agents must add or update specs for every UI change
// ------------------------------------------------------------------
// tests/frontend/<feature>.spec.js   UI flows (prefer one file per feature)
// tests/api/                         HTTP checks via the request fixture
// tests/a11y/                        axe-core on key routes
//
// Full verify only proves existing specs pass. New UI behavior needs new or
// updated specs here — the harness does not auto-generate flows per feature.
//
// Artifacts (gitignored under .har/artifacts/)
// --------------------------------------------
// browser-e2e/playwright-report/   HTML report after full verify
// browser-e2e/test-results/        traces, screenshots, videos on failure
//
// Local-only (without browser-e2e.sh):  npm run test:e2e
// Set BASE_URL (and API_URL if split) when the app is not on the default below.
const { defineConfig, devices } = require('@playwright/test');

const baseURL = process.env.BASE_URL || 'http://localhost:3000';
const apiURL = process.env.API_URL || baseURL;

module.exports = defineConfig({
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
    baseURL,
    headless: true,
    screenshot: process.env.PW_SCREENSHOT || 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'frontend',
      testDir: './tests/frontend',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'api',
      testDir: './tests/api',
      use: { baseURL: apiURL },
    },
    {
      name: 'a11y',
      testDir: './tests/a11y',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
