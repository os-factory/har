#!/usr/bin/env python3
"""Build the campaign plan: per dataset, per repository, instances ordered oldest base_commit first."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, write_json  # noqa: E402
from lib.datasets import group_by_repo, load_instances, order_by_commit_date  # noqa: E402


def build_plan(datasets: list[str] | None, repos: list[str] | None, limit_per_repo: int | None) -> dict:
    cfg = benchmark_config()
    keys = datasets or list(cfg["datasets"].keys())
    plan: dict = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "datasets": []}
    for key in keys:
        instances = load_instances(key)
        groups = group_by_repo(instances)
        entry = {"dataset": key, "kind": cfg["datasets"][key]["kind"], "repos": []}
        for repo, items in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if repos and repo not in repos:
                continue
            ordered = order_by_commit_date(items)
            if limit_per_repo:
                ordered = ordered[:limit_per_repo]
            entry["repos"].append(
                {
                    "repo": repo,
                    "count_total": len(items),
                    "count_planned": len(ordered),
                    "instances": [
                        {
                            "order": i + 1,
                            "instance_id": inst["instance_id"],
                            "base_commit": inst["base_commit"],
                            "base_commit_ts": inst.get("base_commit_ts"),
                            "base_commit_date": time.strftime("%Y-%m-%d", time.gmtime(inst["base_commit_ts"])) if inst.get("base_commit_ts") else None,
                            "created_at": inst.get("created_at"),
                        }
                        for i, inst in enumerate(ordered)
                    ],
                }
            )
        plan["datasets"].append(entry)
    return plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--datasets", nargs="*", help="dataset keys from config.yaml (default: all)")
    parser.add_argument("--repos", nargs="*", help="restrict to these owner/name repos")
    parser.add_argument("--limit-per-repo", type=int)
    parser.add_argument("--out", default=None, help="plan path (default results/plan.json)")
    args = parser.parse_args()
    plan = build_plan(args.datasets, args.repos, args.limit_per_repo)
    out = Path(args.out) if args.out else BENCHMARK_ROOT / benchmark_config().get("results_dir", "results") / "plan.json"
    write_json(out, plan)
    for ds in plan["datasets"]:
        print(f"== {ds['dataset']} ({ds['kind']})")
        for repo in ds["repos"]:
            print(f"  {repo['repo']}: {repo['count_planned']}/{repo['count_total']} instances")
            for inst in repo["instances"][:5]:
                print(f"    {inst['order']:>3}. {inst['instance_id']}  base@{inst['base_commit_date']}  pr@{inst['created_at']}")
            if repo["count_planned"] > 5:
                print(f"    ... {repo['count_planned'] - 5} more")
    print(json.dumps({"plan": str(out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
