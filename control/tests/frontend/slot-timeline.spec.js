/* eslint-disable @typescript-eslint/no-require-imports */
const { test, expect } = require('@playwright/test');

/** Open a slot page; with `needSession`, keep looking until one with an agent session row is found. */
async function openFirstSlot(page, { needSession = false } = {}) {
  await page.goto('/repos');
  const repoHrefs = await page.locator('tbody a[href^="/repos/"]').evaluateAll((links) =>
    [...new Set(links.map((link) => link.getAttribute('href')))]);
  for (const repoHref of repoHrefs) {
    await page.goto(repoHref);
    const slotHrefs = await page.locator('tbody a[href*="/slots/"]').evaluateAll((links) =>
      [...new Set(links.map((link) => link.getAttribute('href')))]);
    for (const slotHref of slotHrefs) {
      await page.goto(slotHref);
      if (!needSession) return true;
      if ((await page.getByTestId('slot-timeline-summary').textContent()).match(/^[1-9]\d* agent session/)) return true;
    }
  }
  return false;
}

test.describe('Slot timeline', () => {
  test('slot page collapses to header, verify and one timeline table', async ({ page }) => {
    // (#340) the header offers the exact next har commands to copy
    if (!(await openFirstSlot(page))) test.skip(true, 'No slot fixture exists');

    await expect(page.getByRole('heading', { name: /^Slot \d+/ })).toBeVisible();
    await expect(page.getByTestId('slot-worktree-path')).toBeVisible();
    // #340: the exact next har commands, --repo prefilled, ready to copy.
    const commands = page.getByTestId('slot-commands').getByTestId('copy-command');
    expect(await commands.count()).toBeGreaterThan(0);
    await expect(commands.first()).toContainText(/har env (verify|launch) \d+/);
    await expect(commands.first()).toContainText('--repo ');
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
    if (!(await openFirstSlot(page, { needSession: true }))) test.skip(true, 'No slot with an agent session exists');
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
    // The newest agent session is open by default on the slot page; open it if it is not.
    if ((await sessionRow.getAttribute('aria-expanded')) !== 'true') await sessionRow.click();
    await expect(sessionRow).toHaveAttribute('aria-expanded', 'true');
    await expect(timeline.getByTestId('timeline-session-detail')).toBeVisible();

    // The trajectory opens in a right-hand drawer, addressed by the URL.
    await timeline.getByTestId('timeline-open-trajectory').click();
    const drawer = page.getByTestId('trajectory-drawer');
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/trajectory=/);
    await expect(
      drawer.getByLabel('Agent trajectory timeline')
        .or(drawer.getByText(/no trajectory records yet|no records in this trajectory stream/i)),
    ).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByTestId('trajectory-copy-link')).toBeVisible();
    // Infinite scroll replaces the old "Load older" button.
    await expect(page.getByRole('button', { name: /load older/i })).toHaveCount(0);

    // Selecting a turn or tool call puts it in the link; reloading that link restores it.
    const node = drawer.getByLabel('Agent trajectory timeline').locator('li[data-node-id] button').last();
    if (await node.isVisible().catch(() => false)) {
      await node.click();
      await expect(page).toHaveURL(/trajectoryNode=/);
      const shared = page.url();
      const nodeId = new URL(shared).searchParams.get('trajectoryNode');
      await page.goto(shared);
      const restored = page.getByTestId('trajectory-drawer').locator(`li[data-node-id="${nodeId}"] button`);
      await expect(restored).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    }

    // Closing the drawer clears the link parameters.
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/trajectory=/);
  });
});
