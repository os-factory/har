const { test, expect } = require('@playwright/test');

test.describe('Blog', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /(?:posthog|googletagmanager|google-analytics|youtube|youtu\.be|web3forms|doubleclick)/i,
      (route) => route.abort(),
    );
  });

  test('index lists the factory-line post and marks Blog active', async ({ page }) => {
    await page.goto('/blog/');
    await expect(page.locator('h1')).toContainText('Notes from the line.');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Blog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const article = page.getByRole('link', { name: /The factory line/ });
    await expect(article).toBeVisible();
    await expect(article).toHaveAttribute('href', '/blog/the-factory-line/');
    await expect(page.locator('.site-footer').getByRole('link', { name: 'Blog' })).toBeVisible();
  });

  test('factory-line article covers the ratchet and the gate misses', async ({ page }) => {
    await page.goto('/blog/the-factory-line/');
    await expect(page.locator('h1')).toContainText('The factory line');
    await expect(page.locator('h2', { hasText: 'The ratchet' })).toBeVisible();
    await expect(page.locator('.blog-prose')).toContainText(
      'does not swap assertions. It adds them',
    );
    await expect(page.locator('.blog-prose')).toContainText(
      'Identical units out the door',
    );
    await expect(page.locator('.blog-prose')).toContainText(
      'Rework = waste',
    );
    await expect(page.locator('.blog-prose')).toContainText('2,306 node processes');
    await expect(page.locator('.blog-prose')).toContainText(
      'a gate only tests the questions you thought to ask',
    );
    await expect(page.getByRole('link', { name: 'road to 1.0' }).first()).toHaveAttribute(
      'href',
      '/docs/project/road-to-1-0/',
    );
    await expect(page.getByRole('link', { name: '#302' })).toHaveAttribute(
      'href',
      'https://github.com/os-factory/har/issues/302',
    );
  });
});
