#!/usr/bin/env python3
"""Evaluate benchmark predictions with the official SWE-bench harness."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, ensure_dir, read_json, write_json


def latest_run_dir() -> Path:
    runs_dir = BENCHMARK_ROOT / benchmark_config().get("runs_dir", "runs")
    candidates = [path for path in runs_dir.iterdir() if path.is_dir()]
    if not candidates:
        raise SystemExit("No runs found")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def evaluate_one(
    predictions_path: Path,
    instance_id: str,
    run_id: str,
    arm: str,
    *,
    max_workers: int,
    dry_run: bool,
) -> dict:
    cfg = benchmark_config()
    eval_run_id = f"{run_id}-{arm}"
    result_dir = ensure_dir(BENCHMARK_ROOT / cfg.get("results_dir", "results") / run_id)
    report = {
        "arm": arm,
        "predictions_path": str(predictions_path),
        "instance_id": instance_id,
        "eval_run_id": eval_run_id,
        "dataset_name": cfg["dataset_name"],
        "split": cfg["split"],
    }

    if dry_run:
        report["status"] = "dry-run"
        write_json(result_dir / f"evaluation-{arm}.json", report)
        return report

    if not predictions_path.exists():
        report["status"] = "missing_predictions"
        write_json(result_dir / f"evaluation-{arm}.json", report)
        return report

    cmd = [
        sys.executable,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        cfg["dataset_name"],
        "--split",
        cfg["split"],
        "--predictions_path",
        str(predictions_path),
        "--max_workers",
        str(max_workers),
        "--run_id",
        eval_run_id,
        "--instance_ids",
        instance_id,
    ]
    proc = subprocess.run(cmd, cwd=BENCHMARK_ROOT, capture_output=True, text=True, check=False)
    report.update(
        {
            "status": "completed" if proc.returncode == 0 else "failed",
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-12000:],
            "stderr": proc.stderr[-12000:],
        }
    )
    write_json(result_dir / f"evaluation-{arm}.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", help="Benchmark run id (defaults to latest)")
    parser.add_argument("--latest", action="store_true", help="Use latest run directory")
    parser.add_argument("--arm", choices=["raw", "har", "both"], default="both")
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_id = args.run_id
    if args.latest or not run_id:
        run_dir = latest_run_dir()
        run_id = run_dir.name
    else:
        run_dir = BENCHMARK_ROOT / benchmark_config().get("runs_dir", "runs") / run_id

    instance = read_json(run_dir / "instance.json")
    instance_id = instance["instance_id"]
    arms = ["raw", "har"] if args.arm == "both" else [args.arm]
    summary = {"run_id": run_id, "evaluations": []}

    for arm in arms:
        pred = run_dir / "predictions" / f"{arm}.jsonl"
        summary["evaluations"].append(
            evaluate_one(
                pred,
                instance_id,
                run_id,
                arm,
                max_workers=args.max_workers,
                dry_run=args.dry_run,
            )
        )

    write_json(BENCHMARK_ROOT / benchmark_config().get("results_dir", "results") / run_id / "evaluation-summary.json", summary)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
