const { test, expect } = require('@playwright/test');

async function openHistory(page) {
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
  await expect(page.getByTestId('history-how-toggle')).toBeVisible();
}

test.describe('Repository history', () => {
  test('explains the lifecycle behind a collapsed link', async ({ page }) => {
    await openHistory(page);
    await expect(page.getByTestId('handoff-lifecycle-copy')).toBeHidden();
    await page.getByTestId('history-how-toggle').click();
    await expect(page.getByTestId('handoff-lifecycle-copy')).toContainText(
      'does not copy changes into a different branch',
    );
  });

  test('graph draws edges and explains the selected node only', async ({ page }) => {
    await openHistory(page);

    const graph = page.getByTestId('session-history-graph');
    if (!(await graph.isVisible().catch(() => false))) {
      await expect(page.getByText(/no history yet/i)).toBeVisible();
      return;
    }

    // Nothing is explained until the user picks a node.
    await expect(page.getByTestId('session-history-explain')).toHaveCount(0);
    await expect(page.getByTestId('session-history-explain-empty')).toBeVisible();

    const nodes = page.getByTestId('session-history-node');
    const nodeCount = await nodes.count();
    expect(nodeCount).toBeGreaterThan(0);
    if (nodeCount > 1) {
      // Snapshots point back at the commit they were based on.
      expect(await page.locator('.react-flow__edge').count()).toBeGreaterThan(0);
      await expect(page.getByLabel('Edge legend')).toBeVisible();
    }

    await nodes.first().click();
    const explain = page.getByTestId('session-history-explain');
    await expect(explain).toBeVisible();
    // Selecting a node scrolls the explanation into the viewport.
    await expect(explain).toBeInViewport({ ratio: 0.5 });
    await expect(explain.getByRole('heading', { level: 4 })).toHaveText(/^(Commit|Snapshot) [0-9a-f]{7}$/);
    const provenance = page.getByTestId('provenance-ids');
    await expect(provenance).toContainText('Content snapshot');
    await expect(provenance).toContainText('Commit');
    // Hashes are abbreviated git-style; run ids are shown whole.
    const shas = provenance.locator('dd');
    for (const text of (await shas.allInnerTexts()).slice(0, 3)) {
      expect(text === '—' || text.length === 7).toBeTruthy();
    }
    const runId = await shas.nth(3).innerText();
    expect(runId === '—' || runId.length > 12).toBeTruthy();
  });

  test('a verified node opens the record of the attempt that produced it, without slot links', async ({ page }) => {
    await openHistory(page);
    await expect(page.getByRole('tab', { name: 'List' })).toHaveCount(0);

    const graph = page.getByTestId('session-history-graph');
    if (!(await graph.isVisible().catch(() => false))) return;

    // Snapshots always come from an attempt; pick one so the record is non-trivial.
    const snapshot = page.locator('[data-testid="session-history-node"][data-node-kind="snapshot"]').first();
    if ((await snapshot.count()) === 0) return;
    await snapshot.click();

    const explain = page.getByTestId('session-history-explain');
    await expect(explain).toBeVisible();
    const record = explain.getByTestId('attempt-record');
    const noAttempt = explain.getByTestId('session-history-no-attempt');
    await expect(record.or(noAttempt).first()).toBeVisible({ timeout: 10_000 });
    if (!(await record.isVisible().catch(() => false))) return;

    // The record carries the attempt facts, the verify graph and the attempt timeline.
    await expect(record.getByText('Work unit', { exact: true })).toBeVisible();
    await expect(record.getByTestId('attempt-verify-summary')).toBeVisible();
    await expect(record.getByTestId('slot-timeline')).toBeVisible();
    // Record → slot navigation only exists for a live attempt.
    const slotLinks = explain.locator('a[href*="/slots/"]');
    for (const link of await slotLinks.all()) {
      await expect(link).toHaveAttribute('data-testid', 'attempt-live-slot');
    }
  });
});
