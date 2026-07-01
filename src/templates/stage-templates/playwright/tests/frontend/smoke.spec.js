const { test, expect } = require('@playwright/test');

// TODO: adapt heading text and routes for your app
test.describe('Frontend smoke', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  });
});
