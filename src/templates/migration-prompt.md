Migrate the `.har/` harness in this repository from the pre-1.0 shape to the 1.0 configuration surface.

## What changes and why

In 1.0 the harness machinery lives once, in the `@osfactory/har` package. `.har/` keeps only what is yours:

- **config** — `harness.env` (pure `KEY=value`, schema-validated)
- **stages** — `stages.json` + `.har/stages/*.sh` (verification as data)
- **hooks** — `.har/hooks/{pre-launch,post-launch,pre-verify,pre-teardown,post-teardown}.sh` (custom lifecycle behavior)
- **plugins** — `.har/plugins/<id>/` local plugins for anything bigger (`har plugin create <id>`)

The `./.har/*.sh` entry points become thin shims (`exec har env … "$@"` with a pinned `npx` fallback), so every surface — raw scripts, `har env`, MCP tools — writes the same run/validation records. Your muscle memory (`./.har/launch.sh 1`, `./.har/verify.sh 1 --full`, `har env launch 1`) keeps working before, during, and after.

{{MIGRATION_SECTION}}

## Step 3 — Lift each residue item

For every row in the residue table above, read its backup under `.har/migrate/backup/` and move the project-specific behavior into the 1.0 model:

- **config** → a `harness.env` schema key (see `@har/schemas` HarnessEnvSchema). Custom keys the schema rejects: keep the value inside the hook/stage that consumes it.
- **stage** → a `stages.json` entry (plain `command`, or a script in `.har/stages/`), listed in `verificationStages` if it gates verify.
- **hook** → the matching `.har/hooks/<hook>.sh`. Hooks receive `HAR_HOOK`, `AGENT_ID`, `WORK_DIR`, `ENV_FILE`, `HAR_HARNESS_DIR`, `HAR_PORT_<NAME>` (contract `HAR_HOOK_CONTRACT=1`). Failing `pre-*` hooks abort the operation; `post-*` failures warn unless `HARNESS_HOOK_POST_FAILURE=fail`. Make hooks executable.
- **plugin** → `har plugin create <id>` scaffolds a local plugin in `.har/plugins/<id>/`; then `har env add-plugin <id>`.
- **review** → usually nothing to keep (the package runtime covers it) — confirm, then move on.

Compare each backup against its replacement only for **project-specific** logic. Do not restore vendored machinery — that is what 1.0 removes.

## Step 4 — Heavily customized harness? Consider eject

If the backups show deep patches to the machinery itself (not just config/stages/hooks material), `har env eject` vendors the full runtime into `.har/runtime/` and hands you ownership of the scripts — explicit, supported, reversible with `har env adopt`. Prefer lifting into hooks when the patch is a lifecycle side effect; eject only when you truly need to own the runtime.

## Step 5 — Verify the migration

1. `har env doctor` — must pass (contract: 1.0, no errors).
2. `har env maintain` — drift report should show only files you deliberately adapted.
3. Full verify on **every configured agent slot** that is in use; at minimum:
   - `har env launch 1`
   - `har env verify 1 --full` (or `./.har/verify.sh 1 --full` — same records either way)
   - `har env complete 1` (or `har env teardown 1`)
4. Exercise anything you lifted into hooks/stages (e.g. per-slot data stores exist in the work dir, custom checks run in `--full`).

## Step 6 — Finalize

Record the migration and clean up the migration artifacts (`.har/migrate/`, this prompt):

    har env maintain --finalize --summary "Migrated pre-1.0 harness to the 1.0 config surface: <what you lifted where>"

## Rules

1. Never edit `.har/manifest.json` by hand — it is managed by the har CLI.
2. Do not delete `.har/migrate/backup/` until finalize — it is the only copy of the pre-1.0 adaptations.
3. Keep `stages.json` stage ids stable — run records and Mission Control reference them.
4. Update `.har/README.md` and `.har/CLAUDE.agent.md` if commands or workflow notes changed.
5. Commit the migrated harness (shims, `harness.env`, `stages.json`, `.har/hooks/`) once verified — `.har/migrate/` and this prompt are transient and stay untracked.
