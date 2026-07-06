#!/usr/bin/env python3
"""Aggregate benchmark runs into comparison reports."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, ensure_dir, read_json, write_json


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

    return {
        "count": len(arm_runs),
        "success_rate": statistics.mean([float(item.get("success", 0)) for item in evals]) if evals else 0.0,
        "verified_rate": statistics.mean([float(item.get("verified", 0)) for item in evals]) if evals else 0.0,
        "median_wall_clock_seconds": median("wall_clock_seconds"),
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
                "raw_success": raw_eval.get("success", 0),
                "har_success": har_eval.get("success", 0),
                "raw_wall_clock_seconds": raw_eval.get("wall_clock_seconds", 0),
                "har_wall_clock_seconds": har_eval.get("wall_clock_seconds", 0),
                "delta_wall_clock_seconds": float(har_eval.get("wall_clock_seconds", 0)) - float(raw_eval.get("wall_clock_seconds", 0)),
                "delta_success": float(har_eval.get("success", 0)) - float(raw_eval.get("success", 0)),
            }
        )
    return deltas


def write_markdown(path: Path, summary: dict) -> None:
    lines = [
        "# HAR vs Raw Benchmark Report",
        "",
        "## Arm Summary",
        "",
        "| Arm | Runs | Success rate | Verified rate | Median wall clock (s) | Median verify attempts |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for arm, stats in summary["arms"].items():
        lines.append(
            f"| {arm} | {stats['count']} | {stats['success_rate']:.2f} | {stats['verified_rate']:.2f} | {stats['median_wall_clock_seconds']:.1f} | {stats['median_verify_attempts']:.1f} |"
        )
    lines.extend(["", "## Paired Deltas", ""])
    for delta in summary["paired_deltas"]:
        lines.append(
            f"- {delta['issue']}: success delta {delta['delta_success']:+.1f}, wall clock delta {delta['delta_wall_clock_seconds']:+.1f}s"
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
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-dir", type=Path, default=BENCHMARK_ROOT / benchmark_config().get("runs_dir", "runs"))
    parser.add_argument("--output-dir", type=Path, default=BENCHMARK_ROOT / benchmark_config().get("results_dir", "results"))
    args = parser.parse_args()

    runs = load_runs(args.runs_dir)
    summary = {
        "arms": {
            "raw": summarize_arm(runs, "raw"),
            "har": summarize_arm(runs, "har"),
        },
        "paired_deltas": paired_deltas(runs),
        "run_count": len(runs),
    }
    ensure_dir(args.output_dir)
    write_json(args.output_dir / "report.json", summary)
    write_csv(args.output_dir / "report.csv", runs)
    write_markdown(args.output_dir / "report.md", summary)
    print(f"Wrote report for {len(runs)} runs to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
