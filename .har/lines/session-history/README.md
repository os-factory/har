# Session history

A factory line ([#191](https://github.com/os-factory/har/issues/191)) over the
handoff story: full verify records a **content snapshot**; a later commit on
that same tree becomes a **commit binding**. Mission Control's History tab
renders that graph.

## The invariant

A content snapshot is not a commit. It has no parent, author, or message.
Several commits can share one snapshot after rebase or cherry-pick. Proof
belongs to the tree, not to a single SHA.

## Stations

| Station | Question the gate keeps asking | Isolation |
|---|---|---|
| `S0` | Pending snapshots stay distinct from commits; two commits can share one tree | jest |
| `S1` | A real Claude Code session, full verify, and commit produce a binding whose tree matches `HEAD^{tree}` | sandbox `HOME` |

## Run it

```bash
har line status session-history
har line gate S0 --line session-history
har line gate S1 --line session-history
```

`S1` needs a `claude` binary (or `CLAUDE_BIN`). Nothing reaches a real model:
`ANTHROPIC_BASE_URL` points at the occupancy-identity mock.

These stages are absent from `verificationStages`. Routine `har env verify --full`
does not run them.
