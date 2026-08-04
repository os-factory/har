# Maintain / repair the har harness

The `.har/` harness has drifted from the repository (stack changed, launch/verify broken, stale scripts or docs). Bring it back in sync — do every step yourself.

## 1. Run maintain

```bash
har env maintain
```

This compares the harness against the current templates and repository, refreshes har-owned files, and prints an adaptation prompt (also written to `.har/ADAPT-PROMPT.md`).

## 2. Perform the adaptation yourself

Read `.har/ADAPT-PROMPT.md` and execute its instructions now, in this session: reconcile `.har/` scripts (`launch.sh`, `verify.sh`, `setup-infra.sh`, `harness.env`, `stages.json`) and `AGENTS.md` with the repository's current stack, ports, and commands. Preserve intentional project-specific customizations — fix drift, don't blindly reset.

Also check stage drift: compare the repository's current check commands (package.json scripts, Makefile, CI) against the stages registered in `.har/stages.json`. Register missing checks (`har env add-stage <id> --custom --command "..." --verification`), and remove or fix stages whose commands no longer exist. `.har/STAGES.md` documents the contract.

## 3. Finalize and prove it works

```bash
har env maintain --finalize
har env launch 1
har env verify 1 --full
```

Fix the harness until launch and full verify pass. Tear down afterwards if the slot isn't needed (`har env teardown 1`).

## 4. Commit

After the user confirms:

```bash
git add .har/ AGENTS.md
git commit -m "chore: maintain har harness"
```
