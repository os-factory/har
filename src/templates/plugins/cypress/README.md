# Cypress HAR plugin

This plugin was added by `har env add-plugin cypress`. It registers a `cypress-e2e` stage and scaffolds a minimal Cypress end-to-end suite.

## Next steps

```bash
npm install
npx cypress verify
har env launch 1
./.har/stages/cypress-e2e.sh 1
```

See `.har/stages/CYPRESS.md` for adaptation checklist, ports, and artifact layout.
