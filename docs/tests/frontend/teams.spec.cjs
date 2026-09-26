const { test, expect } = require('@playwright/test');

test.describe('Teams', () => {
  test('nav points at HAR HQ', async ({ page }) => {
    await page.goto('/');
    const teams = page.getByRole('link', { name: 'Teams' }).first();
    await expect(teams).toBeVisible();
    await expect(teams).toHaveAttribute('href', 'https://harhq.com/');
    await expect(teams).toHaveAttribute('target', '_blank');
  });

  test('legacy /enterprise/ redirects to HAR HQ', async ({ request }) => {
    const response = await request.get('/enterprise/', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe('https://harhq.com/');
  });
});
