const { test, expect } = require('@playwright/test');

test.describe('Blog', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /(?:posthog|googletagmanager|google-analytics|youtube|youtu\.be|web3forms|doubleclick)/i,
      (route) => route.abort(),
    );
  });

  test('index lists the 1.0.0 announcement then the factory-line post', async ({ page }) => {
    await page.goto('/blog/');
    await expect(page.locator('h1')).toContainText('Notes from the line.');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Blog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const announcement = page.locator('a.blog-post-card', {
      has: page.locator('h2', { hasText: 'HAR 1.0.0' }),
    });
    await expect(announcement).toBeVisible();
    await expect(announcement).toHaveAttribute('href', '/blog/har-1-0-0/');
    const factory = page.locator('a.blog-post-card', {
      has: page.locator('h2', { hasText: 'The factory line' }),
    });
    await expect(factory).toBeVisible();
    await expect(factory).toHaveAttribute('href', '/blog/the-factory-line/');
    const hrefs = await page.locator('.blog-index-list a.blog-post-card').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')),
    );
    expect(hrefs.indexOf('/blog/har-1-0-0/')).toBeLessThan(hrefs.indexOf('/blog/the-factory-line/'));
    await expect(page.locator('.site-footer').getByRole('link', { name: 'Blog' })).toBeVisible();
  });

  test('1.0.0 announcement covers the change and points at migration', async ({ page }) => {
    await page.goto('/blog/har-1-0-0/');
    await expect(page.locator('h1')).toContainText('HAR 1.0.0');
    await expect(page.locator('.blog-article-head .eyebrow')).toHaveText(/Release/i);
    await expect(page.locator('.blog-prose')).toContainText(
      'the runtime lives in the package, and .har/ is only what is yours',
    );
    await expect(page.getByRole('link', { name: 'migration guide' }).first()).toHaveAttribute(
      'href',
      '/docs/guides/migrating-to-1-0/',
    );
    await expect(page.getByRole('link', { name: 'The factory line' }).first()).toHaveAttribute(
      'href',
      '/blog/the-factory-line/',
    );
    const copyPrompt = page.getByRole('button', { name: /Copy v1\.0\.0 migration prompt/i });
    await expect(copyPrompt).toBeVisible();
    await expect(copyPrompt).toHaveAttribute('data-copy', /har env maintain/);
    await expect(page.locator('.blog-prose')).toHaveCSS('opacity', '1');
    await expect(page.getByRole('link', { name: '← Journal' })).toHaveCount(0);
  });

  test('copy prompt writes the 1.0.0 migration starter to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/blog/har-1-0-0/');
    const copyPrompt = page.getByRole('button', { name: /Copy v1\.0\.0 migration prompt/i });
    await copyPrompt.click();
    await expect(copyPrompt).toContainText('Copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('har env maintain');
    expect(text).toContain('https://harproject.dev/docs/guides/migrating-to-1-0/');
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
    await expect(page.getByRole('link', { name: 'HAR 1.0.0' }).first()).toHaveAttribute(
      'href',
      '/blog/har-1-0-0/',
    );
    await expect(page.getByRole('link', { name: '#302' })).toHaveAttribute(
      'href',
      'https://github.com/os-factory/har/issues/302',
    );
    await expect(page.getByRole('button', { name: /Copy v1\.0\.0 migration prompt/i })).toHaveCount(0);
    await expect(page.locator('.blog-prose')).toHaveCSS('opacity', '1');
    await expect(page.getByRole('link', { name: '← Journal' })).toHaveCount(0);
    await expect(page.locator('.blog-article-head .eyebrow')).toHaveText(/Method/i);
  });

  test('legacy road-to-1.0 docs URL redirects to the announcement', async ({ page }) => {
    await page.goto('/docs/project/road-to-1-0/');
    await expect(page).toHaveURL(/\/blog\/har-1-0-0\/?$/);
    await expect(page.locator('h1')).toContainText('HAR 1.0.0');
  });
});
