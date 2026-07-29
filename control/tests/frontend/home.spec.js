const { test, expect } = require('@playwright/test');

test.describe('Factory and operations', () => {
  test('shows Factory as the work-centric home', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible();
    await expect(page.getByText('Work', { exact: true })).toBeVisible();
  });

  test('renders the operations worktree table', async ({ page }) => {
    await page.goto('/worktrees');
    await expect(page.getByText('Session worktrees').first()).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('button', { name: /delete selected/i })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /select all rows/i })).toBeVisible();
  });

  test('sidebar separates Factory and Operations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Factory', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Operations', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usage', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Repositories', exact: true })).toBeVisible();
  });

  test('keeps horizontal scroll inside the table, not the page', async ({ page }) => {
    await page.goto('/worktrees');
    await expect(page.getByRole('table')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        pageOverflowsX: doc.scrollWidth > doc.clientWidth + 1,
      };
    });

    expect(metrics.pageOverflowsX).toBe(false);
  });

  test('exposes search, columns, and repository filter', async ({ page }) => {
    await page.goto('/worktrees');
    await expect(page.getByRole('searchbox', { name: /search worktrees/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /columns/i })).toBeVisible();
    await expect(page.getByLabel('Filter by repository')).toBeVisible();
  });

  test('repository filter updates the URL and narrows rows', async ({ page }) => {
    await page.goto('/worktrees');
    const filter = page.getByLabel('Filter by repository');
    await expect(filter).toBeVisible();

    await filter.click();
    const options = page.getByRole('option');
    const optionCount = await options.count();
    if (optionCount <= 1) {
      test.skip(true, 'Only the All repositories option is available');
    }

    // Pick the first concrete repository option (skip "All repositories").
    const repoOption = options.nth(1);
    const repoLabel = (await repoOption.textContent())?.trim() ?? '';
    await repoOption.click();

    await expect(page).toHaveURL(/\?repo=/);
    await expect(page.getByRole('table')).toBeVisible();
    // Filtered view should still mention the selected repo somewhere, or show empty state.
    const empty = page.getByText(/no active worktrees for this repository/i);
    const table = page.getByRole('table');
    await expect(empty.or(table)).toBeVisible();
    if (repoLabel) {
      // URL param is set; label may only appear in the select trigger.
      await expect(filter).toContainText(repoLabel);
    }
  });

  test('clicking a worktree row opens the slot detail page', async ({ page }) => {
    await page.goto('/worktrees');
    const table = page.getByRole('table');
    await expect(table).toBeVisible();

    const slotLink = table.locator('tbody a[href*="/slots/"]').first();
    if ((await slotLink.count()) === 0) {
      test.skip(true, 'No active worktree rows with slot links');
    }

    const href = await slotLink.getAttribute('href');
    expect(href).toBeTruthy();

    const row = slotLink.locator('xpath=ancestor::tr[1]');
    // Click Status cell (non-link) so nested preview/repo links stay intact.
    await row.getByRole('cell').nth(2).click();
    await page.waitForURL((url) => url.pathname.includes('/slots/'), { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe(href);
  });
});
