const { test, expect } = require('@playwright/test');

test.describe('Repository session history', () => {
  test('history tab explains snapshots versus commits', async ({ page }) => {
    await page.goto('/repos');

    const repoLink = page.locator('tbody a[href^="/repos/"]').first();
    if (!(await repoLink.isVisible().catch(() => false))) {
      test.skip(true, 'No repositories registered — no detail page to open');
    }

    await repoLink.click();
    await page.waitForURL(/\/repos\/[^/]+$/);

    const historyTab = page.getByRole('tab', { name: 'History' });
    await expect(historyTab).toBeVisible();
    await historyTab.click();

    await expect(page.getByText('Session history', { exact: true })).toBeVisible();
    await expect(page.getByTestId('handoff-lifecycle-copy')).toContainText(
      'does not copy changes into a different branch',
    );

    const graph = page.getByTestId('session-history-graph');
    const empty = page.getByText(/no session history yet/i);
    if (await graph.isVisible().catch(() => false)) {
      await expect(page.getByTestId('session-history-explain')).toBeVisible();
      await expect(page.getByTestId('provenance-ids')).toContainText('Content snapshot');
      await expect(page.getByTestId('provenance-ids')).toContainText('Commit');
    } else {
      await expect(empty).toBeVisible();
    }
  });
});
