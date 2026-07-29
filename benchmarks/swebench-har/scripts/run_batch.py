#!/usr/bin/env python3
"""Run multiple SWE-bench Lite instances (raw and/or HAR arms)."""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import (  # noqa: E402
    BENCHMARK_ROOT,
    benchmark_config,
    load_benchmark_env,
    now_iso,
    write_json,
)
from lib.dataset import load_split, sample_rows
from run_one import run_har_arm, run_raw_arm  # noqa: E402


def prepare_instance_row(row: dict[str, Any], seed: int | None) -> tuple[dict[str, Any], Path]:
    from lib.common import evaluator_row, new_run_id, sanitize_instance_row
    from lib.common import ensure_dir

    run_id = new_run_id(row["instance_id"])
    cfg = benchmark_config()
    run_dir = ensure_dir(BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / run_id)
    payload = {
        "run_id": run_id,
        "dataset_name": cfg["dataset_name"],
        "split": cfg["split"],
        "seed": seed,
        "instance_id": row["instance_id"],
        "repo": row["repo"],
        "base_commit": row["base_commit"],
        "problem_statement": row["problem_statement"],
        "version": row.get("version"),
        "agent_instance": sanitize_instance_row(row),
        "evaluator_only": evaluator_row(row),
    }
    write_json(run_dir / "instance.json", payload)
    return payload, run_dir


def run_one_instance(
    row: dict[str, Any],
    *,
    seed: int | None,
    model: str,
    setup_model: str,
    env: dict[str, str],
    arm: str,
    dry_run: bool,
    setup_timeout_minutes: int,
    readiness_timeout_minutes: int,
    solve_timeout_minutes: int,
    post_fix_verify_full: bool,
    setup_budget_minutes: int,
    setup_max_rounds: int,
    fix_max_rounds: int = 3,
) -> dict[str, Any]:
    instance, run_dir = prepare_instance_row(row, seed)
    record: dict[str, Any] = {
        "run_id": instance["run_id"],
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "base_commit": instance["base_commit"],
        "model": model,
        "setup_model": setup_model,
        "started_at": now_iso(),
        "dry_run": dry_run,
        "arms": {},
    }

    if arm in {"raw", "both"}:
        record["arms"]["raw"] = run_raw_arm(
            instance,
            run_dir,
            model=model,
            env=env,
            dry_run=dry_run,
            timeout_minutes=solve_timeout_minutes,
        )

    if arm in {"har", "both"}:
        record["arms"]["har"] = run_har_arm(
            instance,
            run_dir,
            model=model,
            setup_model=setup_model,
            env=env,
            dry_run=dry_run,
            setup_timeout_minutes=setup_timeout_minutes,
            readiness_timeout_minutes=readiness_timeout_minutes,
            solve_timeout_minutes=solve_timeout_minutes,
            post_fix_verify_full=post_fix_verify_full,
            setup_budget_minutes=setup_budget_minutes,
            setup_max_rounds=setup_max_rounds,
            fix_max_rounds=fix_max_rounds,
        )

    record["finished_at"] = now_iso()
    write_json(run_dir / "run.json", record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=10, help="Number of instances to run")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for sampling instances")
    parser.add_argument("--model", help="Codex model for raw/fix arms")
    parser.add_argument("--setup-model", help="Codex model for HAR setup")
    parser.add_argument("--arm", choices=["raw", "har", "both"], default="both")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--solve-timeout-minutes", type=int)
    parser.add_argument("--setup-timeout-minutes", type=int)
    args = parser.parse_args()

    cfg = benchmark_config()
    env = load_benchmark_env()
    model = args.model or env.get("OPENAI_MODEL") or cfg.get("model", "gpt-5-mini")
    setup_model = args.setup_model or env.get("OPENAI_SETUP_MODEL") or cfg.get("setup_model", "gpt-5.5")
    solve_timeout = args.solve_timeout_minutes or int(cfg.get("solve_timeout_minutes", 60))
    setup_timeout = args.setup_timeout_minutes or int(cfg.get("setup_timeout_minutes", 45))
    readiness_timeout = int(cfg.get("readiness_timeout_minutes", 20))
    setup_budget = int(cfg.get("setup_budget_minutes", 120))
    setup_max_rounds = int(cfg.get("setup_max_rounds", 6))
    fix_max_rounds = int(cfg.get("fix_max_rounds", 3))
    post_fix_verify_full = bool(cfg.get("har_verify_full", False))

    rows = load_split(cfg["dataset_name"], cfg["split"])
    selected = sample_rows(rows, args.count, args.seed)

    batch_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    batch_dir = BENCHMARK_ROOT / "batches" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    batch_record: dict[str, Any] = {
        "batch_id": batch_id,
        "count": args.count,
        "seed": args.seed,
        "arm": args.arm,
        "model": model,
        "setup_model": setup_model,
        "started_at": now_iso(),
        "instances": [],
    }

    print(f"Batch {batch_id}: running {args.count} instances (seed={args.seed}, arm={args.arm})")
    for index, row in enumerate(selected, start=1):
        instance_id = row["instance_id"]
        print(f"[{index}/{args.count}] {instance_id} ...", flush=True)
        entry: dict[str, Any] = {
            "index": index,
            "instance_id": instance_id,
            "repo": row["repo"],
            "started_at": now_iso(),
        }
        try:
            result = run_one_instance(
                row,
                seed=args.seed,
                model=model,
                setup_model=setup_model,
                env=env,
                arm=args.arm,
                dry_run=args.dry_run,
                setup_timeout_minutes=setup_timeout,
                readiness_timeout_minutes=readiness_timeout,
                solve_timeout_minutes=solve_timeout,
                post_fix_verify_full=post_fix_verify_full,
                setup_budget_minutes=setup_budget,
                setup_max_rounds=setup_max_rounds,
                fix_max_rounds=fix_max_rounds,
            )
            entry["run_id"] = result["run_id"]
            entry["status"] = "completed"
            entry["arms"] = {
                name: arm.get("status")
                for name, arm in result.get("arms", {}).items()
            }
        except Exception as exc:  # noqa: BLE001
            entry["status"] = "error"
            entry["error"] = str(exc)
            entry["traceback"] = traceback.format_exc()
            print(f"  ERROR: {exc}", flush=True)
        entry["finished_at"] = now_iso()
        batch_record["instances"].append(entry)
        write_json(batch_dir / "batch.json", batch_record)

    batch_record["finished_at"] = now_iso()
    write_json(batch_dir / "batch.json", batch_record)
    print(json.dumps({"batch_id": batch_id, "batch_dir": str(batch_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
