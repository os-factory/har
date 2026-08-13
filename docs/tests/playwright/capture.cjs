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
 * Scroll-reveal sections start hidden until IntersectionObserver fires.
 * Full-page screenshots taken from the top would otherwise capture empty gaps.
 */
async function preparePageForScreenshot(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.reveal').forEach((element) => {
      element.classList.add('is-visible');
    });
  });
  // Match .reveal transition duration in global.css.
  await page.waitForTimeout(750);
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
  await preparePageForScreenshot(page);
  await page.screenshot({ path: filePath, fullPage: true, timeout: 60_000 });
  await testInfo.attach(`${process.env.PW_SCREENSHOT_PHASE || 'after'}-${name}`, {
    path: filePath,
    contentType: 'image/png',
  });
  return filePath;
}

module.exports = { screenshotDir, preparePageForScreenshot, capturePageScreenshot };
