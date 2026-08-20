# Adapt this iOS harness to the project

You are adapting a freshly scaffolded iOS mobile app harness. Read the existing repo
structure, then make the changes listed below. Commit when done.

## 1 — Read before editing

- `AGENTS.md` at the repo root (overview and do-nots)
- `.har/README.md` (harness index)
- `.har/harness.env` (all config vars)
- `.har/stages.json` (stage registry)
- Root of the repo: look for `*.xcworkspace`, `*.xcodeproj`, `Podfile`, `Package.swift`

## 2 — Set Xcode project config in `.har/harness.env`

| Variable | What to set |
|----------|-------------|
| `HARNESS_XCODE_WORKSPACE` | Relative path to `.xcworkspace` (e.g. `MyApp.xcworkspace`). Use when CocoaPods or a workspace is present. Leave empty otherwise. |
| `HARNESS_XCODE_PROJECT` | Relative path to `.xcodeproj` (e.g. `MyApp.xcodeproj`). Only set when no workspace. |
| `HARNESS_XCODE_SCHEME` | Name of the shared Xcode scheme (must be marked Shared in Xcode → Product → Scheme → Manage Schemes). |
| `HARNESS_SIMULATOR_NAME` | Display name exactly as shown in `xcrun simctl list devices` (e.g. `iPhone 16`). |
| `HARNESS_BUNDLE_ID` | App bundle identifier from the Xcode target (e.g. `com.example.myapp`). |

If the project is generated (`Project.swift`, `project.yml`, or a `Podfile` with no
tracked `.xcworkspace`), still set the path the generator produces — launch runs
`tuist generate` / `xcodegen generate` / `pod install` when the file is absent from
a fresh worktree. Use `HARNESS_INSTALL_CMD` only when that default is wrong; it then
owns provisioning outright.

Run `./.har/setup-infra.sh` after editing to confirm the simulator boots.

## 3 — Verify `.har/verify.sh` builds and tests correctly

Run `./.har/launch.sh 1`, then `./.har/verify.sh 1`.

Common adaptations:
- If the project uses a custom test plan, add `-testPlan MyTests` to the `xcodebuild test` invocation.
- If SwiftLint is not used, remove or comment out the `lint` step.
- If there are UI tests that require a running app, move them to a RocketSim flow (`har env add-plugin rocketsim`) rather than xcodebuild tests.

## 4 — Add the RocketSim plugin (recommended)

```bash
har env add-plugin rocketsim
```

Then adapt `flows/example-smoke.sh` to navigate to your app's main screen and verify it loads.
Read `.har/stages/ROCKETSIM.md` for the full authoring guide.

## 5 — Update `AGENTS.md` (repo root)

Replace the TODO section with:
- Which Xcode scheme and simulator are used
- How to run unit tests manually
- How to add a new RocketSim user flow

## 6 — Verify everything passes

```bash
./.har/verify.sh 1 --full
```

All steps should return ✓. Commit the adapted harness in the session worktree.
