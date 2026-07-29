# Playwright HAR plugin

This plugin was added by `har env add-plugin playwright`. It registers a `browser-e2e` stage and scaffolds a minimal Playwright test suite.

## Next steps

```bash
npm install
npx playwright install
./.har/launch.sh 1
./.har/stages/browser-e2e.sh 1
```

See `.har/stages/PLAYWRIGHT.md` for adaptation checklist and layout.
