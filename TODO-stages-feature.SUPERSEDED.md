# SUPERSEDED — stages feature review

The review in `TODO-stages-feature.plan.md` described pre-#49 gaps
(hardcoded `add-stage playwright`, Playwright-only strings, `verify --full`
ignoring `verificationStages`, missing `--custom` / STAGES.md).

Those were fixed in `a4bc31f` (`feat: improve stages flow and setup (#49)`).

Follow-up work (2026-07): renamed installable **stage-templates → plugins**
(`har env add-plugin`), kept runtime **stages** and env **profiles**. Do not
re-implement the obsolete TODO punchlist.
