#!/usr/bin/env python3
"""Post-campaign analysis, computed entirely from stored artifacts.

Implements the analysis backlog in PILOT-REPORT.md: per-test outcomes, effective verification from
the harness's own run records, verification dynamics, gold-patch overlap, difficulty strata, an
automatic first-pass failure taxonomy, and paired statistics (exact McNemar).

Reads `runs/*/run.json`, `runs/*/score/*/score.summary.json`, `runs/*/*/sessions/*.stream.jsonl`,
`runs/*/har/artifacts/.har/runs/**`, and the datasets' hidden fields. Writes
`results/ANALYSIS.md` and `results/analysis.jsonl`. Never re-runs an agent or a scorer.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.behaviors import classify  # noqa: E402
from lib.common import BENCHMARK_ROOT, benchmark_config, read_json, write_json  # noqa: E402
from lib.datasets import find_instance  # noqa: E402
from lib.patch import files_in_patch  # noqa: E402

ARMS = ("har", "raw", "raw_verify")
VERIFY_CMD_RE = re.compile(
    r"(har\s+env\s+verify|pytest|npm\s+(run\s+)?test|npm\s+run\s+(build|lint|typecheck)|node\s+test|"
    r"yarn\s+test|bun\s+run\s+test|npx\s+(jest|vitest|playwright|karma|mocha)|go\s+test|cargo\s+test|"
    r"mypy|ruff|flake8|eslint|tsc)"
)


# --------------------------------------------------------------------------- per-test outcomes


def test_outcomes(run_dir: Path, arm: str) -> dict[str, Any]:
    """FAIL_TO_PASS / PASS_TO_PASS detail from whichever scorer produced the result."""
    path = run_dir / "score" / arm / "score.summary.json"
    if not path.exists():
        return {}
    data = read_json(path)
    out: dict[str, Any] = {"scorer": data.get("scorer")}
    if data.get("scorer") == "swebench":
        report = (data.get("instance_report") or {})
        inner = next(iter(report.values()), {}) if report else {}
        status = inner.get("tests_status") or {}
        f2p = status.get("FAIL_TO_PASS") or {}
        p2p = status.get("PASS_TO_PASS") or {}
        out.update(
            {
                "f2p_passed": len(f2p.get("success") or []),
                "f2p_total": len(f2p.get("success") or []) + len(f2p.get("failure") or []),
                "p2p_regressed": len(p2p.get("failure") or []),
                "p2p_total": len(p2p.get("success") or []) + len(p2p.get("failure") or []),
                "patch_applied": inner.get("patch_successfully_applied"),
                "f2p_failures": (f2p.get("failure") or [])[:10],
            }
        )
    else:
        out.update(
            {
                "f2p_passed": len(data.get("fail_to_pass_passed") or []),
                "f2p_total": data.get("n_fail_to_pass"),
                "p2p_regressed": len(data.get("pass_to_pass_regressed") or []),
                "p2p_total": data.get("n_pass_to_pass"),
                "patch_applied": None if data.get("error") is None else ("apply failed" not in str(data.get("error"))),
                "f2p_failures": (data.get("fail_to_pass_missing") or [])[:10],
            }
        )
    return out


# --------------------------------------------------------------- verification, from HAR evidence


def har_stage_evidence(run_dir: Path) -> dict[str, Any]:
    """Which harness stages actually ran during the solve, from `.har/runs` records.

    The transcript only shows `har env verify`; the records show that the suite, lint and browser
    stages executed. Records written before the solve (the readiness gate) are excluded by
    timestamp when the solve start time is known.
    """
    runs_dir = run_dir / "har" / "artifacts" / ".har" / "runs"
    if not runs_dir.exists():
        return {}
    solve_started = None
    try:
        rec = read_json(run_dir / "run.json")
        solve_started = ((rec.get("arms") or {}).get("har") or {}).get("solve", {}).get("started_at")
    except Exception:
        pass
    stages: dict[str, dict[str, int]] = {}
    verify_records = 0
    for path in sorted(runs_dir.rglob("*.json")):
        try:
            data = read_json(path)
        except Exception:
            continue
        started = str(data.get("startedAt") or "")
        # Timestamps: records are ISO-8601 with milliseconds, run.json uses whole seconds.
        if solve_started and started and started[:19] < solve_started[:19]:
            continue  # readiness gate, not the agent's own run
        if data.get("stageId") != "verify":
            continue
        verify_records += 1
        result = data.get("result") or {}
        for step in result.get("stages") or []:
            if not isinstance(step, dict):
                continue
            name = step.get("name") or step.get("id") or "?"
            ok = bool(step.get("pass", step.get("ok")))
            entry = stages.setdefault(name, {"ran": 0, "passed": 0})
            entry["ran"] += 1
            entry["passed"] += 1 if ok else 0
    return {"verify_records_during_solve": verify_records, "stages": stages,
            "project_check_stages": sorted(n for n in stages if n not in {"api-health", "readiness", "smoke"})}


def verification_dynamics(transcript: Path) -> dict[str, Any]:
    """Did verification change the agent's behaviour? Counts checks and post-check edits."""
    if not transcript.exists():
        return {}
    order: list[str] = []
    for line in transcript.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("{") or '"tool_use"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "assistant":
            continue
        for block in (event.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if name == "Bash" and VERIFY_CMD_RE.search(str((block.get("input") or {}).get("command", ""))):
                order.append("check")
            elif name in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
                order.append("edit")
            elif name in {"Monitor", "TaskOutput", "AskUserQuestion"}:
                order.append("wait")
            else:
                order.append("other")
    # Idling at the end: HAR's AGENTS.md tells an agent to stop at a handoff and wait for a human,
    # which in an unattended run shows up as trailing waiting calls after the last real action.
    last_productive = max((i for i, k in enumerate(order) if k in {"edit", "check"}), default=-1)
    trailing_idle = sum(1 for k in order[last_productive + 1 :] if k == "wait")
    checks = order.count("check")
    edits_after_check = sum(1 for i, kind in enumerate(order) if kind == "edit" and "check" in order[:i])
    return {
        "checks": checks,
        "edits": order.count("edit"),
        "edits_after_first_check": edits_after_check,
        "check_edit_cycles": sum(1 for i in range(1, len(order)) if order[i] == "edit" and order[i - 1] == "check"),
        "ended_with_check": bool(order) and order[-1] == "check",
        "waiting_calls_after_last_action": trailing_idle,
        "waits": order.count("wait"),
        "handoff_idle": trailing_idle >= 1,
    }


# --------------------------------------------------------------------------- patch comparison


def _diff_lines(patch_text: str) -> set[str]:
    return {line[1:].strip() for line in (patch_text or "").splitlines() if line[:1] in "+-" and not line.startswith(("+++", "---"))}


def gold_comparison(run_dir: Path, arm: str, gold_patch: str | None) -> dict[str, Any]:
    path = run_dir / "predictions" / f"{arm}.patch"
    if not path.exists() or not gold_patch:
        return {}
    patch = path.read_text(encoding="utf-8")
    pf, gf = files_in_patch(patch), files_in_patch(gold_patch)
    pl, gl = _diff_lines(patch), _diff_lines(gold_patch)
    return {
        "file_overlap": round(len(pf & gf) / len(pf | gf), 3) if (pf | gf) else None,
        "line_overlap": round(len(pl & gl) / len(pl | gl), 3) if (pl | gl) else None,
        "files_in_gold_not_touched": sorted(gf - pf)[:8],
    }


def difficulty(gold_patch: str | None) -> dict[str, Any]:
    if not gold_patch:
        return {}
    files = {f for f in files_in_patch(gold_patch)}
    changed = sum(1 for line in gold_patch.splitlines() if line[:1] in "+-" and not line.startswith(("+++", "---")))
    return {"gold_files": len(files) // 2 or len(files), "gold_changed_lines": changed}


# --------------------------------------------------------------------------- failure taxonomy


def classify_failure(arm_rec: dict[str, Any], tests: dict[str, Any], score: dict[str, Any]) -> str:
    """First-pass automatic category. Ambiguous cases are meant to be adjudicated by hand."""
    if arm_rec.get("status") == "session_error":
        return "invalid: session error"
    if arm_rec.get("status") == "failed":
        return "invalid: harness gate failed"
    if (arm_rec.get("solve") or {}).get("timed_out"):
        return "timeout"
    if (arm_rec.get("patch") or {}).get("empty"):
        return "no patch produced"
    if score.get("skipped"):
        return f"not graded: {score.get('error')}"
    if tests.get("patch_applied") is False:
        return "patch did not apply"
    f2p_passed, f2p_total = tests.get("f2p_passed"), tests.get("f2p_total")
    if f2p_total and f2p_passed == f2p_total and tests.get("p2p_regressed"):
        return "regression only (target tests pass, other tests broke)"
    if f2p_total and f2p_passed and f2p_passed < f2p_total:
        return "partial: some target tests pass"
    if f2p_total and not f2p_passed:
        return "target tests fail"
    return "unclassified"


# --------------------------------------------------------------------------- paired statistics


def exact_mcnemar(b: int, c: int) -> float | None:
    """Two-sided exact McNemar (binomial) p-value for discordant pairs b and c."""
    n = b + c
    if n == 0:
        return None
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2**n)
    return min(1.0, 2 * tail)


def wilson(successes: int, total: int) -> tuple[float, float] | None:
    if not total:
        return None
    z = 1.96
    p = successes / total
    denom = 1 + z**2 / total
    centre = (p + z**2 / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z**2 / (4 * total**2)) / denom
    return round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)


