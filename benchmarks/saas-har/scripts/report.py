#!/usr/bin/env python3
"""Aggregate results/results.jsonl into results/REPORT.md: outcomes, cost, and measured behaviour."""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, read_jsonl  # noqa: E402

ARMS = [("har", "A (HAR)"), ("raw", "B (raw)"), ("raw_verify", "B' (raw+verify)")]
BEHAVIOURS = [
    ("provisioned_environment", "got a working environment (any way)"),
    ("installed_deps", "typed an install command itself"),
    ("started_services", "started services itself"),
    ("ran_tests", "ran tests"),
    ("ran_build_or_lint", "ran build/lint"),
    ("verified_anything", "verified anything"),
    ("committed", "committed"),
    ("har_launch", "har env launch"),
    ("har_verify", "har env verify"),
    ("har_verify_full", "verify --full"),
    ("read_harness_docs", "read AGENTS.md/.har docs"),
]


def fmt(value, kind="s"):
    if value is None:
        return "—"
    if kind == "usd":
        return f"${value:.2f}"
    if kind == "min":
        return f"{value / 60:.1f}m"
    if kind == "bool":
        return "✅" if value else "❌"
    return str(value)


def rate(rows: list[dict], key: str) -> str:
    vals = [r.get(key) for r in rows if r.get(key) is not None]
    if not vals:
        return "—"
    return f"{sum(1 for v in vals if v)}/{len(vals)}"


def latest(rows: list[dict]) -> dict[tuple, dict]:
    out: dict[tuple, dict] = {}
    for row in rows:
        out[(row.get("protocol", "v1"), row["dataset"], row["instance_id"], row["arm"])] = row
    return out


def build_report(rows: list[dict]) -> str:
    index = latest(rows)
    protocols = sorted({k[0] for k in index}, reverse=True)
    lines = [
        "# SaaS/HAR paired benchmark — results",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())} from `results/results.jsonl` "
        f"({len(rows)} rows, {len(index)} latest arm results).",
        "",
        "Protocol v2 gives every arm one byte-identical minimal prompt and pre-launches nothing, so the "
        "behaviour columns are outcomes, not instructions. Protocol v1 rows told each arm how to verify and "
        "handed ARM A a launched slot; the two protocols are reported separately and must not be pooled.",
        "",
    ]
    for protocol in protocols:
        lines += [f"# Protocol {protocol}", ""]
        datasets = sorted({k[1] for k in index if k[0] == protocol})
        for ds in datasets:
            iids = sorted(
                {k[2] for k in index if k[0] == protocol and k[1] == ds},
                key=lambda iid: next(
                    (index[k].get("base_commit_ts") or 0 for k in index if k[0] == protocol and k[1] == ds and k[2] == iid),
                    0,
                ),
            )
            lines += [
                f"## {ds}",
                "",
                "| # | instance | base date | harness setup | A | B | B' | A cost | B cost | A turns | B turns | A patch src |",
                "|---|---|---|---|---|---|---|---|---|---|---|---|",
            ]
            per_arm: dict[str, list[dict]] = {a: [] for a, _ in ARMS}
            setup_cost = []
            setup_time = []
            cache_hits = gate_unchanged = 0
            for i, iid in enumerate(iids, 1):
                got = {a: index.get((protocol, ds, iid, a)) for a, _ in ARMS}
                for a, r in got.items():
                    if r:
                        per_arm[a].append(r)
                a = got["har"] or {}
                b = got["raw"] or {}
                bp = got["raw_verify"] or {}
                ref = a or b or bp
                base_date = time.strftime("%Y-%m-%d", time.gmtime(ref["base_commit_ts"])) if ref.get("base_commit_ts") else "—"
                if a:
                    if a.get("har_setup_cost_usd") is not None:
                        setup_cost.append(a["har_setup_cost_usd"])
                    if a.get("har_setup_seconds") is not None:
                        setup_time.append(a["har_setup_seconds"])
                    if a.get("har_cache_hit"):
                        cache_hits += 1
                        gate_unchanged += 1 if a.get("har_gate_on_cache_ready") else 0
                setup = "—"
                if a:
                    kind = "cache" if a.get("har_cache_hit") else "fresh"
                    rounds = (a.get("har_adapt_rounds") or 0) + (a.get("har_drift_rounds") or 0)
                    setup = f"{kind}, {rounds}r, {fmt(a.get('har_setup_cost_usd'), 'usd')}"
                lines.append(
                    f"| {i} | `{iid}` | {base_date} | {setup} | {fmt(a.get('resolved'), 'bool') if a else '—'} | "
                    f"{fmt(b.get('resolved'), 'bool') if b else '—'} | {fmt(bp.get('resolved'), 'bool') if bp else '—'} | "
                    f"{fmt(a.get('cost_usd'), 'usd') if a else '—'} | {fmt(b.get('cost_usd'), 'usd') if b else '—'} | "
                    f"{a.get('num_turns', '—') if a else '—'} | {b.get('num_turns', '—') if b else '—'} | "
                    f"{(a.get('patch_source') or '—') if a else '—'} |"
                )
            lines += ["", "**Outcomes and cost**", "", "| metric | " + " | ".join(label for _, label in ARMS) + " |", "|---|" + "---|" * len(ARMS)]
            lines.append("| resolved | " + " | ".join(rate(per_arm[a], "resolved") for a, _ in ARMS) + " |")
            for label, key, kind in (("mean solve cost", "cost_usd", "usd"), ("mean solve time", "wall_clock_seconds", "min")):
                cells = []
                for a, _ in ARMS:
                    vals = [r[key] for r in per_arm[a] if r.get(key) is not None]
                    cells.append(fmt(statistics.mean(vals), kind) if vals else "—")
                lines.append(f"| {label} | " + " | ".join(cells) + " |")
            lines.append("| empty patch | " + " | ".join(rate(per_arm[a], "patch_empty") for a, _ in ARMS) + " |")
            lines += [
                "",
                f"Harness setup total: {fmt(sum(setup_cost), 'usd') if setup_cost else '—'} / "
                f"{fmt(sum(setup_time), 'min') if setup_time else '—'}; cache hits {cache_hits}, of which "
                f"{gate_unchanged} passed the gate unchanged.",
                "",
                "**Measured behaviour** (nothing in the prompt asks for any of it)",
                "",
                "| behaviour | " + " | ".join(label for _, label in ARMS) + " |",
                "|---|" + "---|" * len(ARMS),
            ]
            for key, label in BEHAVIOURS:
                lines.append(f"| {label} | " + " | ".join(rate(per_arm[a], key) for a, _ in ARMS) + " |")
            lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    results_dir = BENCHMARK_ROOT / benchmark_config().get("results_dir", "results")
    report = build_report(read_jsonl(results_dir / "results.jsonl"))
    out = Path(args.out) if args.out else results_dir / "REPORT.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(report)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
