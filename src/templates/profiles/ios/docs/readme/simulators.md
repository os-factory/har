## Simulators

Slots do not share a simulator. Each launch **creates**
`har-<project>-agent-<id>-<model>` — `har-storefront-agent-2-iPhone-17`, say — and
teardown deletes it, so two agents never collide on a destination, on an installed
bundle id, or on a UI session, and the simulators you use by hand are never touched.
Every launch also starts from a pristine device: no app installed, no leftover
store, nothing carried over from the previous session.

| Setting | Effect |
|---------|--------|
| `HARNESS_SIMULATOR_NAME` | The model to create — `iPhone 16`, `iPhone 17 Pro`, `iPad Air 11-inch (M2)`. Empty means the newest model of the family. See `xcrun simctl list devicetypes`. |
| `HARNESS_SIMULATOR_FAMILY` | `auto` (read from the name) \| `iPhone` \| `iPad`. An iPad is only created when this resolves to iPad. |
| `HARNESS_SIMULATOR_UDID` | Run every slot on one existing device instead. Slots then share it — for one-off debugging. |
| `HARNESS_SIMULATOR_SHARED` | `true` restores one shared simulator for all slots, booted by `setup-infra.sh`. |

The runtime is the newest installed iOS that supports the model — a model retired
from recent runtimes still resolves against an older one. When nothing matches,
launch fails and lists the models this machine can create.

If `HARNESS_SIMULATOR_NAME` is not a model but names an existing device, that
device is used as-is and never deleted — how a hand-renamed simulator is targeted.

### Running from an agent sandbox

`xcrun simctl` reaches CoreSimulatorService over XPC. Coding agents that sandbox
their shell (Codex, Claude Code and others) usually deny that lookup, so `simctl`
fails while `xcodebuild` keeps working — every simulator command then dies with
`CoreSimulatorService connection became invalid`. Nothing is missing on the machine.

Launch and teardown say so when it happens. Either run `har env launch <id>` and
`har env teardown <id>` from a normal terminal and let the agent work in the
worktree, or grant the agent unsandboxed access to `xcrun simctl` — the escalation
must cover every subcommand the harness uses (`list`, `create`, `boot`,
`bootstatus`, `shutdown`, `delete`), not just `list`.

The same messages distinguish a second cause: if `xcrun simctl` is missing from
the selected developer directory — no Xcode, or `xcode-select` pointing at the
Command Line Tools — they say so and print the current selection instead of
blaming a sandbox.

The device lands in `.env.agent.<id>` as `HARNESS_SIMULATOR_UDID`,
`HARNESS_SIMULATOR_DEVICE_NAME` and `HARNESS_IOS_DESTINATION` — the model stays in
`HARNESS_SIMULATOR_NAME`, so the two never mean the same thing in one place; what a slot holds is tracked in `.har/simulators/`.
Use `./.har/agent-cli.sh <id> simulator` to see it.
