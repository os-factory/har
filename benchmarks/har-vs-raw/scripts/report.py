#!/usr/bin/env python3
"""Aggregate benchmark runs into comparison reports."""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, campaign_config, ensure_dir, load_harness_gate, read_json, write_json


def load_runs(runs_dir: Path) -> list[dict]:
    runs: list[dict] = []
    for run_json in sorted(runs_dir.glob("*/run.json")):
        run = read_json(run_json)
        eval_path = run_json.parent / "evaluation.json"
        if eval_path.exists():
            run["evaluation"] = read_json(eval_path)
        runs.append(run)
    return runs


def summarize_arm(runs: list[dict], arm: str) -> dict:
    arm_runs = [run for run in runs if run.get("arm") == arm]
    evals = [run.get("evaluation", {}).get("scores", {}) for run in arm_runs if run.get("evaluation")]

    def median(key: str) -> float:
        values = [float(item.get(key, 0) or 0) for item in evals if key in item]
        return statistics.median(values) if values else 0.0

    def mean(key: str) -> float:
        values = [float(item.get(key, 0) or 0) for item in evals if key in item]
        return statistics.mean(values) if values else 0.0

    return {
        "count": len(arm_runs),
        "oracle_pass_rate": mean("oracle_pass"),
        "success_rate": mean("success"),
        "verified_rate": mean("verified"),
        "median_patch_overlap": median("patch_overlap"),
        "median_wall_clock_seconds": median("wall_clock_seconds"),
        "median_cost_usd": median("cost_usd"),
        "median_tokens_total": median("tokens_total"),
        "median_verify_attempts": median("verify_attempts"),
        "median_failed_verify_attempts": median("failed_verify_attempts"),
    }


def paired_deltas(runs: list[dict]) -> list[dict]:
    by_issue: dict[str, dict[str, dict]] = {}
    for run in runs:
        key = f"{run['repo']}#{run['issue_number']}"
        by_issue.setdefault(key, {})[run["arm"]] = run
    deltas = []
    for key, arms in by_issue.items():
        if "raw" not in arms or "har" not in arms:
            continue
        raw_eval = arms["raw"].get("evaluation", {}).get("scores", {})
        har_eval = arms["har"].get("evaluation", {}).get("scores", {})
        deltas.append(
            {
                "issue": key,
                "raw_oracle_pass": raw_eval.get("oracle_pass", 0),
                "har_oracle_pass": har_eval.get("oracle_pass", 0),
                "raw_success": raw_eval.get("success", 0),
                "har_success": har_eval.get("success", 0),
                "raw_wall_clock_seconds": raw_eval.get("wall_clock_seconds", 0),
                "har_wall_clock_seconds": har_eval.get("wall_clock_seconds", 0),
                "delta_oracle_pass": float(har_eval.get("oracle_pass", 0)) - float(raw_eval.get("oracle_pass", 0)),
                "delta_wall_clock_seconds": float(har_eval.get("wall_clock_seconds", 0)) - float(raw_eval.get("wall_clock_seconds", 0)),
            }
        )
    return deltas


def amortized_setup() -> dict:
    gate = load_harness_gate()
    repos = gate.get("repos", {})
    total_seconds = sum(float(item.get("harness_setup_seconds") or 0) for item in repos.values())
    return {"repo_count": len(repos), "total_setup_seconds": total_seconds, "repos": repos}


def write_markdown(path: Path, summary: dict) -> None:
    lines = [
        "# HAR vs Raw Benchmark Report",
        "",
        "## Arm Summary",
        "",
        "| Arm | Runs | Oracle pass | Verified | Median wall (s) | Median cost ($) |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for arm, stats in summary["arms"].items():
        lines.append(
            f"| {arm} | {stats['count']} | {stats['oracle_pass_rate']:.2f} | {stats['verified_rate']:.2f} | "
            f"{stats['median_wall_clock_seconds']:.1f} | {stats['median_cost_usd']:.2f} |"
        )
    amort = summary.get("amortized_setup", {})
    if amort.get("repo_count"):
        lines.extend(
            [
                "",
                "## Amortized Harness Setup",
                "",
                f"Total one-time setup: {amort.get('total_setup_seconds', 0):.0f}s across {amort.get('repo_count', 0)} repos",
            ]
        )
    lines.extend(["", "## Paired Deltas", ""])
    for delta in summary["paired_deltas"]:
        lines.append(
            f"- {delta['issue']}: oracle delta {delta['delta_oracle_pass']:+.1f}, "
            f"wall clock delta {delta['delta_wall_clock_seconds']:+.1f}s"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_csv(path: Path, runs: list[dict]) -> None:
    rows = []
    for run in runs:
        scores = run.get("evaluation", {}).get("scores", {})
        rows.append(
            {
                "run_id": run.get("run_id"),
                "arm": run.get("arm"),
                "repo": run.get("repo"),
                "issue_number": run.get("issue_number"),
                **{f"score_{k}": v for k, v in scores.items()},
            }
        )
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", choices=["default", "v3"], default="default")
    parser.add_argument("--runs-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    cfg = campaign_config(args.campaign)
    runs_dir = args.runs_dir or BENCHMARK_ROOT / cfg.get("runs_dir", "runs")
    output_dir = args.output_dir or BENCHMARK_ROOT / cfg.get("results_dir", "results")
    runs = load_runs(runs_dir)
    summary = {
        "arms": {
            "raw": summarize_arm(runs, "raw"),
            "har": summarize_arm(runs, "har"),
        },
        "paired_deltas": paired_deltas(runs),
        "amortized_setup": amortized_setup(),
        "run_count": len(runs),
    }
    ensure_dir(output_dir)
    write_json(output_dir / "report.json", summary)
    write_csv(output_dir / "report.csv", runs)
    write_markdown(output_dir / "report.md", summary)
    print(f"Wrote report for {len(runs)} runs to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
