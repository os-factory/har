#!/usr/bin/env python3
"""Sample one SWE-bench Lite instance for the benchmark."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_config,
    evaluator_row,
    new_run_id,
    sanitize_instance_row,
    write_json,
)


from lib.dataset import load_split, pick_row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, help="Random seed for sampling")
    parser.add_argument("--instance-id", help="Pin a specific instance_id")
    parser.add_argument("--run-id", help="Optional run id (generated if omitted)")
    parser.add_argument("--dry-run", action="store_true", help="Print selection only")
    args = parser.parse_args()

    cfg = benchmark_config()
    rows = load_split(cfg["dataset_name"], cfg["split"])
    try:
        row = pick_row(rows, args.seed, args.instance_id)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    run_id = args.run_id or new_run_id(row["instance_id"])

    payload = {
        "run_id": run_id,
        "dataset_name": cfg["dataset_name"],
        "split": cfg["split"],
        "seed": args.seed,
        "instance_id": row["instance_id"],
        "repo": row["repo"],
        "base_commit": row["base_commit"],
        "problem_statement": row["problem_statement"],
        "version": row.get("version"),
        "agent_instance": sanitize_instance_row(row),
        "evaluator_only": evaluator_row(row),
    }

    if args.dry_run:
        print(
            {
                "run_id": run_id,
                "instance_id": row["instance_id"],
                "repo": row["repo"],
                "base_commit": row["base_commit"],
            }
        )
        return 0

    run_dir = BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / run_id
    write_json(run_dir / "instance.json", payload)
    print(run_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
