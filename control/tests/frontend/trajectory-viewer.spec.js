/* eslint-disable @typescript-eslint/no-require-imports */
const { test, expect } = require('@playwright/test');

test.describe('Slot trajectory viewer', () => {
  test('keeps trajectory and raw events available side by side', async ({ page }) => {
    await page.goto('/worktrees');
    const slotLink = page.locator('tbody a[href*="/slots/"]').first();
    if (!(await slotLink.isVisible().catch(() => false))) {
      test.skip(true, 'No slot fixture exists — no trajectory page to open');
    }

    await page.goto(await slotLink.getAttribute('href'));
    const trajectoryTab = page.getByRole('tab', { name: 'Trajectory' });
    const rawTab = page.getByRole('tab', { name: 'Raw events' });
    await expect(trajectoryTab).toBeVisible();
    await expect(rawTab).toBeVisible();

    const panel = page.getByRole('tabpanel');
    await expect(
      panel.getByLabel('Agent trajectory timeline')
        .or(panel.getByText(/no trajectory records yet|no records in this trajectory stream/i)),
    ).toBeVisible();

    const selector = panel.getByLabel('Select trajectory session and agent');
    if (await selector.isVisible().catch(() => false)) {
      await expect(selector).toBeEnabled();
    }
    const exportLink = panel.getByRole('link', { name: /export jsonl/i });
    if (await exportLink.isVisible().catch(() => false)) {
      await expect(exportLink).toHaveAttribute('href', /format=jsonl/);
    }

    await rawTab.click();
    await expect(
      page.getByText(/no otel session events yet/i).or(page.getByRole('table')),
    ).toBeVisible();
  });
});
