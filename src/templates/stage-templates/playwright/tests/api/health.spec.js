const { test, expect } = require('@playwright/test');

// TODO: adapt path and expected body for your app's health endpoint
test.describe('API smoke', () => {
  test('health endpoint responds', async ({ request }) => {
    const healthPath = process.env.HARNESS_HEALTH_PATH || '/health';
    const res = await request.get(healthPath);
    expect(res.ok()).toBeTruthy();
  });
});
