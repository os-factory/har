// Playwright config for the docs site `browser-e2e` verification stage.
//
// Harness integration
// -------------------
// - Stage id: `browser-e2e` (`.har/stages/browser-e2e.sh`).
// - Runs on FULL verify only:
//     cd docs && har env verify <id> --full
//     ./.har/verify.sh <id> --full
// - Launch captures baseline screenshots ("before").
// - Full verify / browser-e2e captures "after" screenshots for the handoff.
//
// Environment (injected by harness — never hardcode slot ports)
// -------------------------------------------------------------
// BASE_URL              Site origin (Astro FE_PORT)
// API_URL               Same as BASE_URL for this site
// HARNESS_HEALTH_PATH   Liveness path (default `/`)
// PW_SCREENSHOT_PHASE   before | after
// PW_SCREENSHOT_DIR     Absolute dir for PNG output
//
// Test layout
// -----------
// tests/frontend/          UI flows — add a file per feature when changing UI
// tests/frontend/visual-proof.spec.cjs Full-page screenshots (visual-proof project)
// tests/api/               HTTP checks
// tests/a11y/              axe-core on key routes
//
// Artifacts (gitignored under docs/.har/artifacts/)
// ------------------------------------------------
// browser-e2e/screenshots/before/   Baseline at launch
// browser-e2e/screenshots/after/    Proof after the task (full verify)
// browser-e2e/playwright-report/    HTML report
const { defineConfig, devices } = require('@playwright/test');

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4321';
const apiURL = process.env.API_URL || baseURL;

module.exports = defineConfig({
  timeout: 45 * 1000,
  expect: { timeout: 8000 },
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
      testIgnore: ['**/visual-proof.spec.cjs'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'visual-proof',
      testDir: './tests/frontend',
      testMatch: '**/visual-proof.spec.cjs',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'api',
      testDir: './tests/api',
      use: { baseURL: apiURL },
    },
    // Optional: npm run test:e2e:a11y — not in default browser-e2e (marketing
    // palette + interactive hero have known axe debt; fix in a dedicated pass).
    {
      name: 'a11y',
      testDir: './tests/a11y',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
