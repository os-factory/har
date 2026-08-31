# Externally-owned worktrees

A HAR **factory line**: an ordered program of stations plus a cumulative gate.

A line is not a verification plugin. Installing it registers stages but never
adds them to `verificationStages` — default `har env verify --full` stays
exactly as fast as it was. Line gate stages run on demand:

```bash
har line gate S0 --line external-worktree
```

If a check should gate *every* verify, it belongs in a verification plugin
(`har plugin create` / `har env add-plugin`), not here.

## Layout

```text
external-worktree/
├── line.manifest.json   # kind: line — what `har line add` applies
├── line.json            # the program: stations, gate, handoff
├── stages/external-worktree-gate.sh   # extra gate stage — registered, NOT on verify
└── README.md
```

## Stations

1. `S0`
2. `S1`
3. `S2`
4. `S3`

## The ratchet

`gate.stages[].fromStation` tags a stage as required at that station **and
every later one**. Adding a station must never drop an earlier station's
stages — that is what `gate.cumulative: true` means, and it is contract.

## Install channels

```bash
har line add external-worktree                        # this repo (.har/lines/external-worktree)
har line add ./external-worktree                      # local path
har line add github:acme/external-worktree            # git
har line add @acme/external-worktree                  # npm
```

Publishing needs no format change: add a `package.json` and push.
