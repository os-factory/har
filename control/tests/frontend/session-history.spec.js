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
  await expect(page.getByRole('tab', { name: 'Graph' })).toBeVisible();
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

  test('list mode reuses the timeline and follows the branch filter', async ({ page }) => {
    await openHistory(page);
    await page.getByRole('tab', { name: 'List' }).click();

    const timeline = page.getByTestId('slot-timeline');
    await expect(timeline).toBeVisible();
    await expect(timeline.getByRole('columnheader', { name: 'Branch' })).toBeVisible();
    await expect(timeline.getByRole('columnheader', { name: 'Slot' })).toBeVisible();
    // No page-long list: the table body scrolls and there is no pagination.
    await expect(timeline.getByRole('button', { name: /next/i })).toHaveCount(0);

    const filter = page.getByRole('combobox', { name: 'Filter history by branch' });
    if (!(await filter.isVisible().catch(() => false))) return;
    const before = await timeline.locator('tbody tr').count();
    await filter.click();
    const options = page.getByRole('option');
    const optionCount = await options.count();
    if (optionCount < 2) return;
    const branch = (await options.nth(1).innerText()).trim();
    await options.nth(1).click();
    await expect(filter).toContainText(branch);
    const after = await timeline.locator('tbody tr').count();
    expect(after).toBeLessThanOrEqual(before);
    for (const cell of await timeline.locator('tbody tr td:nth-child(6)').allInnerTexts()) {
      expect(cell === '—' || cell === branch).toBeTruthy();
    }
  });
});
