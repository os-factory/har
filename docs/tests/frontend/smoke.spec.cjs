const { test, expect } = require('@playwright/test');

test.describe('Frontend smoke', () => {
  test('landing page loads with brand hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1')).toContainText(
      'The open harness for multi-agent coding workflows',
    );
    await expect(page.getByRole('link', { name: /Read the docs/i })).toBeVisible();
  });

  test('docs introduction is reachable', async ({ page }) => {
    await page.goto('/docs/getting-started/introduction/');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
  });
});
