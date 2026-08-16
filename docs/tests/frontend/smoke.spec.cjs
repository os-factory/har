const { test, expect } = require('@playwright/test');

test.describe('Frontend smoke', () => {
  test('landing page loads with brand hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1')).toContainText(
      'The open harness for multi-agent coding workflows',
    );
    await expect(page.getByRole('link', { name: /Read the docs/i })).toBeVisible();
  });

  test('plugin marketplace lists every plugin with a working detail page', async ({ page }) => {
    await page.goto('/plugins/');
    await expect(page.locator('h1')).toContainText('Verification stages your agents must pass');
    for (const name of ['Playwright', 'RocketSim', 'Kerno', 'Gitleaks', 'Trivy', 'Semgrep']) {
      await expect(page.locator('.plugin-card h2', { hasText: name })).toBeVisible();
    }
    await expect(page.locator('a.plugin-card-custom')).toHaveAttribute(
      'href',
      '/docs/guides/plugins/#your-own-checks',
    );
    await expect(page.locator('.install-cmd')).toContainText('har env add-plugin');
    await page.locator('a.plugin-card', { hasText: 'Gitleaks' }).click();
    await expect(page).toHaveURL(/\/plugins\/gitleaks\/$/);
    await expect(page.locator('h1')).toContainText('Gitleaks');
    await expect(page.locator('.install-command')).toContainText('har env add-plugin gitleaks');
  });

  test('docs introduction is reachable', async ({ page }) => {
    await page.goto('/docs/getting-started/introduction/');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
  });
});
