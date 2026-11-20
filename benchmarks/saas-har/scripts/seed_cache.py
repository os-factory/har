#!/usr/bin/env python3
"""Seed the per-repo harness cache from an existing run's harness checkout (runs/<id>/har/repo)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from lib.common import BENCHMARK_ROOT, benchmark_config, log_event, read_json  # noqa: E402
from lib.har_cache import save_cache  # noqa: E402
from lib.har_utils import read_profile  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--note", default="seeded manually from a partial run")
    args = parser.parse_args()
    cfg = benchmark_config()
    run_dir = BENCHMARK_ROOT / cfg.get("runs_dir", "runs") / args.run_id
    record = read_json(run_dir / "run.json") if (run_dir / "run.json").exists() else read_json(run_dir / "instance.json")
    repo = record["repo"]
    base = record["base_commit"]
    harness_root = run_dir / "har" / "repo"
    meta = save_cache(
        repo,
        harness_root,
        base,
        instance_id=record["instance_id"],
        profile=read_profile(harness_root),
        event={"seeded_from_run": args.run_id, "note": args.note, "ready": False},
    )
    log_event("har.cache.seed", run_id=args.run_id, repo=repo, files=len(meta["files"]), foreign=len(meta["foreign_files_at_save"]))
    print(meta["files"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
