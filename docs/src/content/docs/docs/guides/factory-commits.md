---
title: Record Factory Commits proofs
description: Record each full verification as a Factory Commits proof in git notes, then show and verify it.
---

[Factory Commits](https://github.com/os-factory/factory-commits) is an open
convention for recording in git how each change was produced and verified. A proof
says which work unit a change belongs to, which checks ran on the exact tree and
whether they passed. It uses git trailers, git notes and
[in-toto](https://in-toto.io/) statements. HAR is one producer. Any tool that
follows the spec can write or verify the same proofs.

Since HAR 2.0, when `git factory` is installed, every `har env verify --full`
becomes a `factory-run` statement about the verified tree, and the commit of that
tree gets the statement as a note in `refs/notes/factory`. The note stays local
until you push it.

## Levels

Each commit is reported at one level:

| Level | Name | The commit has… |
|---|---|---|
| **L0** | Linked | a `Work-Unit` or `Factory-Run` trailer |
| **L1** | Recorded | a note with a valid statement for its exact tree, verdict `pass` |
| **L2** | Signed | L1, signed by a trusted signer |
| **L3** | Gated | L2, plus a statement from a trusted merge gate |

HAR writes unsigned statements, so HAR-produced commits reach **L1**. L2 and L3 need
a signer and a merge gate, defined in the
[spec](https://github.com/os-factory/factory-commits/blob/main/SPEC.md).

## Install `git factory`

HAR builds the predicate. The `git-factory` executable does everything else: the
statement, the envelope, notes, trailers and verification. It is not published to
npm yet, so build it from the factory-commits repository:

```bash
git clone https://github.com/os-factory/factory-commits.git
cd factory-commits/packages/factory-proof
npm ci && npm run build && npm install -g .
git factory --version
```

HAR looks for `git-factory` on `PATH`. To use a copy that is not on `PATH`, export
`HAR_FACTORY_PROOF_BIN` with the path to the executable. If that path is not
executable, HAR treats `git-factory` as missing and does not fall back to `PATH`.

## Choose a mode

The mode is set per repository in `.har/harness.env`:

```bash
HAR_FACTORY_PROOF=notes            # off | notes | notes+trailers (unset: notes, local only)
```

- **Unset (the 2.0 default)** behaves like `notes`, but only locally and only when
  `git-factory` is installed. Without `git-factory`, HAR stays silent: no hint on
  verify or commit. `har hooks install` does not run `git factory setup`, so your
  git config and fetch refspecs are unchanged.
- **`off`** turns proofs off: no attestation, no note.
- **`notes`**, set explicitly, writes a note for each commit of a verified tree.
  `har hooks install` also runs `git factory setup`, which adds the
  `refs/notes/factory` fetch refspec and sets `notes.rewriteRef` so notes survive
  rebase and amend. When `git-factory` is missing, HAR prints a one-line hint.
- **`notes+trailers`** does the same, and adds a `commit-msg` hook that writes
  `Work-Unit`, `Factory-Run` and `Factory-Attestation` trailers on commits of a
  verified tree. Trailers rewrite commit messages, so they are never on by default.

The `post-commit` hook writes the notes, so install, or re-install, the commit hooks:

```bash
har hooks install
```

Re-run `har hooks install` after changing the mode. `har hooks uninstall` removes the
hooks, and undoes `git factory setup` when the mode was set explicitly.
`har hooks status` shows the mode and whether it comes from `harness.env` or the
default.

## What happens on verify and commit

1. `har env verify 1 --full` records the validation as usual. HAR then builds a
   `factory-run` predicate from it (stage ids, statuses, durations, verdict, work
   unit, attempt) and calls `git factory attest`. The attestation is stored next to
   the validation record, in `.har/validations/<tree>.attestation.json`.
2. You commit the verified tree. With `notes+trailers`, the `commit-msg` hook adds
   the trailers first.
3. The `post-commit` hook adds the attestation to the new commit's note in
   `refs/notes/factory`.

If you [send telemetry to a backend](/docs/guides/otlp-backends/), the same verify
also emits a verification trace whose `factory.run.id` and `factory.git.tree` match
the proof's run id and tree.

Only a passing full validation of the exact committed tree gets a note or trailers.
Commit a different tree, or commit after a failed verify, and nothing is added.

## Show and verify proofs

```bash
har proof show                        # note and trailers on HEAD
har proof show <rev> --json
har proof verify                      # HEAD, must reach L1
har proof verify main..HEAD           # every commit in a range
har proof verify --min-level L2 --allowed-signers .github/allowed_signers
```

Both commands pass `git factory show` and `git factory verify` through. `--json`
prints `git factory`'s JSON as is. Exit codes come from `git factory`: `0` ok, `1`
verification failed (a commit below `--min-level`, or problems found), `2` usage or
environment error, including a missing `git-factory`. The default minimum level is L1
for one commit and none for a range.

MCP agents use `har_proof_show` and `har_proof_verify`.

## Push and fetch notes

Git does not push or fetch notes by default.

```bash
git push origin refs/notes/factory    # publish your notes
git fetch origin                      # fetches refs/notes/factory too, after git factory setup
```

The fetch refspec that `git factory setup` adds is forced: a fetch replaces your
local `refs/notes/factory` with the remote one. Push local notes before you fetch.
On shared branches the spec recommends that only the merge gate pushes notes.

## Squash merges

A statement names a git **tree**, not a commit. Squash, rebase and amend often keep
the tree, so the proof still applies. But the note stays on the commit it was
attached to, and a squash creates a new commit:

- If the branch was up to date with its base, the squash commit has the verified
  tree. A gate (or you, with `git factory note add <commit> --attestation <file>`)
  can copy the attestation onto it.
- If the base moved, the merged tree differs from everything verified, and the
  proof does not apply. Re-verify the merged tree.

To keep merged commits provable, require branches to be up to date before merging,
or use a merge queue. The
[merge gate extension](https://github.com/os-factory/factory-commits/blob/main/extensions/merge-gate.md)
describes the full L3 flow.

## Privacy

History is permanent and often public. A HAR proof contains:

- the repository URL, with credentials stripped;
- the tree hash, the HAR validation id and its start and end times;
- the work unit id and tracker (for example `github`), and the attempt id;
- the verify policy (`har-verify-full`), a hash of `.har/stages.json`, and each stage's
  id, kind, status and duration;
- the HAR version and whether it ran locally or in CI.

It never contains prompts, agent output, stage logs, file contents, absolute
paths, or work unit titles or URLs.

## Fail-open

Proofs never block verify, a commit or a launch. When `git-factory` fails, HAR
prints one line and carries on. A missing `git-factory` also gets one line when you
set the mode explicitly, and none under the default. The commit is made without a note, and
the validation is recorded as usual. Install `git-factory` and re-run
`har env verify --full` before your next commit to get a proof for it.

See also [Verification & commit gate](/docs/guides/verification/#factory-commits-proofs).
