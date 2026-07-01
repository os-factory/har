const { test, expect } = require('@playwright/test');

test('homepage passes axe critical/serious checks', async ({ page }) => {
  await page.goto('/');
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
