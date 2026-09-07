const { test, expect } = require('@playwright/test');

test.describe('Factory work unit detail', () => {
  test('work unit page shows attempts as records', async ({ page }) => {
    await page.goto('/work');
    await expect(page.getByRole('heading', { name: 'Work' })).toBeVisible();

    const unitLink = page.locator('a[href^="/work/"]').first();
    if ((await unitLink.count()) === 0) {
      test.skip(true, 'No synchronized work units in this environment');
    }

    await unitLink.click();
    await page.waitForURL(/\/work\//, { timeout: 10_000 });

    await expect(page.getByRole('link', { name: '← Work' })).toBeVisible();
    await expect(page.getByText('Worktrees', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Slots that worked this unit')).toHaveCount(0);
    await expect(page.getByText('Evidence', { exact: true })).toHaveCount(0);

    // #348: attempts are records. The newest is open and shows the shared timeline;
    // slot numbers are text unless the attempt is live.
    const attempts = page.getByTestId('work-unit-attempts');
    const toggles = page.getByTestId('work-unit-attempt-toggle');
    if ((await toggles.count()) > 0) {
      await expect(attempts.getByTestId('attempt-record').first()).toBeVisible();
      const timeline = attempts.getByTestId('slot-timeline').first();
      await expect(timeline.getByRole('searchbox', { name: /search timeline/i })).toBeVisible();
      await expect(page.getByText(/rows per page/i)).toHaveCount(0);
      for (const link of await attempts.locator('a[href*="/slots/"]').all()) {
        await expect(link).toHaveAttribute('data-testid', 'attempt-live-slot');
      }
    } else {
      await expect(page.getByText(/no attempt synchronized yet/i)).toBeVisible();
    }

    // Repository card links into Mission Control repo pages.
    await expect(page.locator('a[href^="/repos/"]').first()).toBeVisible();

    // #340: a live attempt gets a Handoff card (verify + complete, tracker links). Finished
    // units stay command-free.
    const handoff = page.getByTestId('work-unit-handoff');
    if (await handoff.count()) {
      await expect(handoff.getByTestId('attempt-handoff')).toBeVisible();
      await expect(handoff.getByTestId('copy-command').first()).toContainText(/har env (verify|complete) \d+/);
      await expect(handoff.getByTestId('copy-command').first()).toContainText('--repo ');
    }
  });

  test('Work table exposes next commands on a live slot', async ({ page }) => {
    await page.goto('/work');
    const next = page.getByTestId('slot-commands').first();
    if ((await next.count()) === 0) test.skip(true, 'No live work-unit slot in this environment');
    await expect(next.getByRole('button').first()).toHaveAttribute('aria-label', /Copy: har env /);
  });
});
