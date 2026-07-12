# Maintain / repair the har harness

The `.har/` harness has drifted from the repository (stack changed, launch/verify broken, stale scripts or docs). Bring it back in sync — do every step yourself.

## 1. Run maintain

```bash
har env maintain
```

This compares the harness against the current templates and repository, refreshes har-owned files, and prints an adaptation prompt (also written to `.har/ADAPT-PROMPT.md`).

## 2. Perform the adaptation yourself

Read `.har/ADAPT-PROMPT.md` and execute its instructions now, in this session: reconcile `.har/` scripts (`launch.sh`, `verify.sh`, `setup-infra.sh`, `harness.env`, `stages.json`) and `AGENT.md` with the repository's current stack, ports, and commands. Preserve intentional project-specific customizations — fix drift, don't blindly reset.

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
git add .har/ AGENT.md
git commit -m "chore: maintain har harness"
```