# --------------------------------------------------------------------------- assembly


def collect(protocol: str) -> list[dict[str, Any]]:
    cfg = benchmark_config()
    rows: list[dict[str, Any]] = []
    for run_dir in sorted((BENCHMARK_ROOT / cfg.get("runs_dir", "runs")).glob("*/")):
        record_path = run_dir / "run.json"
        if not record_path.exists() or run_dir.name.startswith("INVALID"):
            continue
        try:
            record = read_json(record_path)
        except Exception:
            continue
        if record.get("protocol", "v1") != protocol or not record.get("arms"):
            continue
        try:
            instance = find_instance(record["dataset"], record["instance_id"])
        except Exception:
            continue
        gold = instance["hidden"].get("patch")
        evidence = har_stage_evidence(run_dir)
        for arm, arm_rec in record["arms"].items():
            score = (record.get("scores") or {}).get(arm) or {}
            tests = test_outcomes(run_dir, arm)
            transcript = Path((arm_rec.get("solve") or {}).get("transcript_path", ""))
            # Recompute from the transcript rather than trusting the stored dict: metrics were
            # added over time and the transcript is the source of truth.
            behaviour = classify(transcript) if transcript.exists() else (arm_rec.get("behaviour") or {})
            row = {
                "protocol": protocol,
                "run_id": record["run_id"],
                "dataset": record["dataset"],
                "repo": record["repo"],
                "instance_id": record["instance_id"],
                "arm": arm,
                "status": arm_rec.get("status"),
                "resolved": bool(score.get("resolved")),
                **{f"test_{k}": v for k, v in tests.items()},
                **{f"dyn_{k}": v for k, v in verification_dynamics(transcript).items()},
                **{f"gold_{k}": v for k, v in gold_comparison(run_dir, arm, gold).items()},
                **difficulty(gold),
                "failure_category": None if score.get("resolved") else classify_failure(arm_rec, tests, score),
                "behaviour": {k: behaviour.get(k) for k in ("provisioned_environment", "installed_deps", "started_services", "ran_tests", "ran_build_or_lint", "verified_anything", "committed", "har_launch", "har_verify", "har_verify_full")},
                "har_stage_evidence": evidence if arm == "har" else {},
                "cost_usd": ((arm_rec.get("solve") or {}).get("result") or {}).get("total_cost_usd"),
                "num_turns": ((arm_rec.get("solve") or {}).get("result") or {}).get("num_turns"),
                "wall_clock_seconds": (arm_rec.get("solve") or {}).get("wall_clock_seconds"),
            }
            rows.append(row)
    return rows


