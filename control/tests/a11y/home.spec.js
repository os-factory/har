const { test, expect } = require('@playwright/test');

test('homepage passes axe critical/serious checks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sidebar-health')).toBeVisible();
  // Wait for health fetch so transient ellipsis/loading text is not measured.
  await expect(page.getByTestId('sidebar-health').getByText('MCP')).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="sidebar-health"]');
    return el && !el.textContent?.includes('…');
  });
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const results = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run();
  });
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(blocking).toEqual([]);
});
