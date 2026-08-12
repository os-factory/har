const { test, expect } = require('@playwright/test');

test.describe('Enterprise page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /(?:posthog|googletagmanager|google-analytics|youtube|youtu\.be|web3forms|doubleclick)/i,
      (route) => route.abort(),
    );
  });

  test('loads with hero and request-access form', async ({ page }) => {
    await page.goto('/enterprise/');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1')).toContainText(
      'Bring visibility, control, and governance to every agent across your org.',
    );
    await expect(page.getByRole('link', { name: 'Enterprise' }).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
    await expect(page.locator('img[data-dashboard-zoom]')).toBeVisible();
  });

  test('opens dashboard screenshot in zoom modal on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/enterprise/');

    const trigger = page.locator('img[data-dashboard-zoom]');
    await expect(trigger).toBeVisible();

    const modal = page.locator('[data-dashboard-image-modal]');
    await expect(modal).toBeHidden();

    await trigger.click();

    await expect(modal).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Dashboard screenshot' })).toBeVisible();
    await expect(page.locator('[data-dashboard-image-target]')).toHaveAttribute(
      'src',
      /enterprise-hero\.png/,
    );

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toBeHidden();
  });
});