def effective_verification(row: dict[str, Any]) -> bool:
    """True when the project's own checks ran, whether typed directly or via the harness."""
    b = row.get("behaviour") or {}
    if b.get("ran_tests") or b.get("ran_build_or_lint"):
        return True
    return bool((row.get("har_stage_evidence") or {}).get("project_check_stages"))


def build_markdown(rows: list[dict[str, Any]], protocol: str) -> str:
    by_key = {(r["dataset"], r["instance_id"], r["arm"]): r for r in rows}
    datasets = sorted({r["dataset"] for r in rows})
    out = [
        f"# Analysis — protocol {protocol}",
        "",
        "Computed from stored artifacts only (`scripts/analyze.py`); no agent or scorer was re-run.",
        "Failure categories are an automatic first pass and still need adjudication for the",
        "'target tests fail' cases, which is where dataset specification ambiguity hides.",
        "",
    ]
    for ds in datasets:
        iids = sorted({r["instance_id"] for r in rows if r["dataset"] == ds})
        out += [f"## {ds}", "", "### Per instance", "",
                "| instance | gold files/lines | arm | resolved | F2P | P2P regressed | file overlap | line overlap | checks | idle tail | category |",
                "|---|---|---|---|---|---|---|---|---|---|---|"]
        for iid in iids:
            for arm in ARMS:
                r = by_key.get((ds, iid, arm))
                if not r:
                    continue
                f2p = f"{r.get('test_f2p_passed', '—')}/{r.get('test_f2p_total', '—')}"
                out.append(
                    f"| `{iid}` | {r.get('gold_files', '—')}/{r.get('gold_changed_lines', '—')} | {arm} | "
                    f"{'✅' if r['resolved'] else '❌'} | {f2p} | {r.get('test_p2p_regressed', '—')} | "
                    f"{r.get('gold_file_overlap', '—')} | {r.get('gold_line_overlap', '—')} | "
                    f"{r.get('dyn_checks', '—')} | {r.get('dyn_waiting_calls_after_last_action', '—')} | {r.get('failure_category') or '—'} |"
                )
        out.append("")
        # paired table
        pairs = [(by_key.get((ds, iid, "har")), by_key.get((ds, iid, "raw"))) for iid in iids]
        pairs = [(a, b) for a, b in pairs if a and b]
        both = sum(1 for a, b in pairs if a["resolved"] and b["resolved"])
        only_a = sum(1 for a, b in pairs if a["resolved"] and not b["resolved"])
        only_b = sum(1 for a, b in pairs if b["resolved"] and not a["resolved"])
        neither = sum(1 for a, b in pairs if not a["resolved"] and not b["resolved"])
        p = exact_mcnemar(only_a, only_b)
        a_res = sum(1 for a, _ in pairs if a["resolved"])
        b_res = sum(1 for _, b in pairs if b["resolved"])
        out += [
            "### Paired outcome (A = HAR, B = raw)",
            "",
            "| | B resolved | B unresolved |",
            "|---|---|---|",
            f"| **A resolved** | {both} | {only_a} |",
            f"| **A unresolved** | {only_b} | {neither} |",
            "",
            f"Pairs: {len(pairs)}. A {a_res}/{len(pairs)} (95% CI {wilson(a_res, len(pairs))}), "
            f"B {b_res}/{len(pairs)} (95% CI {wilson(b_res, len(pairs))}). "
            f"Exact McNemar on the {only_a + only_b} discordant pairs: "
            f"p = {'n/a (no discordant pairs)' if p is None else round(p, 4)}.",
            "",
        ]
        # behaviour, with the effective-verification correction
        out += ["### Behaviour", "", "| metric | " + " | ".join(ARMS) + " |", "|---|" + "---|" * len(ARMS)]
        keys = ["provisioned_environment", "installed_deps", "started_services", "ran_tests", "ran_build_or_lint", "verified_anything", "committed", "har_launch", "har_verify", "har_verify_full"]
        for key in keys:
            cells = []
            for arm in ARMS:
                vals = [r["behaviour"].get(key) for r in rows if r["dataset"] == ds and r["arm"] == arm and r["behaviour"]]
                vals = [v for v in vals if v is not None]
                cells.append(f"{sum(1 for v in vals if v)}/{len(vals)}" if vals else "—")
            out.append(f"| {key} | " + " | ".join(cells) + " |")
        cells = []
        for arm in ARMS:
            subset = [r for r in rows if r["dataset"] == ds and r["arm"] == arm]
            cells.append(f"{sum(1 for r in subset if effective_verification(r))}/{len(subset)}" if subset else "—")
        out += [f"| **project checks actually ran** (transcript or `.har/runs`) | " + " | ".join(cells) + " |", ""]
        # failure taxonomy
        cats: dict[str, dict[str, int]] = {}
        for r in rows:
            if r["dataset"] != ds or r["resolved"]:
                continue
            cats.setdefault(r["failure_category"] or "unclassified", {}).setdefault(r["arm"], 0)
            cats[r["failure_category"] or "unclassified"][r["arm"]] += 1
        if cats:
            out += ["### Unresolved, by first-pass category", "", "| category | " + " | ".join(ARMS) + " |", "|---|" + "---|" * len(ARMS)]
            for cat, per in sorted(cats.items()):
                out.append(f"| {cat} | " + " | ".join(str(per.get(arm, 0)) for arm in ARMS) + " |")
            out.append("")
    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", default="v2")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    rows = collect(args.protocol)
    results_dir = BENCHMARK_ROOT / benchmark_config().get("results_dir", "results")
    with (results_dir / "analysis.jsonl").open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, default=str) + "\n")
    md = build_markdown(rows, args.protocol)
    out = Path(args.out) if args.out else results_dir / "ANALYSIS.md"
    out.write_text(md, encoding="utf-8")
    print(md)
    print(f"wrote {out} and {results_dir / 'analysis.jsonl'} ({len(rows)} arm rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
