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

  // Seed fixture (prisma/seed-data.json): work unit 191 has a full verification whose trace
  // carries an attestation for tree 7d18e3cd, and commit a0d31d0 has that tree.
  test('a verified attempt shows its Factory Commits proof and the commit that carries it', async ({ page }) => {
    const response = await page.goto('/work/dadca8df-23ef-43c6-b76e-baa55493258c');
    if (!response || response.status() === 404) test.skip(true, 'Seed work unit 191 is not in this environment');

    const proof = page.getByTestId('attempt-proof');

    await expect(proof.getByTestId('factory-proof-verdict')).toHaveText('pass');
    await expect(proof.getByText('self-reported')).toBeVisible();
    await expect(proof.getByText('sha256:', { exact: false }).first()).toBeVisible();
    await expect(proof.getByRole('button', { name: /^Copy attestation digest: sha256:[0-9a-f]{64}$/ })).toBeVisible();
    await expect(proof.getByRole('button', { name: /^Copy trace id: [0-9a-f]{32}$/ })).toBeVisible();
    await expect(proof.getByText('Factory run (proof)')).toBeVisible();
    await expect(proof.getByText('Verify run')).toBeVisible();
    await expect(proof.getByTestId('factory-proof-required')).toContainText('unit-tests');
    await expect(proof.getByTestId('copy-command')).toContainText(/har proof verify a0d31d0[0-9a-f]+ --repo /);
    await expect(proof.getByText('Mission Control cannot run har itself', { exact: false })).toBeVisible();
    // A record never links to a slot (#348).
    await expect(proof.locator('a[href*="/slots/"]')).toHaveCount(0);

    // F7: stage labels come from stages.json, not guessed tool names.
    const attempt = page.getByTestId('attempt-record').first();
    await expect(attempt.getByText('Vitest suite')).toHaveCount(0);
    await expect(attempt.getByText('ESLint rules')).toHaveCount(0);

    // The timeline's Commit row carries the proof.
    const timeline = attempt.getByTestId('slot-timeline');
    await timeline.getByRole('row', { name: /Commit a0d31d0/ }).click();
    const commitProof = timeline.getByTestId('commit-proof');
    await expect(commitProof).toContainText('Proof attached');
    await expect(commitProof.getByTestId('copy-command')).toContainText('har proof verify a0d31d0');
  });

  test('Work table exposes next commands on a live slot', async ({ page }) => {
    await page.goto('/work');
    const next = page.getByTestId('slot-commands').first();
    if ((await next.count()) === 0) test.skip(true, 'No live work-unit slot in this environment');
    await expect(next.getByRole('button').first()).toHaveAttribute('aria-label', /Copy: har env /);
  });
});
