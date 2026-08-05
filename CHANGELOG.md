# [0.44.0](https://github.com/os-factory/har/compare/v0.43.2...v0.44.0) (2026-08-05)


### Bug Fixes

* **docs:** hardcode PostHog public token for Pages builds ([#145](https://github.com/os-factory/har/issues/145)) ([e78cfb2](https://github.com/os-factory/har/commit/e78cfb21cf840bdb6568e347a26ad80a7ed63a49))


### Features

* make AGENTS.md the canonical agent instruction file ([#147](https://github.com/os-factory/har/issues/147)) ([334ec8e](https://github.com/os-factory/har/commit/334ec8e56927091d0988a79d9554de2db81561fe))

## [0.43.2](https://github.com/os-factory/har/compare/v0.43.1...v0.43.2) (2026-08-04)


### Bug Fixes

* send git remote in control sync payload ([#143](https://github.com/os-factory/har/issues/143)) ([c4efe77](https://github.com/os-factory/har/commit/c4efe773e179ae9ff735e0b439fb2e9e1311f753))

## [0.43.1](https://github.com/os-factory/har/compare/v0.43.0...v0.43.1) (2026-08-04)


### Bug Fixes

* **control:** attribute agent work done in the main checkout ([#142](https://github.com/os-factory/har/issues/142)) ([1eb8ffe](https://github.com/os-factory/har/commit/1eb8ffe0c1e9023de216154c36a1def2952bede6))


### Features

* **docs:** add PostHog analytics via wizard ([#141](https://github.com/os-factory/har/issues/141)) ([3fb27db](https://github.com/os-factory/har/commit/3fb27db98684b8e3a22c61d2c80d817c90dfe015))

# [0.43.0](https://github.com/os-factory/har/compare/v0.42.0...v0.43.0) (2026-08-03)


### Bug Fixes

* **control:** enrich factory work unit detail beyond evidence timeline ([#139](https://github.com/os-factory/har/issues/139)) ([6c510a5](https://github.com/os-factory/har/commit/6c510a5133d9ddcfad8b1825d40603c7e82b363e))


### Features

* **control:** paginate and search Usage sessions with DataTable ([#138](https://github.com/os-factory/har/issues/138)) ([2cd297d](https://github.com/os-factory/har/commit/2cd297d6dafee2012d9018cf595d57c05e2b7c61))
* default session handoff to complete + open a PR ([#135](https://github.com/os-factory/har/issues/135)) ([dff3e11](https://github.com/os-factory/har/commit/dff3e11815bfdfdef46b7868f4ec9e06848da517))

# [0.42.0](https://github.com/os-factory/har/compare/v0.41.0...v0.42.0) (2026-08-03)


### Features

* simplify HAR docs and fix documentation duplications [#121](https://github.com/os-factory/har/issues/121) drift ([#131](https://github.com/os-factory/har/issues/131)) ([a781d4d](https://github.com/os-factory/har/commit/a781d4d59a652e3f38a8320d41351333271e8e27))

# [0.41.0](https://github.com/os-factory/har/compare/v0.40.0...v0.41.0) (2026-08-03)


### Features

* **control:** batch + incrementally sync runs so large histories don't fail ([#129](https://github.com/os-factory/har/issues/129)) ([0f79155](https://github.com/os-factory/har/commit/0f79155c0c90a85b375eb5cd2e5e77e98a9f7d66))

# [0.40.0](https://github.com/os-factory/har/compare/v0.39.0...v0.40.0) (2026-08-03)


### Bug Fixes

* **telemetry:** prevent cross-slot harvest and unsafe OTEL attribution ([#84](https://github.com/os-factory/har/issues/84)) ([#126](https://github.com/os-factory/har/issues/126)) ([c282045](https://github.com/os-factory/har/commit/c282045877c2b7b984e93690b3bd92ff3f97f8a6))


### Features

* **control:** refresh expired portal ingest token on 401 instead of failing sync ([#128](https://github.com/os-factory/har/issues/128)) ([b5af037](https://github.com/os-factory/har/commit/b5af0376e09a4d3167d7162370d8be50ffaa555f))

# [0.39.0](https://github.com/os-factory/har/compare/v0.38.1...v0.39.0) (2026-08-03)


### Features

* **control:** auto-sync to portal on activity edges; retire the watch timer ([#125](https://github.com/os-factory/har/issues/125)) ([de2f32e](https://github.com/os-factory/har/commit/de2f32e4ac6d887791f25f0e69f40785c3d110e6))

## [0.38.1](https://github.com/os-factory/har/compare/v0.38.0...v0.38.1) (2026-08-03)


### Bug Fixes

* **telemetry:** stop parent cwd sessions matching child worktree slots ([#124](https://github.com/os-factory/har/issues/124)) ([2d6d069](https://github.com/os-factory/har/commit/2d6d06995e9de1c4881fca1c49bab5075b3b3418))

# [0.38.0](https://github.com/os-factory/har/compare/v0.37.0...v0.38.0) (2026-08-03)


### Features

* **control:** detect repos from the registry only and auto-register on any command ([#122](https://github.com/os-factory/har/issues/122)) ([1d040fd](https://github.com/os-factory/har/commit/1d040fd9b9baa9c9746f4b4558c150a33afaa8aa))
* **onboard:** ask how many agents to run in parallel ([#123](https://github.com/os-factory/har/issues/123)) ([0ff1783](https://github.com/os-factory/har/commit/0ff17830c6e4ae8d2f0cb09bb72d64b9c86d694d))
* remove launch --replace; require teardown then launch ([#121](https://github.com/os-factory/har/issues/121)) ([0410b16](https://github.com/os-factory/har/commit/0410b162bafba013f8537e8a45f78b2ef951c6df))

## [0.37.0](https://github.com/os-factory/har/compare/v0.36.2...v0.37.0) (2026-08-03)


### Features

* **harness:** improve invalid slot errors and raise max slots to 5 ([#119](https://github.com/os-factory/har/issues/119)) ([02455de](https://github.com/os-factory/har/commit/02455deda8eb9bf643bdad335f6175fba98831c8))

## [0.36.2](https://github.com/os-factory/har/compare/v0.36.1...v0.36.2) (2026-08-02)


### Bug Fixes

* **telemetry:** register repos, parse otel-hook prompts, improve slot attribution ([#117](https://github.com/os-factory/har/issues/117)) ([0a738d8](https://github.com/os-factory/har/commit/0a738d8da5f6269fe08fbe8f1ab66192ffdf5242))

## [0.36.1](https://github.com/os-factory/har/compare/v0.36.0...v0.36.1) (2026-08-01)


### Bug Fixes

* **docs:** align hero pipeline durations and sharpness ([#112](https://github.com/os-factory/har/issues/112)) ([7e58962](https://github.com/os-factory/har/commit/7e58962b072c7f516a49f592a0b27c9a79ea367b))

# [0.36.0](https://github.com/os-factory/har/compare/v0.35.0...v0.36.0) (2026-08-01)


### Features

* **docs:** ReactFlow verification pipeline on landing hero ([#111](https://github.com/os-factory/har/issues/111)) ([2b1dd10](https://github.com/os-factory/har/commit/2b1dd10d6bc5c45988d3cb4dc0a51f6e3b13b925))

# [0.35.0](https://github.com/os-factory/har/compare/v0.34.0...v0.35.0) (2026-08-01)


### Bug Fixes

* **docs:** polish teams section form and blueprint grid ([#110](https://github.com/os-factory/har/issues/110)) ([5d8b35c](https://github.com/os-factory/har/commit/5d8b35c75524d798b1217ca8bc8355cee2234d17))


### Features

* **maintain:** detect drift for installed verification plugins ([#108](https://github.com/os-factory/har/issues/108)) ([fdfea2b](https://github.com/os-factory/har/commit/fdfea2b17b2b0501b0c836d29082ef6ea0689003))
* **plugin:** document HAR harness contract in playwright plugin config  ([#107](https://github.com/os-factory/har/issues/107)) ([b1320ce](https://github.com/os-factory/har/commit/b1320ce49eef2e1837b20658e9a4fa13fa49bae4))

# [0.34.0](https://github.com/os-factory/har/compare/v0.33.1...v0.34.0) (2026-08-01)


### Features

* **docs:** add enterprise team CTA with Web3Forms registration ([#106](https://github.com/os-factory/har/issues/106)) ([58dfd4f](https://github.com/os-factory/har/commit/58dfd4fc634b9e2b7d50ab6d1410731263d89bc8))

## [0.33.1](https://github.com/os-factory/har/compare/v0.33.0...v0.33.1) (2026-07-31)


### Bug Fixes

* **control:** sync to local Mission Control when portal is configured ([#105](https://github.com/os-factory/har/issues/105)) ([f9bf43b](https://github.com/os-factory/har/commit/f9bf43b6459d8030c11f249e6e718c654b9a451d))

# [0.33.0](https://github.com/os-factory/har/compare/v0.32.3...v0.33.0) (2026-07-31)


### Features

* add interactive har onboard first-run wizard ([#103](https://github.com/os-factory/har/issues/103)) ([3c7d0b7](https://github.com/os-factory/har/commit/3c7d0b70b93bb47fe8849c45fba87d2628011030))

## [0.32.3](https://github.com/os-factory/har/compare/v0.32.2...v0.32.3) (2026-07-30)


### Bug Fixes

* **control:** attribute IDE OTEL by workspace, not last launch ([#102](https://github.com/os-factory/har/issues/102)) ([31cf6c3](https://github.com/os-factory/har/commit/31cf6c31571f0ceccb2fea73a0cca581d476622d))

## [0.32.2](https://github.com/os-factory/har/compare/v0.32.1...v0.32.2) (2026-07-30)


### Bug Fixes

* **telemetry:** stop writing unknown _comment into otel-hook config ([#101](https://github.com/os-factory/har/issues/101)) ([0ebfd2d](https://github.com/os-factory/har/commit/0ebfd2de946366d22c40f82cf72ef35c5a1dcf89))

## [0.32.1](https://github.com/os-factory/har/compare/v0.32.0...v0.32.1) (2026-07-30)


### Bug Fixes

* **harness:** point stage SCRIPT_DIR at .har/ for slot registry ([#100](https://github.com/os-factory/har/issues/100)) ([3cbe8ce](https://github.com/os-factory/har/commit/3cbe8ce88d57f21be3e4ac725f6aa3f032ea24f2))

# [0.32.0](https://github.com/os-factory/har/compare/v0.31.1...v0.32.0) (2026-07-30)


### Features

* **control:** carry session-usage userEmail and verify coverage through portal sync ([#99](https://github.com/os-factory/har/issues/99)) ([83d0828](https://github.com/os-factory/har/commit/83d0828c8ff595d8f61e9b1c8905a818c9bd925e))

## [0.31.1](https://github.com/os-factory/har/compare/v0.31.0...v0.31.1) (2026-07-29)


### Bug Fixes

* **control:** normalize HAR token buckets for genai-prices ([#98](https://github.com/os-factory/har/issues/98)) ([970d45b](https://github.com/os-factory/har/commit/970d45ba1e1e9ffbd2cc19e2b9bda310e0c01c71))
* **telemetry:** fully retire legacy Python otel-hook registrations ([#97](https://github.com/os-factory/har/issues/97)) ([4167ca6](https://github.com/os-factory/har/commit/4167ca6b9c991f931623962cb99840133219f5cc))

# [0.31.0](https://github.com/os-factory/har/compare/v0.30.0...v0.31.0) (2026-07-29)


### Features

* **control:** estimate and persist LLM costs via genai-prices ([#96](https://github.com/os-factory/har/issues/96)) ([3d32181](https://github.com/os-factory/har/commit/3d3218103339a444afbfb0de86ee9741ae15158c))

# [0.30.0](https://github.com/os-factory/har/compare/v0.29.0...v0.30.0) (2026-07-29)


### Features

* **control:** richer session events table and model-aware usage ([#95](https://github.com/os-factory/har/issues/95)) ([09a809e](https://github.com/os-factory/har/commit/09a809eb8ece906907bfe7f84e3ed6ef95995852))
* **telemetry:** replace Python hooks with TypeScript package ([#92](https://github.com/os-factory/har/issues/92)) ([c1a403e](https://github.com/os-factory/har/commit/c1a403ed6fd0f5b5a2571d95bfb6e5b56c189e8f))

# [0.29.0](https://github.com/os-factory/har/compare/v0.28.0...v0.29.0) (2026-07-29)


### Features

* **control:** bulk-select and delete session worktrees in Operations ([#94](https://github.com/os-factory/har/issues/94)) ([846e486](https://github.com/os-factory/har/commit/846e486b60156d4845ae8c0dd675b3dcdc311d9d))

# [0.28.0](https://github.com/os-factory/har/compare/v0.27.0...v0.28.0) (2026-07-29)


### Features

* **control:** Mission Control factory reset to clear dashboard data ([#93](https://github.com/os-factory/har/issues/93)) ([47cabc1](https://github.com/os-factory/har/commit/47cabc1cc5c0be0502489d7671fd5de01516d038))

# [0.27.0](https://github.com/os-factory/har/compare/v0.26.0...v0.27.0) (2026-07-29)


### Features

* **control:** har control sync incremental portal push via a per-(repo, portal) watermark ([#91](https://github.com/os-factory/har/issues/91)) ([a8e01a1](https://github.com/os-factory/har/commit/a8e01a1b0611365061cb11a3f261cfae252be097))

# [0.26.0](https://github.com/os-factory/har/compare/v0.25.0...v0.26.0) (2026-07-29)


### Features

* **control:** har control sync interactive multi-repo selection with persisted choice ([#88](https://github.com/os-factory/har/issues/88)) ([dac1437](https://github.com/os-factory/har/commit/dac1437b0450e101e32c884590a69dc710294b15))
* rename stage-templates to plugins ([#89](https://github.com/os-factory/har/issues/89)) ([79f5eea](https://github.com/os-factory/har/commit/79f5eea90d4cc0661c60634d77de96496336522d))
* **telemetry:** enable full telemetry including prompts by default ([#90](https://github.com/os-factory/har/issues/90)) ([44b10da](https://github.com/os-factory/har/commit/44b10da613c1dc6ce6c9e94794455a2b4c8db366))

# [0.25.0](https://github.com/os-factory/har/compare/v0.24.0...v0.25.0) (2026-07-29)


### Features

* **control:** forward persisted usage from Mission Control on portal sync ([#87](https://github.com/os-factory/har/issues/87)) ([c3f2c1e](https://github.com/os-factory/har/commit/c3f2c1e9c6659a10f1d755958ad33daec655b92d))

# [0.24.0](https://github.com/os-factory/har/compare/v0.23.0...v0.24.0) (2026-07-27)


### Features

* **cli:** clipboard copy for adaptation prompts ([#85](https://github.com/os-factory/har/issues/85)) ([266ce9f](https://github.com/os-factory/har/commit/266ce9f9b73890b7f10d4b8c312926a8b8108d07))

# [0.23.0](https://github.com/os-factory/har/compare/v0.22.0...v0.23.0) (2026-07-24)


### Features

* **control:** forward full sync payload to a har-portal instance ([#83](https://github.com/os-factory/har/issues/83)) ([0865db3](https://github.com/os-factory/har/commit/0865db3ae1e55791513b439c647ffd24542e1be1))

# [0.22.0](https://github.com/os-factory/har/compare/v0.21.0...v0.22.0) (2026-07-24)


### Features

* authenticate har CLI/control push to a har-portal instance ([#82](https://github.com/os-factory/har/issues/82)) ([57deba2](https://github.com/os-factory/har/commit/57deba2530217bb5c7acd56aab8a2303bc864606))

# [0.21.0](https://github.com/os-factory/har/compare/v0.20.0...v0.21.0) (2026-07-24)


### Features

* add durable work identity and Factory control plane ([#80](https://github.com/os-factory/har/issues/80)) ([3a1d961](https://github.com/os-factory/har/commit/3a1d961aa9546e9abbedb0c898fb006a70d2c482))

# [0.20.0](https://github.com/os-factory/har/compare/v0.19.0...v0.20.0) (2026-07-23)


### Features

* **cli:** add onboarding preferences and commit gate setup ([#79](https://github.com/os-factory/har/issues/79)) ([196bb6b](https://github.com/os-factory/har/commit/196bb6b7f09c369ac5438d32b1feedc2ba329fd1))

# [0.19.0](https://github.com/os-factory/har/compare/v0.18.1...v0.19.0) (2026-07-23)


### Features

* **cli:** clarify launch lifecycle and new session base ([#74](https://github.com/os-factory/har/issues/74)) ([eb9cbcf](https://github.com/os-factory/har/commit/eb9cbcfcd943ac45678c37376c15d4a040cd033b))
* **control:** unregister repositories from CLI and Mission Control ([#76](https://github.com/os-factory/har/issues/76)) ([ffb9ec7](https://github.com/os-factory/har/commit/ffb9ec74dec9c3a43d57b4c7cd6cf71b7b2de146))

## [0.18.1](https://github.com/os-factory/har/compare/v0.18.0...v0.18.1) (2026-07-23)


### Bug Fixes

* **control:** stop counting session worktrees as repositories ([#72](https://github.com/os-factory/har/issues/72)) ([0ea4a8e](https://github.com/os-factory/har/commit/0ea4a8e30c4173e88efddbe2a27b408f58dadf3a))

# [0.18.0](https://github.com/os-factory/har/compare/v0.17.0...v0.18.0) (2026-07-22)


### Features

* **telemetry:** Cursor/Claude/Codex via OTEL hooks ([#71](https://github.com/os-factory/har/issues/71)) ([0bb7fd1](https://github.com/os-factory/har/commit/0bb7fd1a953ee97949f0b5673c65f973b004b1fd))

# [0.17.0](https://github.com/os-factory/har/compare/v0.16.2...v0.17.0) (2026-07-22)


### Features

* **env:** wire --purpose through CLI and MCP launch ([#69](https://github.com/os-factory/har/issues/69)) ([0c49762](https://github.com/os-factory/har/commit/0c497621239a159b9b75e7299dedbe3d827d30a9))

## [0.16.2](https://github.com/os-factory/har/compare/v0.16.1...v0.16.2) (2026-07-22)


### Bug Fixes

* **control:** clear ghost worktrees after slot teardown ([#70](https://github.com/os-factory/har/issues/70)) ([2feac6a](https://github.com/os-factory/har/commit/2feac6a5d5ae4558d6f7cf27b3b3430d67cf5c5e))

## [0.16.1](https://github.com/os-factory/har/compare/v0.16.0...v0.16.1) (2026-07-21)


### Bug Fixes

* **control:** restore Prisma CLI boot in Docker image ([#67](https://github.com/os-factory/har/issues/67)) ([5f4b5eb](https://github.com/os-factory/har/commit/5f4b5ebdea277b0760226f6f6a80f5bed52c129c))

# [0.16.0](https://github.com/os-factory/har/compare/v0.15.0...v0.16.0) (2026-07-21)


### Bug Fixes

* **docs:** hide newsletter spam trap ([#63](https://github.com/os-factory/har/issues/63)) ([c189cd9](https://github.com/os-factory/har/commit/c189cd9c7579cd56dcbc117997a51571a11a01f6))


### Features

* **control:** align Mission Control palette with docs landing ([#65](https://github.com/os-factory/har/issues/65)) ([6e9600b](https://github.com/os-factory/har/commit/6e9600bd4aabe8476bc75849263ee270be96d09e))

# [0.15.0](https://github.com/os-factory/har/compare/v0.14.2...v0.15.0) (2026-07-21)


### Features

* **docs:** replace docs landing with marketing website ([#61](https://github.com/os-factory/har/issues/61)) ([83f1ca0](https://github.com/os-factory/har/commit/83f1ca003e38bb5bf0a369b62d85a2b1ea93a43b))

## [0.14.2](https://github.com/os-factory/har/compare/v0.14.1...v0.14.2) (2026-07-21)


### Bug Fixes

* unify agent slot limits on stages.json and prefer MCP/CLI hints ([#59](https://github.com/os-factory/har/issues/59)) ([4b5e065](https://github.com/os-factory/har/commit/4b5e065f2306ae5fbeb068a4f0e5819d0b6f5b62))

## [0.14.1](https://github.com/os-factory/har/compare/v0.14.0...v0.14.1) (2026-07-21)


### Bug Fixes

* ship harness gitignore via npm-safe gitignore.template ([#58](https://github.com/os-factory/har/issues/58)) ([5211e7e](https://github.com/os-factory/har/commit/5211e7ebbe0ffc572b9bdbaa481241a8613024a9))

# [0.14.0](https://github.com/os-factory/har/compare/v0.13.1...v0.14.0) (2026-07-17)


### Features

* **control:** Mission Control IA, richer OTEL, and board polish ([#57](https://github.com/os-factory/har/issues/57)) ([2fb79db](https://github.com/os-factory/har/commit/2fb79dbddc3c886a5d887ff13a712249d7bee9a7))

## [0.13.1](https://github.com/os-factory/har/compare/v0.13.0...v0.13.1) (2026-07-17)


### Bug Fixes

* har env init --no-agents no longer crashes ([#56](https://github.com/os-factory/har/issues/56)) ([97d8c32](https://github.com/os-factory/har/commit/97d8c32692430d754cc20199ffec47615eb97cf3))

# [0.13.0](https://github.com/os-factory/har/compare/v0.12.1...v0.13.0) (2026-07-17)


### Features

* **control:** run Mission Control on embedded SQLite, drop docker-compose ([#54](https://github.com/os-factory/har/issues/54)) ([93c40ff](https://github.com/os-factory/har/commit/93c40ff1e3eaca85904175a9926b6989ae7b2f6c))

## [0.12.1](https://github.com/os-factory/har/compare/v0.12.0...v0.12.1) (2026-07-16)


### Bug Fixes

* Docker build stage + publish Docker before npm ([#53](https://github.com/os-factory/har/issues/53)) ([863eb16](https://github.com/os-factory/har/commit/863eb16d7ad2a4b184ed6b7c2d9ac470890d66ad))

# [0.12.0](https://github.com/os-factory/har/compare/v0.11.0...v0.12.0) (2026-07-16)


### Features

* Claude Code and Codex usage telemetry in Mission Control ([#52](https://github.com/os-factory/har/issues/52)) ([87d876c](https://github.com/os-factory/har/commit/87d876ce88116a6e1f9784a14a3b593a64c7e869))

# [0.11.0](https://github.com/os-factory/har/compare/v0.10.0...v0.11.0) (2026-07-12)


### Features

* improve stages flow and setup ([#49](https://github.com/os-factory/har/issues/49)) ([a4bc31f](https://github.com/os-factory/har/commit/a4bc31f217fecae12b32a4e891bf9143f86fca73))

# [0.10.0](https://github.com/os-factory/har/compare/v0.9.0...v0.10.0) (2026-07-12)


### Features

* plugin claude, codex, cursor support ([#48](https://github.com/os-factory/har/issues/48)) ([26d07b3](https://github.com/os-factory/har/commit/26d07b3ea0096b021c80b23c893bc5de2e971a1b))

# [0.9.0](https://github.com/os-factory/har/compare/v0.8.0...v0.9.0) (2026-07-11)


### Features

* support apple silicon and linux cmd ([#47](https://github.com/os-factory/har/issues/47)) ([f6213d0](https://github.com/os-factory/har/commit/f6213d0d04541f324ea588ad60db01805dcd5d98))

# [0.8.0](https://github.com/os-factory/har/compare/v0.7.0...v0.8.0) (2026-07-11)


### Features

* **control:** add change batch diff viewer in Mission Control ([#46](https://github.com/os-factory/har/issues/46)) ([b2f5c45](https://github.com/os-factory/har/commit/b2f5c45cc403ede780a1f473f11e2087147ed871))

# [0.7.0](https://github.com/os-factory/har/compare/v0.6.0...v0.7.0) (2026-07-10)


### Bug Fixes

* **maintain:** improve ability to maintain har ([#45](https://github.com/os-factory/har/issues/45)) ([3d3a3af](https://github.com/os-factory/har/commit/3d3a3afeaff533fd337e82df5f9f4c27a0e06f4b))


### Features

* **benchmark:** two-phase HAR setup with budget retries and cache invalidation ([#39](https://github.com/os-factory/har/issues/39)) ([e859cc8](https://github.com/os-factory/har/commit/e859cc87acab11c399f14718e889847993a59b09)), closes [#28](https://github.com/os-factory/har/issues/28) [#19](https://github.com/os-factory/har/issues/19)
* resume failed launch without --replace ([#38](https://github.com/os-factory/har/issues/38)) ([#44](https://github.com/os-factory/har/issues/44)) ([3f9b7eb](https://github.com/os-factory/har/commit/3f9b7ebfca7d286ab1a006e438aa99223e80eea0))

# [0.6.0](https://github.com/os-factory/har/compare/v0.5.0...v0.6.0) (2026-07-09)


### Features

* language-agnostic launch provisioning across HAR profiles ([#32](https://github.com/os-factory/har/issues/32)) ([39d6960](https://github.com/os-factory/har/commit/39d69601c1fdf53a67e877594765da897213ad9f)), closes [#21](https://github.com/os-factory/har/issues/21)

# [0.5.0](https://github.com/os-factory/har/compare/v0.4.0...v0.5.0) (2026-07-08)


### Bug Fixes

* **ci:** avoid publishing on specific scope ([#29](https://github.com/os-factory/har/issues/29)) ([b298c59](https://github.com/os-factory/har/commit/b298c592fd43e015599b1730513ebc0f77816ece))
* **ci:** wrong config ([#30](https://github.com/os-factory/har/issues/30)) ([c2bfd07](https://github.com/os-factory/har/commit/c2bfd074a9e43ed2c2493b2f6a1ecea838b5d5fc))


### Features

* tiered verify, smoke pre-fix gate, and benchmark adapt prompt reuse ([#31](https://github.com/os-factory/har/issues/31)) ([6d7c89a](https://github.com/os-factory/har/commit/6d7c89aecaa423c687919dbef0b39db5e7ad71f6)), closes [#22](https://github.com/os-factory/har/issues/22) [#20](https://github.com/os-factory/har/issues/20) [#23](https://github.com/os-factory/har/issues/23)

# [0.4.0](https://github.com/os-factory/har/compare/v0.3.0...v0.4.0) (2026-07-08)


### Features

* **benchmark:** swebench har benchmark ([#26](https://github.com/os-factory/har/issues/26)) ([e779ebf](https://github.com/os-factory/har/commit/e779ebf9518f0be1529bad918ad6faa8a37d53fd)), closes [19-#25](https://github.com/19-/issues/25)

# [0.3.0](https://github.com/os-factory/har/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* **harness:** improve slot resilience and readiness guidance ([#17](https://github.com/os-factory/har/issues/17)) ([d99f0bb](https://github.com/os-factory/har/commit/d99f0bb205cd7fefda86ae9e3122549df0bf24ed))

# [0.2.0](https://github.com/os-factory/har/compare/v0.1.0...v0.2.0) (2026-07-07)


### Bug Fixes

* **ci:** allow release commit ([608dc63](https://github.com/os-factory/har/commit/608dc63370f517b4c481f1c21ec4718561976346))
* **ci:** protect deployment ([791b17e](https://github.com/os-factory/har/commit/791b17eeb01ef1d55a73f8febe40a1a684961024))
* **ci:** remove duplicates CI run tests ([5299d00](https://github.com/os-factory/har/commit/5299d000684374ee1e7215273a689a6d7fd1c34e))
* **ci:** remove permissions of issues ([6be6604](https://github.com/os-factory/har/commit/6be66044e1f116f212c8b50fa0e9e472a59ad22d))
* **ci:** update repo url and fix tests ([c430136](https://github.com/os-factory/har/commit/c430136f53c082398b2f5574181a8af2a289ce07))
* **ci:** use the right secrets ([3199433](https://github.com/os-factory/har/commit/3199433fa27cab28f44c3479f19a3a753c796722))
* **verify:** keep failed steps when output exceeds 50 lines ([#16](https://github.com/os-factory/har/issues/16)) ([39757c9](https://github.com/os-factory/har/commit/39757c990deb54ec51f044d5d20df792196899b9))
* **verify:** use portable millisecond clock on macOS/BSD ([#15](https://github.com/os-factory/har/issues/15)) ([1864a92](https://github.com/os-factory/har/commit/1864a92714a8be80ef7706b40a3ce5b101b6ae82))


### Features

* bump version to 0.1.1 ([d518964](https://github.com/os-factory/har/commit/d518964e46ee2e439404bdbdef90a787e40b3e2a))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release process

Only **`@osfactory/har`** is published to npm. `@har/control` and `@har/schemas` stay
private in the monorepo and ship with the repo / Docker image instead.

Releases are cut automatically when conventional commits merge to `main`. The
[Release workflow](.github/workflows/release.yml) verifies, publishes `@osfactory/har`
to npm, creates the GitHub Release + tag, and pushes `theosfactory/har-control`
(semver tags plus `latest`) in one pipeline. See
[CONTRIBUTING.md](./CONTRIBUTING.md#releases) for maintainer setup.

### Semver policy

| Bump | When | Examples |
|------|------|----------|
| **Patch** | Bug fixes, template tweaks, docs that affect bundled harness files | `fix: correct verify.sh exit code parsing`, `fix: update har-boilerplate launch.sh` |
| **Minor** | New CLI flags, MCP tools, backward-compatible features | `feat: add har env runs export`, `feat(mcp): expose har_list_stages` |
| **Major** | Breaking harness contract, CLI API, or run-record format changes | `feat!: rename stage kinds in stages.json`, `BREAKING CHANGE: drop run JSON v1` |

Commit prefixes map to bumps via [Conventional Commits](https://www.conventionalcommits.org/)
(`fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major).

## [Unreleased]

### Changed

- Public license is **AGPL-3.0-only** with dual-licensing docs (CLA, commercial license, trademark policy)
- GitHub home moved to [antoineFrau/har](https://github.com/antoineFrau/har)

## [0.1.0] - 2026-07-02

First public npm release of `@osfactory/har`.

### Added

- `har env` commands: init, maintain, launch, verify, status, teardown, add-stage
- `har control` commands for local Mission Control (Docker Compose)
- HAR MCP server (`har mcp`) with generic stage and run-history tools
- Bundled `.har/` harness templates (web app and CLI profiles)
- Optional Playwright stage template (`har env add-stage playwright`)
- Run history under `.har/runs/` when using CLI or MCP (not raw shell scripts)

[Unreleased]: https://github.com/antoineFrau/har/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/antoineFrau/har/releases/tag/v0.1.0
