## [1.10.0](https://github.com/os-factory/har/compare/v1.9.0...v1.10.0) (2026-09-03)

### Features

* **control:** one slot timeline for runs, snapshots, commits and sessions ([#338](https://github.com/os-factory/har/issues/338)) ([#346](https://github.com/os-factory/har/issues/346)) ([dca98c1](https://github.com/os-factory/har/commit/dca98c114cc6a943714c6ad5228f45693e841f0c))

## [1.9.0](https://github.com/os-factory/har/compare/v1.8.0...v1.9.0) (2026-09-02)

### Features

* **control:** reorganise Mission Control around Now, Work, Repositories and Cost ([#337](https://github.com/os-factory/har/issues/337)) ([#342](https://github.com/os-factory/har/issues/342)) ([b902381](https://github.com/os-factory/har/commit/b90238178fd9329d428fba2ac612704a77b06fbc))

## [1.8.0](https://github.com/os-factory/har/compare/v1.7.0...v1.8.0) (2026-09-02)

### Features

* **control:** strip Mission Control noise and fix review bugs ([#336](https://github.com/os-factory/har/issues/336)) ([#341](https://github.com/os-factory/har/issues/341)) ([d6a72e6](https://github.com/os-factory/har/commit/d6a72e64a4f0962ab6a7fe26e9490ad2e69c47f2))

## [1.7.0](https://github.com/os-factory/har/compare/v1.6.0...v1.7.0) (2026-09-01)

### Features

* **control:** show session history as a content-snapshot graph ([#332](https://github.com/os-factory/har/issues/332)) ([61249a0](https://github.com/os-factory/har/commit/61249a03eb8a32d173dd3544756e9c6a3c8c01f1))

## [1.6.0](https://github.com/os-factory/har/compare/v1.5.0...v1.6.0) (2026-09-01)

### Features

* represent externally-owned worktrees ([#333](https://github.com/os-factory/har/issues/333)) ([fc5029b](https://github.com/os-factory/har/commit/fc5029b8972276a6d1adf7cb63cfe9344a2be22f))

### Bug Fixes

* sync evidence written inside an external workspace ([#334](https://github.com/os-factory/har/issues/334)) ([7aa0a93](https://github.com/os-factory/har/commit/7aa0a93c299d3c035c7a77b9d02e1213e4b02cf1))
* **telemetry:** harvest prompt events from every transcript of a slot ([#308](https://github.com/os-factory/har/issues/308)) ([8754c72](https://github.com/os-factory/har/commit/8754c722f620dc7e8db27890371b54b31ea38e5c))

## [1.5.0](https://github.com/os-factory/har/compare/v1.4.0...v1.5.0) (2026-08-30)

### Features

* **control:** factory line board over the installed bundle ([#305](https://github.com/os-factory/har/issues/305)) ([#326](https://github.com/os-factory/har/issues/326)) ([0db74a1](https://github.com/os-factory/har/commit/0db74a11139584f22af8caf01417d5f0c2f88e47))

### Bug Fixes

* **telemetry:** bound the agent hooks so an unreachable collector cannot stall a turn ([#328](https://github.com/os-factory/har/issues/328)) ([#329](https://github.com/os-factory/har/issues/329)) ([98fa07b](https://github.com/os-factory/har/commit/98fa07b9ace8542cc9e6fa2eabb05d4fed03a39b))

## [1.4.0](https://github.com/os-factory/har/compare/v1.3.0...v1.4.0) (2026-08-30)

### Features

* **control:** scope slot identity to an occupancy, and gate it with a line ([#316](https://github.com/os-factory/har/issues/316)) ([#325](https://github.com/os-factory/har/issues/325)) ([0bea653](https://github.com/os-factory/har/commit/0bea6536afc3a2414ddde077883df6352ac697c5))
* skip re-verify on complete unless the tree changed ([#327](https://github.com/os-factory/har/issues/327)) ([200c189](https://github.com/os-factory/har/commit/200c189f7c8a203dfe74642e9d07575f93da7361))

## [1.3.0](https://github.com/os-factory/har/compare/v1.2.0...v1.3.0) (2026-08-30)

### Features

* har line — install factory lines as bundles that never widen verify ([#304](https://github.com/os-factory/har/issues/304), [#322](https://github.com/os-factory/har/issues/322)) ([#323](https://github.com/os-factory/har/issues/323)) ([0d2c6fd](https://github.com/os-factory/har/commit/0d2c6fd6b4f2379ecc64600bb7f32b182a18d7c1))

## [1.2.0](https://github.com/os-factory/har/compare/v1.1.0...v1.2.0) (2026-08-29)

### Features

* ship factory-line as a managed agent skill ([#319](https://github.com/os-factory/har/issues/319)) ([#320](https://github.com/os-factory/har/issues/320)) ([d29f4d2](https://github.com/os-factory/har/commit/d29f4d2452261a6ea9736825c24d9d4a2fb8a6e3))

## [1.1.0](https://github.com/os-factory/har/compare/v1.0.0...v1.1.0) (2026-08-29)

### Features

* stop generating lifecycle .sh shims ([#314](https://github.com/os-factory/har/issues/314)) ([#321](https://github.com/os-factory/har/issues/321)) ([215819a](https://github.com/os-factory/har/commit/215819a7801e0ef6d003aa4038f390163573d22f))

## [1.0.0](https://github.com/os-factory/har/compare/v0.64.3...v1.0.0) (2026-08-28)

### ⚠ BREAKING CHANGES

* .har/ becomes a configuration surface — the vendored runtime
moves into the package, harness.env becomes schema-validated config, and
.har/CLAUDE.agent.md is retired. See the migration guide.
* collapse the agent instruction surface onto AGENTS.md (#307)
* har plugin create — local plugins in .har/plugins/, retire add-stage --custom (#240) (#283)
* two-signal drift — user-edited vs upstream-updated (#237) (#280)
* profiles become capability manifests (#236) (#278)
* move the harness runtime into the package (#234) (#276)
* verification as data — one stage namespace with quick/full tiers (#231) (#274)
* harness.env becomes pure schema-validated config (#230) (#272)

### release

* HAR 1.0.0 — .har/ becomes a configuration surface ([76d502a](https://github.com/os-factory/har/commit/76d502a1532e58967fc5b0a957157280cc2d9ce0))

### Features

* close CLI/MCP parity gaps and deduplicate the launch guard ([#233](https://github.com/os-factory/har/issues/233)) ([#273](https://github.com/os-factory/har/issues/273)) ([83be53c](https://github.com/os-factory/har/commit/83be53c4fb94f09c9d4dce30cd00c50fadc933e2))
* collapse the agent instruction surface onto AGENTS.md ([#307](https://github.com/os-factory/har/issues/307)) ([ae1f961](https://github.com/os-factory/har/commit/ae1f961bbe66669a164e66d2fad52538ba436cbe))
* dogfood-migrate the repo's three harnesses to the 1.0 config surface ([#242](https://github.com/os-factory/har/issues/242)) ([#289](https://github.com/os-factory/har/issues/289)) ([a3bbaab](https://github.com/os-factory/har/commit/a3bbaab6388dc7fe87d3c50f8f229bd8d0c5a860))
* generate .har scripts as thin shims with pinned npx fallback ([#235](https://github.com/os-factory/har/issues/235)) ([#277](https://github.com/os-factory/har/issues/277)) ([d013907](https://github.com/os-factory/har/commit/d013907b1f36bb9acd1c1f7075bb5e6163459c55))
* har env doctor — harness contract validation ([#232](https://github.com/os-factory/har/issues/232)) ([#275](https://github.com/os-factory/har/issues/275)) ([ce240f2](https://github.com/os-factory/har/commit/ce240f2b5f55389495c2c58729cfb1912b25409b))
* har env eject — explicit runtime ownership for power users ([#239](https://github.com/os-factory/har/issues/239)) ([#282](https://github.com/os-factory/har/issues/282)) ([e8ed3df](https://github.com/os-factory/har/commit/e8ed3dff28d790025d74167ecd5a7dc71f69b07a))
* har plugin create — local plugins in .har/plugins/, retire add-stage --custom ([#240](https://github.com/os-factory/har/issues/240)) ([#283](https://github.com/os-factory/har/issues/283)) ([15575df](https://github.com/os-factory/har/commit/15575dfdd4446fd20c14806ba5d9141b2f627d08))
* harness.env becomes pure schema-validated config ([#230](https://github.com/os-factory/har/issues/230)) ([#272](https://github.com/os-factory/har/issues/272)) ([1652b52](https://github.com/os-factory/har/commit/1652b52c6635f6e8496a1e7776fa01aee5d5f6cb))
* lifecycle hooks — sanctioned user-owned extension points ([#238](https://github.com/os-factory/har/issues/238)) ([#281](https://github.com/os-factory/har/issues/281)) ([030e76b](https://github.com/os-factory/har/commit/030e76b88b13cc4a96984b0b061b7bb03746c03b))
* move the harness runtime into the package ([#234](https://github.com/os-factory/har/issues/234)) ([#276](https://github.com/os-factory/har/issues/276)) ([764f323](https://github.com/os-factory/har/commit/764f323e6e974b963dbe23831bedc1f5c75910f4))
* **plugins:** default add-plugin to skip CI workflows, add --with-ci opt-in ([#195](https://github.com/os-factory/har/issues/195)) (271) ([4af5b05](https://github.com/os-factory/har/commit/4af5b05a10101988c796e3b4d232208dac37b1e0))
* post-add-plugin adaptation prompt with clipboard offer ([#195](https://github.com/os-factory/har/issues/195)) ([#296](https://github.com/os-factory/har/issues/296)) ([c023da6](https://github.com/os-factory/har/commit/c023da6e20a3667ab3c2e125c0fd5cbdf7a5e619))
* profiles become capability manifests ([#236](https://github.com/os-factory/har/issues/236)) ([#278](https://github.com/os-factory/har/issues/278)) ([4855760](https://github.com/os-factory/har/commit/485576065525d06ea782bc84a91ea5c3a31a9c3e))
* two-signal drift — user-edited vs upstream-updated ([#237](https://github.com/os-factory/har/issues/237)) ([#280](https://github.com/os-factory/har/issues/280)) ([76e5bf6](https://github.com/os-factory/har/commit/76e5bf6f7abed88355c69dd057fd9788d7e6a394))
* verification as data — one stage namespace with quick/full tiers ([#231](https://github.com/os-factory/har/issues/231)) ([#274](https://github.com/os-factory/har/issues/274)) ([7698fe4](https://github.com/os-factory/har/commit/7698fe4a6faf589dc781c0353f71aca06319a9ef))
* versioned manifest migrations + maintain-driven MIGRATE prompt ([#241](https://github.com/os-factory/har/issues/241)) ([#287](https://github.com/os-factory/har/issues/287)) ([cb47790](https://github.com/os-factory/har/commit/cb477900c0975f20ea80f60d4840d2c4fbfc24c4))

### Bug Fixes

* 1.0 plugin stage templates + shim guard against pre-1.0 runtime loops ([#290](https://github.com/os-factory/har/issues/290), [#291](https://github.com/os-factory/har/issues/291)) ([#292](https://github.com/os-factory/har/issues/292)) ([6eb8eba](https://github.com/os-factory/har/commit/6eb8eba4ac4235ab064f782b742541f659b6043a))
* **ci:** honor the `!` breaking marker — semantic-release preset was dropping every breaking change ([#312](https://github.com/os-factory/har/issues/312)) ([a07bee5](https://github.com/os-factory/har/commit/a07bee5122474b6e74ed5b93b6f1c0e0edbdb4b3))
* close the 1.0 release-review gaps — attach.sh migration, CI runtime resolution, stale harness docs ([#300](https://github.com/os-factory/har/issues/300)) ([7569ad5](https://github.com/os-factory/har/commit/7569ad5fd5131c96cd890e878352a3f234a083ba))
* surface bugs — mcp launch trigger, status arg, cli setup-infra dead code, quick verify exit, teardown attempt outcome ([#228](https://github.com/os-factory/har/issues/228)) ([#266](https://github.com/os-factory/har/issues/266)) ([bb58597](https://github.com/os-factory/har/commit/bb58597715ddbfe02f1d9086bb68f6d02b02fc59))

## [0.64.3](https://github.com/os-factory/har/compare/v0.64.2...v0.64.3) (2026-08-27)


### Bug Fixes

* count a result record's cache reads once and stop summing it with nested usage ([#294](https://github.com/os-factory/har/issues/294)) ([64a3bcd](https://github.com/os-factory/har/commit/64a3bcdab9787240b4ab3a885d6e873fe15aa7d8))
* derive usage seen timestamps from the transcript, not the sync clock ([#295](https://github.com/os-factory/har/issues/295)) ([6dd180c](https://github.com/os-factory/har/commit/6dd180c8ca80a60df53cdf3ef24404c517e4a6bc))

## [0.64.2](https://github.com/os-factory/har/compare/v0.64.1...v0.64.2) (2026-08-26)


### Bug Fixes

* **control:** hex-encode OTLP trace ids and keep a session on one agent id ([#285](https://github.com/os-factory/har/issues/285)) ([5fc801e](https://github.com/os-factory/har/commit/5fc801e5ae1621494d592057c2d21f54651f300e))
* **control:** stop dropping persisted telemetry silently and page the egress collections ([#284](https://github.com/os-factory/har/issues/284)) ([34c7d8f](https://github.com/os-factory/har/commit/34c7d8f1e54e41c7a5efa6a4bd3859fd62c67873))
* let a corrected harvest lower the usage totals it already reported ([#286](https://github.com/os-factory/har/issues/286)) ([030c7a4](https://github.com/os-factory/har/commit/030c7a4db549d466f890329bb8648d73a45a864c))

## [0.64.1](https://github.com/os-factory/har/compare/v0.64.0...v0.64.1) (2026-08-24)


### Bug Fixes

* bill a repeated Claude message id once and count every slot transcript ([#279](https://github.com/os-factory/har/issues/279)) ([bf378e3](https://github.com/os-factory/har/commit/bf378e3c7545b73b98b9851ede0b285e95df4c6b))

# [0.64.0](https://github.com/os-factory/har/compare/v0.63.0...v0.64.0) (2026-08-21)


### Features

* assign leftover repos to workspaces after hq connect ([#264](https://github.com/os-factory/har/issues/264)) ([5bc2c72](https://github.com/os-factory/har/commit/5bc2c72225e0964a0e20f4b3e68d61904d9c93f6))

# [0.63.0](https://github.com/os-factory/har/compare/v0.62.2...v0.63.0) (2026-08-21)


### Bug Fixes

* docker is required and onboarding should warn the user about it ([#259](https://github.com/os-factory/har/issues/259)) ([7e0efd2](https://github.com/os-factory/har/commit/7e0efd215c8c99d180886237ec8948f97eb2a8d6))


### Features

* named portal targets via har hq connect ([#262](https://github.com/os-factory/har/issues/262)) ([9d6479d](https://github.com/os-factory/har/commit/9d6479deaf0084c46ce00c026e4916a9bcd0c15d))

## [0.62.2](https://github.com/os-factory/har/compare/v0.62.1...v0.62.2) (2026-08-20)


### Bug Fixes

* **ios:** generate the Xcode project at launch and detect the real target ([#251](https://github.com/os-factory/har/issues/251)) ([8e8efd8](https://github.com/os-factory/har/commit/8e8efd899377337dc08a97c18027c9b5c1e4e9df))

## [0.62.1](https://github.com/os-factory/har/compare/v0.62.0...v0.62.1) (2026-08-20)


### Bug Fixes

* **control:** point login at app.harhq.com ([#250](https://github.com/os-factory/har/issues/250)) ([fcacc98](https://github.com/os-factory/har/commit/fcacc9869a9319db80c261ca7e4a1c2437eb33dd))

# [0.62.0](https://github.com/os-factory/har/compare/v0.61.3...v0.62.0) (2026-08-20)


### Bug Fixes

* honor requires-python and uv when provisioning Python venv ([#244](https://github.com/os-factory/har/issues/244)) ([e0d39ec](https://github.com/os-factory/har/commit/e0d39ecc287d3008f3b1e19f2990bfbc9d3c65f6))


### Features

* **control:** send the CLI version on portal sync ([#249](https://github.com/os-factory/har/issues/249)) ([92e1700](https://github.com/os-factory/har/commit/92e1700d5f40f4ddd10550f09f1efd495acac12c))

## [0.61.3](https://github.com/os-factory/har/compare/v0.61.2...v0.61.3) (2026-08-19)


### Bug Fixes

* stop har env verify from dumping duplicate JSON ([#247](https://github.com/os-factory/har/issues/247)) ([df92e12](https://github.com/os-factory/har/commit/df92e12dbb4a3944f4ce4fdf8783d2eb2c42147b))

## [0.61.2](https://github.com/os-factory/har/compare/v0.61.1...v0.61.2) (2026-08-19)


### Bug Fixes

* parse agent env in ecosystem template without dotenv ([#245](https://github.com/os-factory/har/issues/245)) ([5eba73b](https://github.com/os-factory/har/commit/5eba73bd2f68a60ca71745da2c37402c3ae88bb0))

## [0.61.1](https://github.com/os-factory/har/compare/v0.61.0...v0.61.1) (2026-08-19)


### Bug Fixes

* load persisted infra ports after setup-infra.sh ([#246](https://github.com/os-factory/har/issues/246)) ([db6e192](https://github.com/os-factory/har/commit/db6e192c226781a8554bd4648f71359f6d50f9ff))

# [0.61.0](https://github.com/os-factory/har/compare/v0.60.1...v0.61.0) (2026-08-18)


### Bug Fixes

* drop vulnerable tmp transitive via inquirer 12 ([#224](https://github.com/os-factory/har/issues/224)) ([bb93aad](https://github.com/os-factory/har/commit/bb93aad0b5b50286056dd9ccce05257d074933cf))


### Features

* **control:** forward the trajectory ledger to a hosted portal ([#223](https://github.com/os-factory/har/issues/223)) ([ce657e5](https://github.com/os-factory/har/commit/ce657e50a55d94e7eb5d6d8d6808f360569b692c))

## [0.60.1](https://github.com/os-factory/har/compare/v0.60.0...v0.60.1) (2026-08-17)


### Bug Fixes

* drop unused harness generatorVersion ([#222](https://github.com/os-factory/har/issues/222)) ([a91a8ab](https://github.com/os-factory/har/commit/a91a8ab256da2219cd8256cb59f6e133bb796f49))

# [0.60.0](https://github.com/os-factory/har/compare/v0.59.0...v0.60.0) (2026-08-16)


### Features

* **control:** replayable trajectory ledger and split-pane viewer ([#220](https://github.com/os-factory/har/issues/220)) ([6534411](https://github.com/os-factory/har/commit/6534411ba48792bd4d37ac421425302ac4f6bcc6))

# [0.59.0](https://github.com/os-factory/har/compare/v0.58.0...v0.59.0) (2026-08-16)


### Features

* **control:** allow per-repo portal opt-out on register ([#219](https://github.com/os-factory/har/issues/219)) ([599df36](https://github.com/os-factory/har/commit/599df36c8858a7d0534b1dcfb60dc8b427698ad7))

# [0.58.0](https://github.com/os-factory/har/compare/v0.57.0...v0.58.0) (2026-08-16)


### Features

* har env cleanup — discover and teardown stale session worktrees ([#216](https://github.com/os-factory/har/issues/216)) ([b2a2c99](https://github.com/os-factory/har/commit/b2a2c99ca2d612b450af57133c63125ec34f19ac))
* related links on work units ([#217](https://github.com/os-factory/har/issues/217)) ([#218](https://github.com/os-factory/har/issues/218)) ([e80c765](https://github.com/os-factory/har/commit/e80c765a84f06d7fcb9500c94afaccc99aa02c4a))

# [0.57.0](https://github.com/os-factory/har/compare/v0.56.1...v0.57.0) (2026-08-16)


### Features

* plugin-first discovery, ledger, and profile bundles ([#211](https://github.com/os-factory/har/issues/211)) ([bb24a16](https://github.com/os-factory/har/commit/bb24a168f0c482feef01c0b5bd50118cd89118b5))

## [0.56.1](https://github.com/os-factory/har/compare/v0.56.0...v0.56.1) (2026-08-15)


### Bug Fixes

* **telemetry:** pin otel-hook 0.2.0 ([#210](https://github.com/os-factory/har/issues/210)) ([28f5334](https://github.com/os-factory/har/commit/28f5334d4bde37fc9d737c11dfe5c50c40a6527e))

# [0.56.0](https://github.com/os-factory/har/compare/v0.55.0...v0.56.0) (2026-08-14)


### Features

* **control:** add replayable agent trajectories ([#207](https://github.com/os-factory/har/issues/207)) ([ff1afce](https://github.com/os-factory/har/commit/ff1afce72bbfcc752f2c59065f5674691cba2eb9))

# [0.55.0](https://github.com/os-factory/har/compare/v0.54.1...v0.55.0) (2026-08-14)


### Features

* warn when untracked files will be missing from session worktrees ([#206](https://github.com/os-factory/har/issues/206)) ([398e545](https://github.com/os-factory/har/commit/398e5457aeec7cb9940b233c9a0645fbfe0c80d1))

## [0.54.1](https://github.com/os-factory/har/compare/v0.54.0...v0.54.1) (2026-08-13)


### Bug Fixes

* **harness:** tell Mission Control when a slot changes ([#200](https://github.com/os-factory/har/issues/200)) ([63155b1](https://github.com/os-factory/har/commit/63155b11ba548239f05fcc683c7fc1b55439ab30))
* **ios:** distinguish an unusable simctl from a missing iOS runtime ([#201](https://github.com/os-factory/har/issues/201)) ([bd47263](https://github.com/os-factory/har/commit/bd472630500f02dd07d6a9b48d211be91f56e2dd))

# [0.54.0](https://github.com/os-factory/har/compare/v0.53.0...v0.54.0) (2026-08-12)


### Features

* add Semgrep plugin ([#188](https://github.com/os-factory/har/issues/188)) ([3c146ca](https://github.com/os-factory/har/commit/3c146ca825d13ad32221551cbfbed61236809b5c))

# [0.53.0](https://github.com/os-factory/har/compare/v0.52.0...v0.53.0) (2026-08-12)


### Features

* add Trivy plugin ([#187](https://github.com/os-factory/har/issues/187)) ([931b7ea](https://github.com/os-factory/har/commit/931b7ea2ba103201fb89dd8182803e769df5174b))

# [0.52.0](https://github.com/os-factory/har/compare/v0.51.0...v0.52.0) (2026-08-12)


### Features

* add Gitleaks plugin ([#186](https://github.com/os-factory/har/issues/186)) ([c7c6800](https://github.com/os-factory/har/commit/c7c680004f3918273fb15990891ad605b2fa0b7f))

# [0.51.0](https://github.com/os-factory/har/compare/v0.50.1...v0.51.0) (2026-08-12)


### Features

* add Kerno plugin ([#183](https://github.com/os-factory/har/issues/183)) ([f41072e](https://github.com/os-factory/har/commit/f41072e009699cec76c77a07ce4dd67b318d779b))

## [0.50.1](https://github.com/os-factory/har/compare/v0.50.0...v0.50.1) (2026-08-12)


### Bug Fixes

* **control:** keep the portal repo id until a wipe resend lands ([#182](https://github.com/os-factory/har/issues/182)) ([c219ede](https://github.com/os-factory/har/commit/c219edea152750fb176834ecf217899f4c6a4d68))


### Features

* **docs:** add Enterprise page, move demo video into hero lightbox ([#184](https://github.com/os-factory/har/issues/184)) ([adcf25e](https://github.com/os-factory/har/commit/adcf25ecdc1144e29e89149a843b208c6f78b57e))

# [0.50.0](https://github.com/os-factory/har/compare/v0.49.2...v0.50.0) (2026-08-11)


### Features

* **harness:** support bun, pnpm, and yarn for node provisioning ([#174](https://github.com/os-factory/har/issues/174)) ([787f87d](https://github.com/os-factory/har/commit/787f87de9df1d5bdddcc758b0eded6306c126219))

## [0.49.2](https://github.com/os-factory/har/compare/v0.49.1...v0.49.2) (2026-08-11)


### Bug Fixes

* **telemetry:** quote generated env values so spaced repo paths stay source-safe ([#177](https://github.com/os-factory/har/issues/177)) ([631687b](https://github.com/os-factory/har/commit/631687b137ea293fbcf6cd0782a3baf17f08fe9d))

## [0.49.1](https://github.com/os-factory/har/compare/v0.49.0...v0.49.1) (2026-08-11)


### Bug Fixes

* **harness:** quote agent env values in the dogfooded harnesses ([#179](https://github.com/os-factory/har/issues/179)) ([30abefd](https://github.com/os-factory/har/commit/30abefdf2fb11fea7a1da601354ca71652329d84))
* **ios:** keep code signing on the verify test step ([#178](https://github.com/os-factory/har/issues/178)) ([8177284](https://github.com/os-factory/har/commit/81772840ac5615b9015d360d17481dde887a7dad))

# [0.49.0](https://github.com/os-factory/har/compare/v0.48.0...v0.49.0) (2026-08-10)


### Features

* **ios:** give every agent slot its own simulator ([#168](https://github.com/os-factory/har/issues/168)) ([7d319b6](https://github.com/os-factory/har/commit/7d319b60363c046fb13c336c4f8845b55ca39d92))

# [0.48.0](https://github.com/os-factory/har/compare/v0.47.0...v0.48.0) (2026-08-10)


### Features

* **control:** default the login portal instead of erroring ([#164](https://github.com/os-factory/har/issues/164)) ([b328b17](https://github.com/os-factory/har/commit/b328b17166a2d6e22b8d9438fd402789be4f09fe))

# [0.47.0](https://github.com/os-factory/har/compare/v0.46.2...v0.47.0) (2026-08-06)


### Features

* make onboarding skill installation opt-in ([#157](https://github.com/os-factory/har/issues/157)) ([c738f9c](https://github.com/os-factory/har/commit/c738f9c1625549ff05e06d69b9eb16827f0a18e4))

## [0.46.2](https://github.com/os-factory/har/compare/v0.46.1...v0.46.2) (2026-08-05)


### Bug Fixes

* **docs:** polish the mobile header, menu, and search ([#158](https://github.com/os-factory/har/issues/158)) ([0dc5396](https://github.com/os-factory/har/commit/0dc53967453654e0b036e47ec81d3e11961bd214))
* **schemas:** add temporary Cursor model pricing overlay ([#159](https://github.com/os-factory/har/issues/159)) ([2d7444b](https://github.com/os-factory/har/commit/2d7444bc60203fe911a53d2eafe9e866910f7c8e))

## [0.46.1](https://github.com/os-factory/har/compare/v0.46.0...v0.46.1) (2026-08-05)


### Bug Fixes

* preserve AGENTS.md project content on maintain --finalize ([#156](https://github.com/os-factory/har/issues/156)) ([872f2ac](https://github.com/os-factory/har/commit/872f2ac075ba927f2a7b04750a5c2b1426621fad))

# [0.46.0](https://github.com/os-factory/har/compare/v0.45.0...v0.46.0) (2026-08-05)


### Features

* attribute runs and validations to the syncing member ([#151](https://github.com/os-factory/har/issues/151)) ([a0691d2](https://github.com/os-factory/har/commit/a0691d2c89f66471075754b9f80eb68fbdea2e47))

# [0.45.0](https://github.com/os-factory/har/compare/v0.44.0...v0.45.0) (2026-08-05)


### Features

* remove built-in --auto LLM adaptation (bring your own coding agent) ([#150](https://github.com/os-factory/har/issues/150)) ([87fdaaf](https://github.com/os-factory/har/commit/87fdaafe9c73139b31254fb675b9cfa57e925dae))
* streamline work unit binding guidance ([#140](https://github.com/os-factory/har/issues/140), [#148](https://github.com/os-factory/har/issues/148)) ([#152](https://github.com/os-factory/har/issues/152)) ([a3cadc5](https://github.com/os-factory/har/commit/a3cadc531ccaade5ef2551031aa6751403fb055d))

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
