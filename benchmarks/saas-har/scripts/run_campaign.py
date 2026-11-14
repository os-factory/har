#!/usr/bin/env python3
"""Iterate the plan: repository by repository, oldest base_commit first, all arms per instance."""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, acquire_runner_lock, benchmark_config, free_gb, log_event, read_json, read_jsonl  # noqa: E402
from plan import build_plan  # noqa: E402
from run_instance import PROTOCOL, parse_arms, run_one  # noqa: E402


def already_done(rows: list[dict], dataset: str, instance_id: str, arms: list[str]) -> bool:
    """True when every requested arm already has a completed row under the current protocol."""
    seen = {
        r["arm"]
        for r in rows
        if r.get("dataset") == dataset
        and r.get("instance_id") == instance_id
        and r.get("status") == "completed"
        and r.get("protocol") == PROTOCOL
    }
    return set(arms).issubset(seen)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", help="existing plan.json (default: build from the filters below)")
    parser.add_argument("--datasets", nargs="*")
    parser.add_argument("--repos", nargs="*")
    parser.add_argument("--limit-per-repo", type=int)
    parser.add_argument("--instances", nargs="*", help="only these instance ids")
    parser.add_argument("--arm", choices=["har", "raw", "raw_verify", "both", "all"], default="both")
    parser.add_argument("--prompt-variant", choices=["minimal", "verify"], default="minimal")
    parser.add_argument("--skip-score", action="store_true")
    parser.add_argument("--gold-first", action="store_true", help="score the gold patch of each repo's first instance")
    parser.add_argument("--resume", action="store_true", help="skip instances already completed under this protocol")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-instances", type=int)
    args = parser.parse_args()
    if not args.dry_run:
        acquire_runner_lock()

    cfg = benchmark_config()
    arms = parse_arms(args.arm)
    plan = read_json(Path(args.plan)) if args.plan else build_plan(args.datasets, args.repos, args.limit_per_repo)
    rows = read_jsonl(BENCHMARK_ROOT / cfg.get("results_dir", "results") / "results.jsonl") if args.resume else []
    log_event("campaign.start", protocol=PROTOCOL, arms=",".join(arms), datasets=[d["dataset"] for d in plan["datasets"]], variant=args.prompt_variant, dry_run=args.dry_run)

    done = 0
    for ds in plan["datasets"]:
        for repo_entry in ds["repos"]:
            instances = repo_entry["instances"]
            for idx, inst in enumerate(instances):
                if args.instances and inst["instance_id"] not in args.instances:
                    continue
                if args.max_instances and done >= args.max_instances:
                    break
                if args.resume and already_done(rows, ds["dataset"], inst["instance_id"], arms):
                    log_event("campaign.skip", instance=inst["instance_id"], reason="already completed under this protocol")
                    continue
                free = free_gb()
                if free < float(cfg.get("min_free_gb", 8)):
                    log_event("campaign.stopped", reason="low disk", free_gb=round(free, 1), instance=inst["instance_id"])
                    log_event("campaign.done", instances=done)
                    return 0
                last_in_repo = idx == len(instances) - 1
                try:
                    record = run_one(
                        ds["dataset"],
                        inst["instance_id"],
                        arms=arms,
                        skip_score=args.skip_score,
                        gold=bool(args.gold_first and idx == 0),
                        dry_run=args.dry_run,
                        infra_down_after=last_in_repo,
                        variant=args.prompt_variant,
                    )
                    print(json.dumps({"instance": inst["instance_id"], "run_id": record["run_id"], "scores": {a: s.get("resolved") for a, s in record.get("scores", {}).items()}}))
                except Exception as exc:  # keep the campaign going, record the crash
                    log_event("campaign.error", instance=inst["instance_id"], repo=repo_entry["repo"], error=str(exc)[:500], detail=traceback.format_exc()[-3000:])
                done += 1
    log_event("campaign.done", instances=done)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
