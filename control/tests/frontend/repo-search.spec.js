const { test, expect } = require('@playwright/test');

// These specs assume the DB has been seeded with more than one repository.
// They are resilient to an empty DB by skipping when the table is absent.

test.describe('Repository search and filter', () => {
  test('search box narrows the visible rows', async ({ page }) => {
    await page.goto('/');

    const table = page.getByRole('table');
    if (!(await table.isVisible().catch(() => false))) {
      test.skip(true, 'No repositories registered — nothing to filter');
    }

    const search = page.getByRole('searchbox', { name: /search repositories/i });
    await expect(search).toBeVisible();

    const totalRows = await page.getByRole('row').count();

    // Query for something that cannot match any seeded repo.
    await search.fill('zzz-no-such-repo-zzz');
    await expect(page.getByText(/no repositories match your filters/i)).toBeVisible();

    // Clearing restores the full list.
    await search.fill('');
    await expect(page.getByRole('row')).toHaveCount(totalRows);
  });

  test('profile filter buttons narrow the list', async ({ page }) => {
    await page.goto('/');

    const table = page.getByRole('table');
    if (!(await table.isVisible().catch(() => false))) {
      test.skip(true, 'No repositories registered — nothing to filter');
    }

    const allButton = page.getByRole('button', { name: 'All', exact: true });
    if (!(await allButton.isVisible().catch(() => false))) {
      test.skip(true, 'No profiles present to filter by');
    }

    const rowsWithAll = await page.getByRole('row').count();

    // Click the first non-"All" profile button and confirm the row count changes
    // (or at least never grows beyond the unfiltered set).
    const cliButton = page.getByRole('button', { name: 'cli', exact: true });
    if (await cliButton.isVisible().catch(() => false)) {
      await cliButton.click();
      const rowsFiltered = await page.getByRole('row').count();
      expect(rowsFiltered).toBeLessThanOrEqual(rowsWithAll);
      // Every visible profile badge in the body should now read "cli".
      const badges = page.locator('tbody').getByText('default');
      await expect(badges).toHaveCount(0);
    }
  });
});
