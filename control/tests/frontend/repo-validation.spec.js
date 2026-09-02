const { test, expect } = require('@playwright/test');

// Exercises the Validation tab on the repository detail page.
// Resilient to an empty DB by skipping when no repository rows exist.

test.describe('Repository validation stages', () => {
  test('validation tab lists stages with a status per row', async ({ page }) => {
    await page.goto('/repos');

    const repoLink = page.locator('tbody a[href^="/repos/"]').first();
    if (!(await repoLink.isVisible().catch(() => false))) {
      test.skip(true, 'No repositories registered — no detail page to open');
    }

    await repoLink.click();
    await page.waitForURL(/\/repos\/[^/]+$/);

    const validationTab = page.getByRole('tab', { name: 'Validation' });
    await expect(validationTab).toBeVisible();
    await validationTab.click();

    await expect(page.getByText('Validation stages', { exact: true })).toBeVisible();

    const panel = page.getByRole('tabpanel');
    const table = panel.getByRole('table');
    if (!(await table.isVisible().catch(() => false))) {
      // Repo without declared verificationStages shows the empty state instead.
      // The empty copy can appear more than once (stages list + pipeline).
      await expect(panel.getByText(/no validation stages declared/i).first()).toBeVisible();
      return;
    }

    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    // Every stage row carries one of the status badges.
    const badges = table.getByText(/^(Passed|Failed|Not run)$/);
    expect(await badges.count()).toBeGreaterThanOrEqual(await rows.count());
  });
});

test('validation tab can be deep-linked with ?tab=validation', async ({ page }) => {
  await page.goto('/repos');
  const first = page.locator('tbody a[href^="/repos/"]').first();
  if ((await first.count()) === 0) test.skip(true, 'No repositories');
  const href = await first.getAttribute('href');
  await page.goto(`${href}?tab=validation`);
  await expect(page.getByRole('tab', { name: 'Validation' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Slots' }).click();
  await expect(page).not.toHaveURL(/tab=validation/);
});
