const { test, expect } = require('@playwright/test');

test.describe('Site HTTP smoke', () => {
  test('site root responds', async ({ request }) => {
    const healthPath = process.env.HARNESS_HEALTH_PATH || '/';
    const res = await request.get(healthPath);
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
