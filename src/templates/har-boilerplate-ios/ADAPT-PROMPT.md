# Adapt this iOS harness to the project

You are adapting a freshly scaffolded iOS mobile app harness. Read the existing repo
structure, then make the changes listed below. Commit when done.

## 1 — Read before editing

- `AGENTS.md` at the repo root (overview and do-nots)
- `.har/README.md` (harness index)
- `.har/harness.env` (all config vars)
- `.har/stages.json` (stage registry)
- Root of the repo: look for `*.xcworkspace`, `*.xcodeproj`, `Podfile`, `Package.swift`

## 2 — Check the Xcode project config in `.har/harness.env`

`har env init` already reads the project and fills most of this in. **Check what it
wrote before changing anything** — and read the warnings init printed, which name
exactly what it could not resolve.

| Variable | What to set |
|----------|-------------|
| `HARNESS_XCODE_WORKSPACE` | Relative path to `.xcworkspace` (e.g. `MyApp.xcworkspace`). Use when CocoaPods or a workspace is present. Leave empty otherwise. |
| `HARNESS_XCODE_PROJECT` | Relative path to `.xcodeproj` (e.g. `MyApp.xcodeproj`). Only set when no workspace. |
| `HARNESS_XCODE_SCHEME` | Name of the shared Xcode scheme (must be marked Shared in Xcode → Product → Scheme → Manage Schemes). Left unset by init when several schemes matched — pick from the list it printed. |
| `HARNESS_SIMULATOR_NAME` | Device model as listed by `xcrun simctl list devicetypes` (e.g. `iPhone 16`). Init does not set this: the right model depends on the runtimes installed on each machine. |
| `HARNESS_BUNDLE_ID` | App bundle identifier from the Xcode target (e.g. `com.example.myapp`). |

Still showing `MyApp` or `com.example.myapp`? Init could not resolve it — `har env maintain`
reports those placeholders as warnings until they are set.

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
