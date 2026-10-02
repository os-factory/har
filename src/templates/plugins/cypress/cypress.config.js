// Cypress config for the HAR `cypress-e2e` verification stage.
//
// Harness integration
// -------------------
// - Stage id: `cypress-e2e` (`.har/stages/cypress-e2e.sh`, registered in `stages.json`).
// - Runs on FULL verify only — not on quick verify:
//     har env verify <id> --full
// - Quick verify stops at the quick-tier stages (typecheck, unit tests, api-health).
//
// Prerequisites
// -------------
// 1. Launch a slot first:  har env launch <id>
// 2. Install Cypress:       npm install && npx cypress verify
//    The Cypress npm package downloads the Electron binary. On Linux, system
//    libraries from the Cypress docs may also be required.
//
// Environment (injected by cypress-e2e.sh — never hardcode slot ports in specs)
// ------------------------------------------------------------------------------
// CYPRESS_BASE_URL   Frontend origin for cy.visit('/') (slot FE port)
// CYPRESS_API_URL    API origin for cy.request (Cypress.env('API_URL'))
// CYPRESS_HEALTH_PATH  Health path (Cypress.env('HEALTH_PATH'), default /health)
// HARNESS_CYPRESS_ARTIFACT_DIR  Absolute artifact directory for this run
// HARNESS_CYPRESS_BROWSER       Browser name passed to `cypress run` (default electron)
//
// Test layout — agents must add or update specs for every UI change
// ------------------------------------------------------------------
// cypress/e2e/<feature>.cy.js   End-to-end flows (prefer one file per feature)
//
// Full verify only proves existing specs pass. New UI behavior needs new or
// updated specs here — the harness does not auto-generate flows per feature.
// Widen `specPattern` to `cypress/e2e/**/*.cy.{js,jsx,ts,tsx}` when you add
// TypeScript specs.
//
// Artifacts (gitignored under .har/artifacts/)
// --------------------------------------------
// cypress-e2e/cypress.log     Runner log
// cypress-e2e/screenshots/    Failure screenshots (cypress run)
// cypress-e2e/videos/         Videos when `video: true` (off by default)
//
// Local-only (without cypress-e2e.sh):  npm run test:cypress
// Set CYPRESS_BASE_URL (and CYPRESS_API_URL if split) when the app is not on
// the default below.
const path = require('path');
const { defineConfig } = require('cypress');

const baseUrl = process.env.CYPRESS_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
const artifactDir =
  process.env.HARNESS_CYPRESS_ARTIFACT_DIR || path.join('.har', 'artifacts', 'cypress-e2e');

module.exports = defineConfig({
  e2e: {
    baseUrl,
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    fixturesFolder: false,
    screenshotsFolder: path.join(artifactDir, 'screenshots'),
    videosFolder: path.join(artifactDir, 'videos'),
    downloadsFolder: path.join(artifactDir, 'downloads'),
    video: false,
    screenshotOnRunFailure: true,
  },
});
