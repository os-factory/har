#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

async function main() {
  const playwrightPath = path.join(__dirname, '../docs/node_modules/playwright');
  const { chromium } = require(playwrightPath);
  const outDir = path.resolve(__dirname, '../docs/public/assets');
  fs.mkdirSync(outDir, { recursive: true });

  const table = `REC      REPO               SLOT   AGE   WORKTREE / REASON
----------------------------------------------------------------------------------------------------
review   har-portal         1      3d    /home/dev/worktrees/onboarding-har-agent-1-nvjg
         active session (3d) — keep unless finished
keep     har-portal         4      2d    /home/dev/worktrees/main-3c05-har-agent-4-c8m4
         pinned with --keep
teardown aicore             2      11d   /home/dev/worktrees/ci-runtimes-har-agent-2-jzc4
         idle 11d, clean
remove_orphan har-portal    -      -     /home/dev/worktrees/main-b8c5-har-agent-1-8l0o
         orphan worktree — no slot registry`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; background: #0d1117; color: #c9d1d9; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .wrap { padding: 28px 32px; width: 980px; }
    h1 { font-size: 18px; color: #58a6ff; margin: 0 0 16px; font-weight: 600; }
    pre { margin: 0; white-space: pre-wrap; line-height: 1.45; font-size: 13px; }
    .hint { margin-top: 18px; color: #8b949e; font-size: 12px; }
    .cmd { color: #79c0ff; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>$ har env cleanup --dry-run --keep har-portal:4</h1>
    <pre>${table}</pre>
    <div class="hint">Dry run — no changes made. Approve rows interactively or pass <span class="cmd">--yes</span>.</div>
  </div>
</body>
</html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1040, height: 520 } });
  await page.setContent(html, { waitUntil: 'load' });
  const outPath = path.join(outDir, 'har-env-cleanup-dry-run.png');
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();
  process.stdout.write(`Wrote ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
