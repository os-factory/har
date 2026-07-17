const { test, expect } = require('@playwright/test');

test.describe('Worktrees home', () => {
  test('shows worktrees heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Worktrees' })).toBeVisible();
  });

  test('renders worktrees table or empty active sessions', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Active sessions')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('sidebar lists Worktrees, Usage, and Repositories', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Worktrees', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Repositories', exact: true })).toBeVisible();
  });
});
