const { test, expect } = require('@playwright/test');

test.describe('Usage page', () => {
  test('shows summary cards and empty or table state', async ({ page }) => {
    await page.goto('/usage');
    await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Tokens', { exact: true })).toBeVisible();
    await expect(page.getByText('Estimated cost', { exact: true })).toBeVisible();

    const empty = page.getByText(/no usage recorded yet/i);
    const table = page.getByRole('table');
    await expect(empty.or(table)).toBeVisible();
  });

  test('exposes search when sessions exist', async ({ page }) => {
    await page.goto('/usage');

    const table = page.getByRole('table');
    if (!(await table.isVisible().catch(() => false))) {
      test.skip(true, 'No usage sessions recorded — nothing to search');
    }

    const search = page.getByRole('searchbox', { name: /search usage sessions/i });
    await expect(search).toBeVisible();
    await expect(page.getByRole('button', { name: /columns/i })).toBeVisible();

    const totalRows = await page.getByRole('row').count();

    await search.fill('zzz-no-such-usage-session-zzz');
    await expect(page.getByRole('cell', { name: /no sessions match your filters/i })).toBeVisible();

    await search.fill('');
    await expect(page.getByRole('row')).toHaveCount(totalRows);
  });

  test('keeps horizontal scroll inside the table, not the page', async ({ page }) => {
    await page.goto('/usage');
    await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        pageOverflowsX: doc.scrollWidth > doc.clientWidth + 1,
      };
    });

    expect(metrics.pageOverflowsX).toBe(false);
  });
});
