const { test, expect } = require('@playwright/test');

test.describe('Factory work unit detail', () => {
  test('work unit page shows overview sections instead of timeline-only', async ({ page }) => {
    await page.goto('/work');
    await expect(page.getByRole('heading', { name: 'Work' })).toBeVisible();

    const unitLink = page.locator('a[href^="/work/"]').first();
    if ((await unitLink.count()) === 0) {
      test.skip(true, 'No synchronized work units in this environment');
    }

    await unitLink.click();
    await page.waitForURL(/\/work\//, { timeout: 10_000 });

    await expect(page.getByRole('link', { name: '← Work' })).toBeVisible();
    await expect(page.getByText('Worktrees', { exact: true })).toBeVisible();
    await expect(page.getByText('Timeline', { exact: true })).toBeVisible();
    await expect(page.getByText('Evidence', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Slots that worked this unit')).toBeVisible();

    // The timeline is one data table shared with the slot page, with the Slot column shown.
    const timeline = page.getByTestId('slot-timeline');
    await expect(timeline.getByRole('searchbox', { name: /search timeline/i })).toBeVisible();
    await expect(timeline.getByRole('columnheader', { name: 'Slot' })).toBeVisible();
    await expect(page.getByText(/rows per page/i)).toHaveCount(0);

    // Repository card links into Mission Control repo pages.
    await expect(page.locator('a[href^="/repos/"]').first()).toBeVisible();
  });
});
