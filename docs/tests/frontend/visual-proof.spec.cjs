const { test, expect } = require('@playwright/test');
const { capturePageScreenshot } = require('../playwright/capture.cjs');

/**
 * Visual proof screenshots for session handoff.
 *
 * Launch runs this with PW_SCREENSHOT_PHASE=before.
 * Full verify / browser-e2e runs it with PW_SCREENSHOT_PHASE=after.
 *
 * When you change a page's UI, update assertions here (or add a feature-specific
 * spec under tests/frontend/) so the after screenshot reflects the completed work.
 */
test.describe('Visual proof screenshots', () => {
  test.beforeEach(async ({ page }) => {
    // Avoid third-party / media stalls during capture.
    await page.route(
      /(?:posthog|googletagmanager|google-analytics|youtube|youtu\.be|web3forms|doubleclick)/i,
      (route) => route.abort(),
    );
  });

  test('landing page full-page shot', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText(
      'The open harness for multi-agent coding workflows',
    );
    await page.locator('.hero').waitFor({ state: 'visible' });
    // Let reveal animations settle so shots are stable.
    await page.waitForTimeout(800);
    const file = await capturePageScreenshot(page, testInfo, 'landing');
    expect(file).toBeTruthy();
  });

  test('docs introduction full-page shot', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('/docs/getting-started/introduction/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
    const file = await capturePageScreenshot(page, testInfo, 'docs-introduction');
    expect(file).toBeTruthy();
  });
});
