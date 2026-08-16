---
title: Architecture
description: HAR's layers, contracts, and extension points.
---

HAR is a layered CLI and MCP control plane:

<pre class="mermaid">
flowchart TD
  cli["CLI adapters"] --> core["core orchestration"]
  mcp["MCP adapters"] --> core
  core --> harness["harness contract and I/O"]
  harness --> utils["generic utilities"]
</pre>

## Layers

| Layer | Responsibility |
| --- | --- |
| `src/cli`, `src/mcp` | Parse and validate boundaries, call core, format results |
| `src/core` | Init/maintain orchestration, execution service, slots, runs, validation, Mission Control sync |
| `src/harness` | Canonical `.har/` contract, manifests, stages, templates, drift, generator |
| `src/utils` | Generic filesystem, shell, logging, path, and validation helpers |
| `packages/schemas` | Shared Zod schemas used by CLI and Mission Control |
| `src/templates` | Generated harness profiles, agent workflows, and verification plugins |
| `control` | Local Next.js Mission Control dashboard |

Dependency direction runs downward. Core never imports CLI or MCP, and harness code
never imports core. Adapters stay thin so CLI and MCP execute the same behavior.

## Public execution seam

`RunService` exposes launch, stage execution, verification, completion, teardown,
and status. A `StageExecutor` is injected; the current implementation executes local
project scripts. This is the seam for a future remote executor without changing the
stage contract.

## Source of truth

Canonical Zod schemas define stage kinds, artifacts, results, run records, slot
registry entries, validation records, and Mission Control payloads. Const arrays
drive TypeScript, input validation, MCP JSON Schema, and tests.

## Open extension points

- project-owned scripts can implement any stack or workflow;
- `stages.json` can register any generic operation;
- **plugins** (`har env add-plugin`) add optional framework bundles without hardcoding APIs — discovered from disk or installed from path/npm/git; they compile to generic stages; agents only talk to the stage registry;
- **profiles** are ordered runtime bundles (`templates/profiles/<id>/`); stack capabilities are detected from marker files, not profile enums;
- executor injection allows local or remote execution.

Plugins are first-class installable bundles. A remote community marketplace can wait
until there is a concrete external publisher.

## Mission Control data flow

CLI/MCP execution stores local run JSON and slot registries. `har control sync`
normalizes and posts repository metadata, runs, and slot status to Mission Control.
The dashboard derives repository health, worktrees, validation pipelines, change
batches, artifacts, and trends from that synchronized evidence.

## Work identity

An optional durable work unit binds external intent to one or more sequential HAR
attempts. Slot IDs remain reusable capacity and telemetry session keys remain
observational correlations. Runs carry work and attempt IDs, while exact-tree
validation stays reusable through a separate binding.

Active, failed, and verified state is derived from evidence. Completion is the only
successful terminal decision and must reference a passing full validation of the
exact tree. See `docs/architecture/decisions/0001-work-identity.md`.
