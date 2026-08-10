const fs = require('fs');
const path = require('path');

/**
 * Resolve the directory for harness visual-proof PNGs.
 * Prefer PW_SCREENSHOT_DIR from capture-screenshots / browser-e2e stages.
 */
function screenshotDir() {
  if (process.env.PW_SCREENSHOT_DIR) {
    return process.env.PW_SCREENSHOT_DIR;
  }
  const phase = process.env.PW_SCREENSHOT_PHASE || 'after';
  return path.resolve(
    process.cwd(),
    '.har/artifacts/browser-e2e/screenshots',
    phase,
  );
}

/**
 * Save a full-page screenshot and attach it to the Playwright report.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} name  basename without extension (e.g. "landing")
 */
async function capturePageScreenshot(page, testInfo, name) {
  const dir = screenshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  // Prefer a tall viewport shot over fragile fullPage on media-heavy landing pages.
  // Agents can still prove UI changes; attach both viewport and (best-effort) full page.
  await page.screenshot({ path: filePath, fullPage: true, timeout: 60_000 });
  await testInfo.attach(`${process.env.PW_SCREENSHOT_PHASE || 'after'}-${name}`, {
    path: filePath,
    contentType: 'image/png',
  });
  return filePath;
}

module.exports = { screenshotDir, capturePageScreenshot };
