/* eslint-disable @typescript-eslint/no-require-imports */
const { test, expect } = require('@playwright/test');

async function openFirstSlot(page) {
  await page.goto('/repos');
  const repoLink = page.locator('tbody a[href^="/repos/"]').first();
  if (!(await repoLink.isVisible().catch(() => false))) return false;
  await page.goto(await repoLink.getAttribute('href'));
  const slotLink = page.locator('tbody a[href*="/slots/"]').first();
  if (!(await slotLink.isVisible().catch(() => false))) return false;
  await page.goto(await slotLink.getAttribute('href'));
  return true;
}

test.describe('Slot timeline', () => {
  test('slot page collapses to header, verify and one timeline table', async ({ page }) => {
    if (!(await openFirstSlot(page))) test.skip(true, 'No slot fixture exists');

    await expect(page.getByRole('heading', { name: /^Slot \d+/ })).toBeVisible();
    await expect(page.getByTestId('slot-worktree-path')).toBeVisible();
    await expect(page.getByText('Verify', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Timeline', { exact: true }).first()).toBeVisible();

    // The four activity/usage cards are gone.
    for (const gone of ['Session activity', 'Agent activity', 'Usage by agent', 'Sessions recorded']) {
      await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
    }

    const timeline = page.getByTestId('slot-timeline');
    await expect(timeline.getByTestId('slot-timeline-summary')).toContainText(/agent session/);
    await expect(timeline.getByRole('searchbox', { name: /search timeline/i })).toBeVisible();
    await expect(timeline.getByRole('group', { name: 'Filter by kind' })).toBeVisible();

    // No pagination controls anywhere in the timeline: the body scrolls in place.
    await expect(timeline.getByText(/rows per page/i)).toHaveCount(0);
  });

  test('rows expand in place per kind and collapse again', async ({ page }) => {
    if (!(await openFirstSlot(page))) test.skip(true, 'No slot fixture exists');
    const timeline = page.getByTestId('slot-timeline');
    const table = timeline.getByRole('table').first();
    const rows = table.locator('tbody tr[aria-expanded]');
    if ((await rows.count()) === 0) test.skip(true, 'No timeline events in this environment');

    const kinds = [
      { label: 'Run', detail: 'timeline-run-detail' },
      { label: 'Snapshot', detail: 'timeline-snapshot-detail' },
      { label: 'Commit', detail: 'timeline-commit-detail' },
      { label: 'Session', detail: 'timeline-occupancy-detail' },
    ];
    let expandedSomething = false;
    for (const kind of kinds) {
      const row = rows.filter({ has: page.getByText(kind.label, { exact: true }) }).first();
      if ((await row.count()) === 0) continue;
      await row.click();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      await expect(timeline.getByTestId(kind.detail)).toBeVisible();
      await row.click();
      await expect(row).toHaveAttribute('aria-expanded', 'false');
      await expect(timeline.getByTestId(kind.detail)).toHaveCount(0);
      expandedSomething = true;
    }
    expect(expandedSomething).toBe(true);
  });

  test('agent sessions open the trajectory inline and raw events stay behind a debug toggle', async ({ page }) => {
    if (!(await openFirstSlot(page))) test.skip(true, 'No slot fixture exists');
    const timeline = page.getByTestId('slot-timeline');

    const raw = timeline.getByLabel(/show raw otel events/i);
    await expect(raw).toBeVisible();
    await expect(raw).not.toBeChecked();
    await raw.click();
    await expect(
      timeline.getByText(/no otel session events yet/i).or(timeline.getByLabel('Hide start/end events')),
    ).toBeVisible();

    const sessionRow = timeline.getByRole('table').first().locator('tbody tr[aria-expanded]')
      .filter({ has: page.getByText('Agent', { exact: true }) }).first();
    if ((await sessionRow.count()) === 0) test.skip(true, 'No agent session in this environment');
    await sessionRow.click();
    await expect(timeline.getByTestId('timeline-session-detail')).toBeVisible();
    await expect(
      page.getByLabel('Agent trajectory timeline')
        .or(page.getByText(/no trajectory records yet|no records in this trajectory stream/i)),
    ).toBeVisible({ timeout: 10_000 });
    // Infinite scroll replaces the old "Load older" button.
    await expect(page.getByRole('button', { name: /load older/i })).toHaveCount(0);
  });
});
