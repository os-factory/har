const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, '../../.har/artifacts');
const SCREENSHOT_PATH = path.join(SCREENSHOT_DIR, 'validation-pipeline-preview.png');

test.describe('Validation pipeline visual', () => {
  test('capture validation pipeline screenshot', async ({ page }) => {
    await page.goto('/repos');

    const repoLink = page.locator('tbody a[href^="/repos/"]').first();
    if (!(await repoLink.isVisible().catch(() => false))) {
      test.skip(true, 'No repositories registered — no detail page to open');
    }

    await repoLink.click();
    await page.waitForURL(/\/repos\/[^/]+$/);

    const validationTab = page.getByRole('tab', { name: 'Validation' });
    await validationTab.click();

    // Repos without declared verificationStages have no flow canvas.
    if (await page.getByText(/no validation stages declared/i).first().isVisible().catch(() => false)) {
      test.skip(true, 'No validation pipeline for this repository');
    }

    await expect(page.getByTestId('validation-pipeline')).toBeVisible();

    const firstNode = page.locator('.react-flow__node').first();
    if (!(await firstNode.isVisible().catch(() => false))) {
      test.skip(true, 'No validation pipeline nodes for this repository');
    }

    // The flow canvas measures custom node dimensions before it can lay out
    // handles and fit the viewport — wait for it to settle before capturing.
    await expect(firstNode).toBeVisible();
    await page.waitForTimeout(300);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const panel = page.getByRole('tabpanel');
    await panel.screenshot({ path: SCREENSHOT_PATH });
  });
});
