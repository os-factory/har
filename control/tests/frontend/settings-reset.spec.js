const { test, expect } = require('@playwright/test');

test.describe('Settings reset', () => {
  test('settings page exposes clear-all danger zone', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Trajectory storage' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();

    const openButton = page.getByRole('button', { name: /clear all data/i });
    await expect(openButton).toBeVisible();
    await openButton.click();

    await expect(page.getByRole('heading', { name: /clear mission control data/i })).toBeVisible();
    await expect(page.getByText(/Type RESET to confirm/i)).toBeVisible();

    const confirm = page.getByLabel(/Type RESET to confirm/i);
    const submit = page.getByRole('button', { name: 'Clear all data', exact: true });
    await expect(submit).toBeDisabled();

    await confirm.fill('RESET');
    await expect(submit).toBeEnabled();
  });
});
