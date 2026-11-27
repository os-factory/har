# 05 — CLI and MCP surfaces

Two thin adapters over one core; agents get the same behavior and evidence from either.

- **SRF-1** MUST — Every environment operation is available on both CLI (`har env …`, `har line …`, `har control up`) and MCP (`har_*` tools), except the documented human-only holes (`env cleanup`, `add-stage --custom`, `eject`/`adopt`, hooks onboarding, preferences/telemetry/portal login).
- **SRF-2** MUST — CLI and MCP delegate to the same core code paths and write identical run and validation records; MCP execution carries trigger `mcp`, CLI execution `cli`.
- **SRF-3** MUST — Inputs are validated with Zod at the adapter boundary; invalid input is rejected with an error, not coerced.
- **SRF-4** MUST — The layer rules hold: `cli/` and `mcp/` import only `core/`, `harness/`, `utils/` and not each other; `core/` never imports an adapter; `harness/` imports only `utils/`; `utils/` carries no HAR domain concepts.
- **SRF-5** SHOULD — Commands that report results offer structured output (`--json` on CLI, structured content on MCP) alongside human-readable text.
- **SRF-6** MUST — `har onboard` scaffolds a harness, applies the chosen plugins and finishes with an adaptation prompt; on an existing harness it skips init and offers a maintain prompt, and it warns when Docker is unavailable.
- **SRF-7** SHOULD — Onboarding preferences persist partial updates without losing earlier choices and fall back to safe defaults when the file is missing or malformed.
