const { test, expect } = require('@playwright/test');

test.describe('Repositories home', () => {
  test('shows repositories heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  });

  test('renders repositories table or empty state', async ({ page }) => {
    await page.goto('/');
    const table = page.getByRole('table');
    const empty = page.getByText(/no repositories registered/i);
    await expect(table.or(empty)).toBeVisible();
  });
});
