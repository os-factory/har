# Playwright HAR plugin (docs)

Added by `har env add-plugin playwright` and adapted for the Astro docs site.

```bash
cd docs
npm ci
npx playwright install chromium
./.har/launch.sh 1
./.har/stages/browser-e2e.sh 1
```

Screenshot artifacts land under `.har/artifacts/browser-e2e/screenshots/{before,after}/`.
See `.har/stages/PLAYWRIGHT.md` for the before/after contract and UI-change checklist.
