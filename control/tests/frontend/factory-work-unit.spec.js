const { test, expect } = require('@playwright/test');

test.describe('Factory work unit detail', () => {
  test('work unit page shows overview sections instead of timeline-only', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible();

    const unitLink = page.locator('a[href^="/factory/"]').first();
    if ((await unitLink.count()) === 0) {
      test.skip(true, 'No synchronized work units in this environment');
    }

    await unitLink.click();
    await page.waitForURL(/\/factory\//, { timeout: 10_000 });

    await expect(page.getByRole('link', { name: '← Factory' })).toBeVisible();
    await expect(page.getByText('Worktrees', { exact: true })).toBeVisible();
    await expect(page.getByText('Evidence', { exact: true })).toBeVisible();
    await expect(page.getByText('Slots that worked this unit')).toBeVisible();

    // Evidence is tabular (searchable data table), not a long timeline list.
    await expect(
      page
        .getByRole('searchbox', { name: /search evidence/i })
        .or(page.getByText(/no execution evidence synchronized yet/i)),
    ).toBeVisible();
    await expect(page.getByText('Evidence timeline')).toHaveCount(0);

    // Repository card links into Mission Control repo pages.
    await expect(page.locator('a[href^="/repos/"]').first()).toBeVisible();
  });
});
